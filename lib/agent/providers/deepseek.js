import { LlamaCppStreamHandler } from "../../streaming/llamacppHandler.js";
import { ToolExecutor, countTrailingRepeatedToolCalls, resolveTurnStepLimit, TOOL_REPEAT_LIMIT, TOOL_REPEAT_NUDGE, TURN_STEP_NUDGE } from "../../tools/executor.js";
import { estimateMsgTokens, trimByTokens, dropOrphanedToolResults, makeContextSignals, ctxPct, capToolResults } from "../../context/trim.js";
import { redactMessages } from "../../helpers/redactSecrets.js";
import logger from "../../helpers/logger.js";
import { zodToJsonSchema } from "../../providers/schema.js";
import { bridgeImagesToVLM } from "../../helpers/imageBridge.js";

const MAX_HISTORY = 20;
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
const FETCH_TIMEOUT = parseInt(process.env.DEEPSEEK_FETCH_TIMEOUT_MS || "300000", 10);
// DeepSeek caps each image at ~5MB; base64 inflates raw bytes by ~4/3.
const IMAGE_MAX_B64 = Math.floor(5 * 1024 * 1024 * 4 / 3);

async function makeDeepSeekRequest(provider, tools, openaiMessages, noTools, setAbort, thinkingMode = null) {
  const controller = new AbortController(); setAbort(controller);
  const timeoutController = new AbortController(); const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`${provider.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model: provider.model, messages: openaiMessages, stream_options: { include_usage: true }, ...(thinkingMode ? { thinking_mode: thinkingMode } : {}), ...(noTools ? {} : { tools }), stream: true }),
      signal: AbortSignal.any([controller.signal, timeoutController.signal]),
    });
    clearTimeout(timeoutId); return response;
  } catch (e) { clearTimeout(timeoutId); if (timeoutController.signal.aborted) e.isTimeout = true; throw e; }
}

function stripImages(openaiMessages) {
  return openaiMessages.map(m => {
    if (!Array.isArray(m.content)) return m;
    const textOnly = m.content.filter(b => b.type !== "image_url" && b.type !== "image");
    return { ...m, content: textOnly.length === 1 && textOnly[0]?.type === "text" ? textOnly[0].text : (textOnly.length ? textOnly : m.content[0]?.text ?? "") };
  });
}

function isImageError(body) {
  try { const msg = JSON.parse(body)?.error?.message ?? ""; return msg.includes("image_url") || (msg.includes("unknown variant") && msg.includes("image")); } catch { return false; }
}

function toOpenAIMessages(messages, systemPrompt, vision) {
  return [{ role: "system", content: systemPrompt }, ...messages.flatMap(m => {
    if (Array.isArray(m.content) && m.content[0]?.type === "tool_result") {
      const out = [];
      for (const tr of m.content) {
        const text = Array.isArray(tr.content) ? tr.content.filter(b => b.type === "text").map(b => b.text).join("") : (typeof tr.content === "string" ? tr.content : "");
        // DeepSeek rejects image_url in user messages that follow tool exchanges;
        // images from tool results are described in text only.
        const hasImage = Array.isArray(tr.content) && tr.content.some(b => b.type === "image");
        out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: text || (hasImage ? "[image processed]" : "No result") });
      }
      return out;
    }
    if (Array.isArray(m.content)) {
      const text = m.content.filter(b => b.type === "text").map(b => b.text).join("");
      // DeepSeek only accepts image_url parts in user messages (the schema for
      // assistant/system/tool roles allows `text` only) and caps each image at
      // ~5MB of base64. Drop anything that violates either rule.
      const images = (vision === false || m.role !== "user") ? [] : m.content
        .filter(b => b.type === "image" && b.source?.data)
        .filter(b => { const ok = b.source.data.length <= IMAGE_MAX_B64; if (!ok) logger.warn(`[deepseek] skipping oversized image (~${Math.round(b.source.data.length / 1.37 / 1024 / 1024)}MB > 5MB)`); return ok; })
        .map(b => ({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }));
      const tcs = m.content.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      // Always emit a string (never null) so vendors that reject `content:
      // null` on tool-only turns don't 400. See llamacpp.js for the same fix.
      const content = images.length > 0 ? [{ type: "text", text: text || "" }, ...images] : (text || "");
      // DeepSeek v4 requires reasoning_content on every assistant message with
      // tool_calls — even synthetic ones from auto-batch preflight. Emit an
      // empty string when the conversation has none so the API doesn't reject.
      const hasRC = !!m.reasoning_content;
      const rcBlock = hasRC ? { reasoning_content: m.reasoning_content } : (tcs.length ? { reasoning_content: "" } : {});
      return [{ role: m.role, content, ...(tcs.length ? { tool_calls: tcs } : {}), ...rcBlock }];
    }
    return [{ role: m.role, content: m.content ?? "", ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) }];
  })];
}

