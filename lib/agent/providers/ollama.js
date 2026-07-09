import { LlamaCppStreamHandler as OllamaStreamHandler } from "../../streaming/llamacppHandler.js";
import { ToolExecutor, extractTextToolCall, detectToolCallLeak, recoverToolName } from "../../tools/executor.js";
import { estimateMsgTokens, trimByTokens, dropOrphanedToolResults, makeContextSignals, ctxPct, capToolResults } from "../../context/trim.js";
import logger from "../../helpers/logger.js";
import { bridgeImagesToVLM, isStandaloneVisionRequest, isToollessVLM, isVisionModel } from "../../helpers/imageBridge.js";
import { zodToJsonSchema } from "../../providers/schema.js";

const OLLAMA_VLM_MODEL = process.env.OLLAMA_VLM_MODEL || "qwen2.5vl:7b";

const MAX_HISTORY = 20;
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
const HEALTH_CHECK_TIMEOUT = parseInt(process.env.OLLAMA_HEALTH_TIMEOUT_MS || "3000", 10);
const FETCH_TIMEOUT = parseInt(process.env.OLLAMA_FETCH_TIMEOUT_MS || "300000", 10);

// Preflight probe of /api/tags. Returns true when healthy, otherwise the
// user-facing failure message (already emitted). A refused connection means
// Ollama is genuinely down; a timeout usually means it's up but busy loading a
// large model (a multi-GB model with a big KV cache can take far longer than the
// 3s default), so we retry once with a longer timeout and word the failure to
// match what we actually saw instead of always telling the user to `ollama pull`.
async function checkOllamaHealth(provider, emitter, setAbort) {
  if (provider.name !== "ollama") return true;
  const timeouts = [HEALTH_CHECK_TIMEOUT, HEALTH_CHECK_TIMEOUT * 3];
  let lastErr = null;
  for (const timeout of timeouts) {
    try {
      const c = new AbortController(); setAbort(c);
      const h = await fetch(`${provider.ollamaBaseURL}/api/tags`, { signal: AbortSignal.any([c.signal, AbortSignal.timeout(timeout)]) });
      if (!h.ok) throw new Error(`HTTP ${h.status}`);
      return true;
    } catch (e) { lastErr = e; }
  }
  // A blown deadline surfaces as a TimeoutError — that means Ollama is reachable
  // but didn't answer in time, almost always because a large model is still
  // loading. Every other failure (refused connection, DNS, non-OK status) means
  // it's genuinely not reachable, so only the timeout gets the "loading" wording.
  const timedOut = lastErr?.name === "TimeoutError";
  const msg = timedOut
    ? `Ollama is up but not responding yet — model "${provider.model}" may still be loading. Wait a few seconds and try again, or raise OLLAMA_HEALTH_TIMEOUT_MS (currently ${HEALTH_CHECK_TIMEOUT}ms).`
    : `Ollama is not running. Fix:\n1. ollama serve\n2. ollama pull ${provider.model}`;
  logger.warn(`[ollama] health probe failed (${lastErr?.name || "unknown"}): ${timedOut ? "treating as loading" : "treating as down"}`);
  emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + msg }); emitter.send({ type: "stream_end", text: msg, usage: zeroUsage() });
  return msg;
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
  const { provider, callTool, getSystemPrompt, getOllamaTools, prepareModelContext, reasoningAdapter, state } = ctx;

  // ── Local VLM image bridge ──────────────────────────────────────────────
  // Analyze user images with the dedicated local VLM before the main model.
  // This keeps visual grounding separate from tool orchestration even when the
  // selected main model (gemma4/qwen3.5) can also see images.
  //
  // If the selected main model is itself the configured VLM, calling the bridge
  // would recurse into the same model. In that special case it handles the raw
  // image directly. VLM-only models still suppress unsupported tool schemas.
  const mainIsConfiguredVLM =
    provider.name === "ollama" && provider.model === OLLAMA_VLM_MODEL;
  const lastUserBeforeBridge = [...messages].reverse().find(m => m.role === "user");
  const lastUserTextBeforeBridge = typeof lastUserBeforeBridge?.content === "string"
    ? lastUserBeforeBridge.content
    : lastUserBeforeBridge?.content?.filter?.(b => b.type === "text").map(b => b.text || "").join("\n") ?? "";
  const hasRawUserImage = messages.some(m =>
    m.role === "user" && Array.isArray(m.content) &&
    m.content.some(b => b.type === "image" && b.source?.data)
  );

  if (mainIsConfiguredVLM) {
    if (isToollessVLM(provider.model) && !state.noTools) {
      state.noTools = true;
      logger.info(`[agent] VLM-only model "${provider.model}" — skipping bridge, suppressing tools`);
    }
  } else if (hasRawUserImage) {
    const standalone = isStandaloneVisionRequest(lastUserTextBeforeBridge);
    const bridge = await bridgeImagesToVLM(messages, callTool, emitter, {
      userPrompt: lastUserTextBeforeBridge,
      emitOutput: false,
      // Multimodal main models can still recover from an unavailable VLM.
      preserveFailedImages: isVisionModel(provider.model),
    });

    // The VLM already produced the requested user-facing answer. Do not spend a
    // second model turn paraphrasing it. The description was also inserted into
    // the user message above, so it remains available to later follow-ups.
    if (standalone && bridge.described > 0 && bridge.displayText) {
      const answer = bridge.displayText;
      emitter.send({ type: "stream_start" });
      emitter.send({ type: "token", text: answer });
      emitter.send({ type: "stream_end", text: answer, usage: zeroUsage() });
      messages.push({ role: "assistant", content: [{ type: "text", text: answer }] });
      logger.info(`[agent] standalone visual request answered directly by ${OLLAMA_VLM_MODEL}`);
      return answer;
    }
  }

  let tokenHWM = 0;
  let streamUsage = zeroUsage();
  const ctxSignals = makeContextSignals();
  // Some local models (notably gemma) intermittently end a turn with reasoning
  // but no answer and no tool call (finish_reason "stop", empty completion). The
  // failure is stochastic, so we retry once with thinking forced off and a nudge
  // before falling back to the "no response" message.
  // Cache serialized tool schemas across tool-call loop iterations so they
  // are not re-serialized on every model round-trip within the same user turn.
  let cachedOllamaTools = null;
  let cachedToolKey = null;

  let emptyRetries = 0;
  let leakRetries = 0;
  let forceSuppressThinking = false;
  let retryNudge = null;
  // The health probe is a one-time preflight, not a per-turn gate. Once any
  // request has succeeded we KNOW Ollama is up, so re-probing each iteration
  // only adds a 3s-timeout failure point: a transient slow `/api/tags` (e.g.
  // the server busy serving a large model right after a tool turn) would
  // otherwise abort a working conversation with a misleading "not running"
  // message. Genuine mid-conversation outages are still caught by the request
  // error handler below, which reports the actual error.
  //
  // The flag lives on `state` (one object per session) rather than a local, so
  // it survives across user turns. A function-local would reset to false on the
  // next message and re-probe a model that just answered — the exact case where
  // a transient slow `/api/tags` falsely reports "still loading".
  // Shared honest-failure exit for the two "couldn't issue the call" cases
  // below (text leak / corrupted native name). Reads the current iteration's
  // streamUsage at call time.
  const emitLeakFallback = () => {
    const fallback = "*(I tried to use one of my tools but couldn't issue the call correctly. Please try again or rephrase your request.)*";
    emitter.send({ type: "stream_start" });
    emitter.send({ type: "token", text: fallback });
    emitter.send({ type: "stream_end", text: fallback, usage: streamUsage });
    messages.push({ role: "assistant", content: [{ type: "text", text: fallback }] });
    return fallback;
  };
  while (true) {
    tokenHWM = Math.max(tokenHWM, streamUsage.input_tokens);
    streamUsage = zeroUsage();
    if (getAbort()?.signal?.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
    let trimmed, systemPrompt, ollamaTools;
    if (prepareModelContext) {
      const prepared = await prepareModelContext({
        messages,
        observedInputTokens: tokenHWM,
        lang: opts.lang,
        extraSystem: opts.extraSystem,
        providerLabel: "",
      });
      trimmed = prepared.messages;
      systemPrompt = prepared.systemPrompt;
      // Cache tool schemas across tool-call loop iterations: the tool set
      // doesn't change within the same user turn, only the messages grow.
      const toolKey = prepared.tools.map(t => t.name).sort().join(",");
      if (cachedToolKey === toolKey) {
        ollamaTools = cachedOllamaTools;
      } else {
        ollamaTools = prepared.tools.map(tool => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: zodToJsonSchema(tool.inputSchema),
          },
        }));
        cachedOllamaTools = ollamaTools;
        cachedToolKey = toolKey;
      }
    } else {
      const capped = capToolResults(messages, provider.contextWindow);
      const hwm = tokenHWM > 0 ? tokenHWM : capped.reduce((s, m) => s + estimateMsgTokens(m), 0);
      const pct = ctxPct(hwm, provider.contextWindow);
      ctxSignals.emit(emitter, hwm, provider.contextWindow);
      const { messages: rawMessages, dropped } = trimByTokens(capped, hwm, provider.contextWindow);
      const safeRaw = dropped === 0 && rawMessages.length > MAX_HISTORY ? [rawMessages[0], ...rawMessages.slice(-(MAX_HISTORY - 1))] : rawMessages;
      if (dropped > 0) { logger.info(`[agent] context trimmed: dropped ${dropped} messages at ${pct}% pressure`); emitter.send({ type: "context_trimmed", dropped, pct }); }
      trimmed = dropOrphanedToolResults(safeRaw);
      const lastUserMsg = [...trimmed].reverse().find(m =>
        m.role === "user" && (typeof m.content === "string" || (Array.isArray(m.content) && m.content.some(b => b.type === "text")))
      );
      const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
      systemPrompt = getSystemPrompt(lastUserText, opts.lang, opts.extraSystem, trimmed);
      ollamaTools = getOllamaTools(lastUserText, trimmed);
    }
    if (retryNudge) systemPrompt += "\n\n" + retryNudge;
    const openaiMessages = toOpenAIMessages(trimmed, systemPrompt, provider.vision);
    if (!state.ollamaEverConnected) {
      const health = await checkOllamaHealth(provider, emitter, setAbort);
      if (health !== true) return health;
    }
    const noTools = state.noTools || opts.noTools;
    // Let thinking stream on the first attempt so the reasoning toggle is honored
    // on every turn. Some models (gemma) occasionally stall in their thinking
    // channel on tool turns and end empty — that case is caught below by the
    // empty-completion retry, which re-runs this turn with thinking forced off.
    // `opts.suppressThinking` forces it off for the whole turn regardless — used
    // by the cosmetic greeting turn, where a reasoning model would otherwise spend
    // minutes ruminating over "say hello in one sentence" (ornith: ~19s→minutes
    // under the full system prompt vs ~1s with thinking off).
    const suppressThinking = forceSuppressThinking || opts.suppressThinking === true;
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
    state.ollamaEverConnected = true;
    const streamHandler = new OllamaStreamHandler(response, emitter, reasoningAdapter, callTool, provider, suppressThinking);
    const { cleanText, toolCalls, reasoningContent } = await streamHandler.process();
    streamUsage = streamHandler.streamUsage;
    if (streamUsage.thinking_tokens === 0 && reasoningContent)
      streamUsage.thinking_tokens = estimateThinkingTokens(streamUsage.output_tokens, reasoningContent.length, cleanText.length);
    if (streamHandler.detectedThinking && !state.thinks) { state.thinks = true; logger.info(`[agent] thinking auto-detected for model="${provider.model}"`); }
    // Recover corrupted native tool-call names before dispatch. gemma (esp. with
    // reasoning) sometimes wraps its call in hallucinated channel/harmony markup
    // and Ollama dumps the raw text into function.name, so the name matches no
    // tool and MCP returns -32602. Recover the embedded known tool name; if none
    // is found the call is unusable and is handled as a leak just below.
    let corruptToolCall = false;
    const corruptNames = [];
    if (toolCalls.length) {
      const knownToolNames = ollamaTools.map(t => t.function?.name).filter(Boolean);
      for (const tc of toolCalls) {
        const recovered = recoverToolName(tc.name, knownToolNames);
        if (recovered && recovered !== tc.name) {
          logger.warn(`[agent] recovered corrupted tool name for model="${provider.model}": "${tc.name.slice(0, 120).replace(/\s+/g, " ")}" → "${recovered}"`);
          tc.name = recovered;
        } else if (!recovered) {
          corruptToolCall = true;
          corruptNames.push(String(tc.name ?? "").slice(0, 200).replace(/\s+/g, " "));
        }
      }
    }
    // Unrecoverable corrupted tool name — same remedy as a text leak: wipe the
    // half-rendered call, nudge once for a clean native call, then fail honestly.
    if (corruptToolCall) {
      emitter.send({ type: "retract" });
      if (leakRetries < 1) {
        leakRetries++;
        retryNudge = "Your previous reply issued a tool call whose name was wrapped in extra markup (for example \"<|channel>…<|tool_call>call:db_schema\"), so it matched no tool. Call the tool again using ONLY its plain name (e.g. \"db_schema\") with a normal JSON arguments object — no channel tags, no \"call:\" prefix.";
        logger.warn(`[agent] corrupted tool name from model="${provider.model}" — retrying with nudge: [${corruptNames.map(n => `"${n}"`).join(", ")}]`);
        continue;
      }
      logger.error(`[agent] corrupted tool name persisted after retry from model="${provider.model}": [${corruptNames.map(n => `"${n}"`).join(", ")}]`);
      return emitLeakFallback();
    }
    // Empty completion (no answer, no tool call): retry once with thinking off
    // and a nudge before letting the executor emit the "no response" fallback.
    if (!cleanText.trim() && toolCalls.length === 0 && emptyRetries < 1) {
      emptyRetries++;
      forceSuppressThinking = true;
      retryNudge = "Your previous attempt ended without any answer or tool call. Respond now: either give the final answer directly, or call the appropriate tool. Do not think further.";
      logger.info(`[agent] empty completion from model="${provider.model}" — retrying with thinking suppressed`);
      continue;
    }
    // Tool-call leakage: the model printed a tool call as TEXT (e.g.
    // "<execute_tool>" or "call(recall, …)") instead of issuing a real
    // tool_calls array, and extractTextToolCall can't recover it. Rendering it
    // as a normal answer is a silent failure — the model then claims it ran the
    // tool. Retry once with a nudge to issue a native call; the CLI buffers
    // tokens until stream_end, so a `retract` wipes the leaked text before the
    // user ever sees it. If it still leaks, surface an honest error.
    if (toolCalls.length === 0 && cleanText.trim() &&
        detectToolCallLeak(cleanText, ollamaTools.map(t => t.function?.name).filter(Boolean)) &&
        !extractTextToolCall(cleanText, messages)) {
      emitter.send({ type: "retract" });
      if (leakRetries < 1) {
        leakRetries++;
        forceSuppressThinking = true;
        retryNudge = "Your previous reply printed a tool call as plain text (for example \"<execute_tool>\" or \"call(recall, …)\"). Writing that text does NOT run the tool and the user sees nothing happen. To use a tool you must issue a real tool/function call. Either issue the proper tool call now, or answer directly — do not write a fake tool call.";
        logger.warn(`[agent] tool-call leakage from model="${provider.model}" — retrying with thinking suppressed: ${cleanText.slice(0, 120).replace(/\s+/g, " ")}`);
        continue;
      }
      logger.error(`[agent] tool-call leakage persisted after retry from model="${provider.model}": ${cleanText.slice(0, 200).replace(/\s+/g, " ")}`);
      return emitLeakFallback();
    }
    const toolExecutor = new ToolExecutor(callTool, emitter, messages);
    toolExecutor.streamUsage = streamUsage;
    if (state.thinks) { const r = await toolExecutor.executeThinkingResponse(cleanText, toolCalls, streamHandler, true, reasoningContent); if (r !== null) return r; }
    else { const r = await toolExecutor.executeNonThinkingResponse(cleanText, toolCalls, streamHandler, reasoningContent); if (r !== null) return r; }
    continue;
  }
}
