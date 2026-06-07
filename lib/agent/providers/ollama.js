import { OllamaStreamHandler } from "../../streaming/ollamaHandler.js";
import { ToolExecutor } from "../../tools/executor.js";
import { estimateMsgTokens, trimByTokens, dropOrphanedToolResults, makeContextSignals, ctxPct } from "../../context/trim.js";
import logger from "../../helpers/logger.js";
import { bridgeImagesToVLM, isVisionModel, isToollessVLM } from "../../helpers/imageBridge.js";

const OLLAMA_VLM_MODEL = process.env.OLLAMA_VLM_MODEL || "qwen2.5vl:7b";

const MAX_HISTORY = 20;
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
const HEALTH_CHECK_TIMEOUT = parseInt(process.env.OLLAMA_HEALTH_TIMEOUT_MS || "3000", 10);
const FETCH_TIMEOUT = parseInt(process.env.OLLAMA_FETCH_TIMEOUT_MS || "300000", 10);

async function checkOllamaHealth(provider, emitter, setAbort) {
  if (provider.name !== "ollama") return true;
  try {
    const c = new AbortController(); setAbort(c);
    const h = await fetch(`${provider.ollamaBaseURL}/api/tags`, { signal: AbortSignal.any([c.signal, AbortSignal.timeout(HEALTH_CHECK_TIMEOUT)]) });
    if (!h.ok) throw new Error(); return true;
  } catch {
    const msg = `Ollama is not running. Fix:\n1. ollama serve\n2. ollama pull ${provider.model}`;
    emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + msg }); emitter.send({ type: "stream_end", text: msg, usage: zeroUsage() }); return false;
  }
}

async function makeOllamaRequest(provider, ollamaTools, openaiMessages, noTools, suppressThinking, setAbort) {
  const controller = new AbortController(); setAbort(controller);
  const timeoutController = new AbortController(); const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`${provider.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
      body: JSON.stringify({ model: provider.model, messages: openaiMessages, stream_options: { include_usage: true }, ...(noTools ? {} : { tools: ollamaTools }), ...(suppressThinking ? { reasoning_effort: "none" } : {}), stream: true }),
      signal: AbortSignal.any([controller.signal, timeoutController.signal]),
    });
    clearTimeout(timeoutId); return response;
  } catch (e) { clearTimeout(timeoutId); if (timeoutController.signal.aborted) e.isTimeout = true; throw e; }
}

// Ollama folds reasoning into completion_tokens but often omits the
// reasoning_tokens breakdown, so we estimate the thinking share ourselves.
// Splitting the total by text length keeps thinking + answer == total and
// avoids a phantom "answer" count when the model produced only reasoning
// (answer text empty → all tokens attributed to thinking).
export function estimateThinkingTokens(outputTokens, reasoningLen, answerLen) {
  if (outputTokens > 0 && reasoningLen + answerLen > 0)
    return Math.round(outputTokens * reasoningLen / (reasoningLen + answerLen));
  return Math.max(1, Math.ceil(reasoningLen / 4));
}

function toOpenAIMessages(messages, systemPrompt, vision) {
  return [{ role: "system", content: systemPrompt }, ...messages.flatMap(m => {
    if (Array.isArray(m.content) && m.content[0]?.type === "tool_result") {
      const out = [];
      for (const tr of m.content) {
        const text = Array.isArray(tr.content) ? tr.content.filter(b => b.type === "text").map(b => b.text).join("") : (typeof tr.content === "string" ? tr.content : "");
        const imgs = vision === false ? [] : (Array.isArray(tr.content) ? tr.content.filter(b => b.type === "image") : []);
        out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: text || (imgs.length ? "[image attached]" : "No result") });
        if (imgs.length) out.push({ role: "user", content: imgs.map(b => ({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } })) });
      }
      return out;
    }
    if (Array.isArray(m.content)) {
      const text = m.content.filter(b => b.type === "text").map(b => b.text).join("");
      const images = vision === false ? [] : m.content.filter(b => b.type === "image").map(b => ({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }));
      // Some OpenAI-compatible vendors (e.g. Together, Groq forks) reject
      // assistant messages with `content: null`, raising `invalid message
      // content type: <nil>`. The official spec allows null when tool_calls
      // are present, but to stay portable across vendors we always emit a
      // string (empty if the turn was tool-only).
      const content = images.length > 0 ? [{ type: "text", text: text || "" }, ...images] : (text || "");
      const tcs = m.content.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      return [{ role: m.role, content, ...(tcs.length ? { tool_calls: tcs } : {}), ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) }];
    }
    return [{ role: m.role, content: m.content ?? "", ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) }];
  })];
}