export async function runDeepSeekLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}, ctx) {
  const { provider, callTool, getSystemPrompt, getOpenAiTools, prepareModelContext, reasoningAdapter, state } = ctx;

  // ── DeepSeek image handling ──────────────────────────────────────────────
  // Vision-capable models (deepseek-v4-pro) see images natively, so user image
  // blocks are sent directly as image_url content (see toOpenAIMessages). For
  // text-only models, describe each uploaded image via the local llama.cpp VLM and
  // replace the raw image blocks with the resulting text before the first call.
  if (!provider.vision) {
    await bridgeImagesToVLM(messages, callTool, emitter);
  }

  let tokenHWM = 0;
  let streamUsage = zeroUsage();
  const ctxSignals = makeContextSignals();
  // wsHandler nulls out its abortController closure the instant it processes
  // a "stop" message, so getAbort() can no longer see it once that happens —
  // a Stop pressed while we're awaiting prepareModelContext/callTool (i.e.
  // between model requests, with no fetch currently listening on the signal)
  // would otherwise be silently lost and a follow-up request would fire
  // anyway. Latch our own copy the moment the registered controller is
  // aborted, independent of wsHandler forgetting its reference (mirrors
  // anthropic.js/gemini.js).
  let cancelled = false;
  // Set once by the tool-repeat breaker or the step cap below; never cleared, so
  // the turn gets exactly one tool-free pass and then ends whatever the model
  // does with it.
  let forceAnswerOnly = false;
  // Which nudge that tool-free pass carries — they explain different reasons.
  let answerOnlyNudge = TOOL_REPEAT_NUDGE;
  // Tool-calling passes made in this turn, against the per-turn cap.
  let toolSteps = 0;
  const turnStepLimit = resolveTurnStepLimit();
  while (true) {
    tokenHWM = Math.max(tokenHWM, streamUsage.input_tokens);
    streamUsage = zeroUsage();
    if (cancelled || getAbort()?.signal?.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => { cancelled = true; });
    setAbort(controller);
    let trimmed, systemPrompt, deepseekTools;
    if (prepareModelContext) {
      const prepared = await prepareModelContext({
        messages,
        observedInputTokens: tokenHWM,
        lang: opts.lang,
        extraSystem: opts.extraSystem,
        providerLabel: "deepseek",
      });
      trimmed = prepared.messages;
      systemPrompt = prepared.systemPrompt;
      deepseekTools = prepared.tools.map(tool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: zodToJsonSchema(tool.inputSchema),
        },
      }));
    } else {
      const capped = capToolResults(messages, provider.contextWindow);
      const hwm = tokenHWM > 0 ? tokenHWM : capped.reduce((s, m) => s + estimateMsgTokens(m), 0);
      const pct = ctxPct(hwm, provider.contextWindow);
      ctxSignals.emit(emitter, hwm, provider.contextWindow);
      const { messages: rawMessages, dropped } = trimByTokens(capped, hwm, provider.contextWindow);
      const safeRaw = dropped === 0 && rawMessages.length > MAX_HISTORY ? [rawMessages[0], ...rawMessages.slice(-(MAX_HISTORY - 1))] : rawMessages;
      if (dropped > 0) { logger.info(`[agent] deepseek context trimmed: dropped ${dropped} messages at ${pct}% pressure`); emitter.send({ type: "context_trimmed", dropped, pct }); }
      trimmed = dropOrphanedToolResults(safeRaw);
      const lastUserMsg = [...trimmed].reverse().find(m =>
        m.role === "user" && (typeof m.content === "string" || (Array.isArray(m.content) && m.content.some(b => b.type === "text")))
      );
      const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
      systemPrompt = getSystemPrompt(lastUserText, opts.lang, opts.extraSystem, trimmed);
      deepseekTools = getOpenAiTools(lastUserText, trimmed);
    }
    if (cancelled) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
    if (forceAnswerOnly) systemPrompt += "\n\n" + answerOnlyNudge;
    // PRIVACY-01: scrub secrets from the outgoing (derived) array.
    const openaiMessages = toOpenAIMessages(redactMessages(trimmed), systemPrompt, provider.vision);
    if (provider.vision) logger.info(`[deepseek][diag] outgoing roles: ${openaiMessages.map((m, i) => `${i}:${m.role}${Array.isArray(m.content) && m.content.some(b => b.type === "image_url") ? "[img]" : ""}`).join(" ")}`);
    let response;
    const thinkingMode = /deepseek-v4/i.test(provider.model) ? (state.thinks ? "thinking" : "non-thinking") : null;
    try { response = await makeDeepSeekRequest(provider, deepseekTools, openaiMessages, state.noTools || opts.noTools || forceAnswerOnly, setAbort, thinkingMode); }
    catch (e) {
      if (e.name === "AbortError") { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      const errorMsg = e.isTimeout ? "Request timeout" : e.message;
      if (e.isTimeout) logger.warn(`[deepseek] request timed out after ${FETCH_TIMEOUT / 1000}s`, { model: provider.model });
      else logger.error(`[deepseek] request failed: ${errorMsg}`, { model: provider.model });
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + errorMsg }); emitter.send({ type: "stream_end", text: errorMsg, usage: streamUsage }); return errorMsg;
    }
    if (!response.ok) {
      const err = await response.text();
      if (isImageError(err)) {
        logger.warn(`[agent] DeepSeek rejected image content (model=${provider.model}) — retrying text-only. Raw error: ${err.slice(0, 500)}`);
        emitter.send({ type: "stream_start" });
        emitter.send({ type: "token", text: `> ⚠️ **Vision not available** — \`${provider.model}\` does not accept image content via this API. Responding based on the text description only.\n\n` });
        try { response = await makeDeepSeekRequest(provider, deepseekTools, stripImages(openaiMessages), state.noTools || opts.noTools || forceAnswerOnly, setAbort, thinkingMode); }
        catch (e2) {
          if (e2.name === "AbortError") { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
          const errorMsg = e2.isTimeout ? "Request timeout" : e2.message;
          if (e2.isTimeout) logger.warn(`[deepseek] image-retry timed out after ${FETCH_TIMEOUT / 1000}s`, { model: provider.model });
          else logger.error(`[deepseek] image-retry request failed: ${errorMsg}`, { model: provider.model });
          emitter.send({ type: "token", text: "⚠️ " + errorMsg }); emitter.send({ type: "stream_end", text: errorMsg, usage: streamUsage }); return errorMsg;
        }
        if (!response.ok) {
          const err2 = await response.text();
          logger.error(`[deepseek] API error on image-retry (${response.status}): ${err2.slice(0, 200)}`);
          emitter.send({ type: "token", text: "⚠️ DeepSeek error: " + err2 }); emitter.send({ type: "stream_end", text: err2, usage: streamUsage }); return err2;
        }
      } else {
        logger.error(`[deepseek] API error (${response.status}): ${err.slice(0, 200)}`);
        emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ DeepSeek error: " + err }); emitter.send({ type: "stream_end", text: err, usage: streamUsage }); return err;
      }
    }
    // thinkingTimeoutMs: 0 — this loop has no suppressed-thinking retry to fall
    // into after a cutoff (unlike runLlamaCppLoop), so bounding a long DeepSeek
    // reasoning turn here would just turn it into a bare empty-response
    // fallback instead of an answer. See llamacppHandler.js's THINKING_TIMEOUT_MS.
    const streamHandler = new LlamaCppStreamHandler(response, emitter, reasoningAdapter, callTool, provider, false, 0);
    const { cleanText, toolCalls, reasoningContent } = await streamHandler.process();
    streamUsage = streamHandler.streamUsage;
    if (streamUsage.thinking_tokens === 0 && reasoningContent) streamUsage.thinking_tokens = Math.max(1, Math.ceil(reasoningContent.length / 4));
    if (streamHandler.detectedThinking && !state.thinks) { state.thinks = true; logger.info(`[agent] thinking auto-detected for model="${provider.model}"`); }
    const toolExecutor = new ToolExecutor(callTool, emitter, messages, deepseekTools.map(t => t.function?.name).filter(Boolean), forceAnswerOnly);
    toolExecutor.streamUsage = streamUsage;
    if (state.thinks) { const r = await toolExecutor.executeThinkingResponse(cleanText, toolCalls, streamHandler, true, reasoningContent); if (r !== null) return r; }
    else { const r = await toolExecutor.executeNonThinkingResponse(cleanText, toolCalls, streamHandler, reasoningContent); if (r !== null) return r; }
    if (cancelled) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
    // Runaway-loop breaker — see llamacpp.js for the recorded incident this
    // guards. Kept identical in both loops so the two cannot drift.
    if (!forceAnswerOnly) {
      const repeats = countTrailingRepeatedToolCalls(messages);
      if (repeats >= TOOL_REPEAT_LIMIT) {
        logger.warn(`[agent] tool-repeat breaker: model="${provider.model}" issued the same tool call ${repeats}× in a row — forcing a tool-free answer for this turn`);
        emitter.send({ type: "tool_repeat_break", repeats, model: provider.model });
        forceAnswerOnly = true;
        answerOnlyNudge = TOOL_REPEAT_NUDGE;
      }
    }
    // Per-turn step cap — see llamacpp.js. Kept identical in both loops.
    toolSteps++;
    if (!forceAnswerOnly && turnStepLimit > 0 && toolSteps >= turnStepLimit) {
      logger.warn(`[agent] turn step cap: model="${provider.model}" made ${toolSteps} tool-calling passes in one turn (limit ${turnStepLimit}) — forcing a tool-free answer`);
      emitter.send({ type: "tool_step_limit", steps: toolSteps, limit: turnStepLimit, model: provider.model });
      forceAnswerOnly = true;
      answerOnlyNudge = TURN_STEP_NUDGE;
    }
    continue;
  }
}