export async function runOllamaLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}, ctx) {
  const { provider, callTool, getSystemPrompt, getOllamaTools, reasoningAdapter, state } = ctx;

  // ── Local VLM image bridge ──────────────────────────────────────────────
  // Text-only Ollama models cannot see images natively. Before the first API
  // call, describe every user-attached image via a local Ollama VLM and
  // replace the raw image blocks with the resulting text.
  //
  // Skip the bridge when the main model can already see images natively
  // (e.g. gemma4, qwen2.5vl, llava). Also handles the edge case where the
  // main model IS the configured VLM — bridging would recurse into itself.
  //
  // Tools suppression is separate: VLM-only models (qwen2.5vl, llava, etc.)
  // reject the `tools` param, but full multimodal models (gemma4, etc.) do not.
  const mainIsVision =
    provider.name === "ollama" &&
    (provider.model === OLLAMA_VLM_MODEL || isVisionModel(provider.model));

  if (mainIsVision) {
    const suppressTools = isToollessVLM(provider.model);
    if (suppressTools && !state.noTools) {
      state.noTools = true;
      logger.info(`[agent] VLM-only model "${provider.model}" — skipping bridge, suppressing tools`);
    } else if (!suppressTools) {
      logger.info(`[agent] native vision model "${provider.model}" — skipping VLM bridge`);
    }
  } else {
    await bridgeImagesToVLM(messages, callTool, emitter);
  }

  let tokenHWM = 0;
  let streamUsage = zeroUsage();
  const ctxSignals = makeContextSignals();
  // Some local models (notably gemma) intermittently end a turn with reasoning
  // but no answer and no tool call (finish_reason "stop", empty completion). The
  // failure is stochastic, so we retry once with thinking forced off and a nudge
  // before falling back to the "no response" message.
  let emptyRetries = 0;
  let forceSuppressThinking = false;
  let retryNudge = null;
  while (true) {
    tokenHWM = Math.max(tokenHWM, streamUsage.input_tokens);
    streamUsage = zeroUsage();
    if (getAbort()?.signal?.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
    const hwm = tokenHWM > 0 ? tokenHWM : messages.reduce((s, m) => s + estimateMsgTokens(m), 0);
    const pct = ctxPct(hwm, provider.contextWindow);
    ctxSignals.emit(emitter, hwm, provider.contextWindow);
    const { messages: rawMessages, dropped } = trimByTokens(messages, hwm, provider.contextWindow);
    const safeRaw = dropped === 0 && rawMessages.length > MAX_HISTORY ? [rawMessages[0], ...rawMessages.slice(-(MAX_HISTORY - 1))] : rawMessages;
    if (dropped > 0) { logger.info(`[agent] context trimmed: dropped ${dropped} messages at ${pct}% pressure`); emitter.send({ type: "context_trimmed", dropped, pct }); }
    const trimmed = dropOrphanedToolResults(safeRaw);
    const lastUserMsg = [...trimmed].reverse().find(m =>
      m.role === "user" && (typeof m.content === "string" || (Array.isArray(m.content) && m.content.some(b => b.type === "text")))
    );
    const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
    let systemPrompt = getSystemPrompt(lastUserText, opts.lang, opts.extraSystem, messages);
    if (retryNudge) systemPrompt += "\n\n" + retryNudge;
    const openaiMessages = toOpenAIMessages(trimmed, systemPrompt, provider.vision);
    const healthy = await checkOllamaHealth(provider, emitter, setAbort);
    if (!healthy) return "Ollama is not running";
    const ollamaTools = getOllamaTools(lastUserText, messages);
    const noTools = state.noTools || opts.noTools;
    // Some models (gemma) stall in their thinking channel on tool turns; disable
    // reasoning when tools are actually offered so they commit to the call. An
    // empty-completion retry always suppresses thinking regardless of model.
    const suppressThinking = forceSuppressThinking || (reasoningAdapter.noThinkWithTools === true && !noTools);
    let response;
    try { response = await makeOllamaRequest(provider, ollamaTools, openaiMessages, noTools, suppressThinking, setAbort); }
    catch (e) {
      if (e.name === "AbortError") { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      const errorMsg = e.isTimeout ? "Request timeout" : e.message;
      if (e.isTimeout) logger.warn(`[ollama] request timed out after ${FETCH_TIMEOUT / 1000}s`, { model: provider.model });
      else logger.error(`[ollama] request failed: ${errorMsg}`, { model: provider.model });
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + errorMsg }); emitter.send({ type: "stream_end", text: errorMsg, usage: streamUsage }); return errorMsg;
    }
    if (!response.ok) {
      const err = await response.text();
      const label = provider.name === "ollama" ? "Ollama" : provider.name === "gemini" ? "Gemini" : provider.name === "deepseek" ? "DeepSeek" : provider.name;
      logger.error(`[ollama] ${label} API error (${response.status}): ${err.slice(0, 200)}`);
      let errMsg = err;
      try { const parsed = JSON.parse(err); errMsg = parsed?.error?.message ?? parsed?.message ?? err; } catch {}
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: `⚠️ ${label} error: ` + errMsg }); emitter.send({ type: "stream_end", text: errMsg, usage: streamUsage }); return errMsg;
    }
    const streamHandler = new OllamaStreamHandler(response, emitter, reasoningAdapter, callTool, provider, suppressThinking);
    const { cleanText, toolCalls, reasoningContent } = await streamHandler.process();
    streamUsage = streamHandler.streamUsage;
    if (streamUsage.thinking_tokens === 0 && reasoningContent)
      streamUsage.thinking_tokens = estimateThinkingTokens(streamUsage.output_tokens, reasoningContent.length, cleanText.length);
    if (streamHandler.detectedThinking && !state.thinks) { state.thinks = true; logger.info(`[agent] thinking auto-detected for model="${provider.model}"`); }
    // Empty completion (no answer, no tool call): retry once with thinking off
    // and a nudge before letting the executor emit the "no response" fallback.
    if (!cleanText.trim() && toolCalls.length === 0 && emptyRetries < 1) {
      emptyRetries++;
      forceSuppressThinking = true;
      retryNudge = "Your previous attempt ended without any answer or tool call. Respond now: either give the final answer directly, or call the appropriate tool. Do not think further.";
      logger.info(`[agent] empty completion from model="${provider.model}" — retrying with thinking suppressed`);
      continue;
    }
    const toolExecutor = new ToolExecutor(callTool, emitter, messages);
    toolExecutor.streamUsage = streamUsage;
    if (state.thinks) { const r = await toolExecutor.executeThinkingResponse(cleanText, toolCalls, streamHandler, true, reasoningContent); if (r !== null) return r; }
    else { const r = await toolExecutor.executeNonThinkingResponse(cleanText, toolCalls, streamHandler, reasoningContent); if (r !== null) return r; }
    continue;
  }
}