import { LlamaCppStreamHandler } from "../../streaming/llamacppHandler.js";
import { ToolExecutor, extractTextToolCall, detectToolCallLeak, recoverToolName, looksLikeSystemPromptEcho } from "../../tools/executor.js";
import { estimateMsgTokens, trimByTokens, dropOrphanedToolResults, makeContextSignals, ctxPct, capToolResults } from "../../context/trim.js";
import logger from "../../helpers/logger.js";
import { bridgeImagesToVLM, isStandaloneVisionRequest, isToollessVLM, isVisionModel } from "../../helpers/imageBridge.js";
import { startModelProgressWatcher } from "../../helpers/modelProgress.js";
import { zodToJsonSchema } from "../../providers/schema.js";
import { logToolCallFailure } from "../../tools/schemaCheck.js";
import { isCapableModel, isExplicitWikiWriteIntent } from "../tool-profiles.js";
import { appendSessionLog } from "../../helpers/startLlamaCpp.js";
import { projectObservedInputTokens } from "../model-context-middleware.js";
import { encode } from "gpt-tokenizer";

const LLAMACPP_VLM_MODEL = process.env.LLAMACPP_VLM_MODEL || "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF";

const MAX_HISTORY = 20;
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
const HEALTH_CHECK_TIMEOUT = parseInt(process.env.LLAMACPP_HEALTH_TIMEOUT_MS || "3000", 10);
const FETCH_TIMEOUT = parseInt(process.env.LLAMACPP_FETCH_TIMEOUT_MS || "300000", 10);
const REQUEST_HEADROOM_RATIO = 0.90;

export function fitToolsToContext(messages, tools, contextWindow, {
  estimateTokens = value => encode(JSON.stringify(value)).length,
  headroomRatio = REQUEST_HEADROOM_RATIO,
  minimumTools = 2,
} = {}) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !tools?.length) {
    return { tools, estimatedTokens: estimateTokens({ messages, tools: tools ?? [] }), removed: 0 };
  }
  const budget = Math.floor(contextWindow * headroomRatio);
  const fitted = [...tools];
  const floor = Math.min(Math.max(0, minimumTools), fitted.length);
  let estimatedTokens = estimateTokens({ messages, tools: fitted });
  while (fitted.length > floor && estimatedTokens > budget) {
    fitted.pop();
    estimatedTokens = estimateTokens({ messages, tools: fitted });
  }
  return { tools: fitted, estimatedTokens, removed: tools.length - fitted.length };
}

// Preflight probe of /health. Returns true when healthy, otherwise the
// user-facing failure message (already emitted). Unlike Ollama's /api/tags,
// llama-server's router mode answers /health almost instantly even before a
// model is loaded (Phase 0 spike: cold start → green in 0.5s, models load
// lazily on the first /v1/chat/completions request) — so a slow *health* probe
// really does mean the engine is down or the machine is under heavy load, not
// "still loading a model". We still retry once with a longer timeout before
// giving up, to ride out a transient blip rather than a genuine outage.
async function checkLlamaCppHealth(provider, emitter, setAbort) {
  if (provider.name !== "llamacpp") return true;
  const timeouts = [HEALTH_CHECK_TIMEOUT, HEALTH_CHECK_TIMEOUT * 3];
  let lastErr = null;
  for (const timeout of timeouts) {
    try {
      const c = new AbortController(); setAbort(c);
      const h = await fetch(`${provider.llamacppBaseURL}/health`, { signal: AbortSignal.any([c.signal, AbortSignal.timeout(timeout)]) });
      if (!h.ok) throw new Error(`HTTP ${h.status}`);
      return true;
    } catch (e) { lastErr = e; }
  }
  const timedOut = lastErr?.name === "TimeoutError";
  const msg = timedOut
    ? `The local llama.cpp engine is up but slow to respond. Wait a few seconds and try again, or raise LLAMACPP_HEALTH_TIMEOUT_MS (currently ${HEALTH_CHECK_TIMEOUT}ms).`
    : `The local llama.cpp engine is not running. Aperio starts and manages it automatically — try restarting the app. If the problem persists, check the logs under var/logs.`;
  logger.warn(`[llamacpp] health probe failed (${lastErr?.name || "unknown"}): ${timedOut ? "treating as slow" : "treating as down"}`);
  emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + msg }); emitter.send({ type: "stream_end", text: msg, usage: zeroUsage() });
  return msg;
}

async function makeLlamaCppRequest(provider, llamacppTools, openaiMessages, noTools, suppressThinking, setAbort, maxTokens) {
  const controller = new AbortController(); setAbort(controller);
  const timeoutController = new AbortController(); const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`${provider.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
      // Thinking suppression per the Phase 0 spike: llama-server (Qwen/Gemma chat
      // templates alike) ignores reasoning_effort — the general OpenAI-compatible
      // mechanism is the per-request chat_template_kwargs.enable_thinking flag.
      body: JSON.stringify({ model: provider.requestModel || provider.model, messages: openaiMessages, stream_options: { include_usage: true }, ...(noTools ? {} : { tools: llamacppTools }), ...(suppressThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}), stream: true }),
      signal: AbortSignal.any([controller.signal, timeoutController.signal]),
    });
    clearTimeout(timeoutId); return response;
  } catch (e) { clearTimeout(timeoutId); if (timeoutController.signal.aborted) e.isTimeout = true; throw e; }
}

// Prompt-cache warm-up (trash/plans/prompt-cache-hygiene, WS2): fires a
// minimal, invisible chat-completion carrying the real system prompt so
// llama-server prefills and caches it before the user's first real message
// arrives — max_tokens: 1 keeps generation cost near zero, only the prefill
// (the expensive part) matters. Caller must gate this on the model already
// being loaded (see modelProgress.isModelLoaded); this function does not
// check that itself. Never throws — a failed/aborted warm-up is a no-op, not
// a user-facing error.
export async function warmLlamaCppCache(provider, systemPrompt, getAbort, setAbort) {
  try {
    const openaiMessages = toOpenAIMessages([{ role: "user", content: "" }], systemPrompt, false);
    const response = await makeLlamaCppRequest(provider, [], openaiMessages, true, true, setAbort, 1);
    if (getAbort()?.signal?.aborted) return;
    await response.text(); // drain the tiny stream; content is discarded
  } catch (err) {
    if (err.name !== "AbortError") logger.warn(`[llamacpp] cache warm-up failed: ${err.message}`);
  }
}

async function readRouterModelContext(provider) {
  try {
    const r = await fetch(`${provider.llamacppBaseURL}/models`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const data = await r.json();
    const model = (data?.data ?? []).find(m => m.id === provider.model || m.aliases?.includes?.(provider.model));
    const served = Number(model?.meta?.n_ctx);
    if (!Number.isFinite(served) || served <= 0) return null;
    return Math.max(1, Math.min(Math.floor(served * 0.92), served - 512));
  } catch { return null; }
}

// llama.cpp folds reasoning into completion_tokens but often omits the
// reasoning_tokens breakdown, so we estimate the thinking share ourselves.
// Splitting the total by text length keeps thinking + answer == total and
// avoids a phantom "answer" count when the model produced only reasoning
// (answer text empty → all tokens attributed to thinking).
export function estimateThinkingTokens(outputTokens, reasoningLen, answerLen) {
  if (outputTokens > 0 && reasoningLen + answerLen > 0)
    return Math.round(outputTokens * reasoningLen / (reasoningLen + answerLen));
  return Math.max(1, Math.ceil(reasoningLen / 4));
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(block => block?.type === "text").map(block => block.text ?? "").join("\n");
}

function toolResultFailed(content) {
  const text = blockText(content).trim();
  // Tool handlers use a leading ❌ as the failure contract. Do not classify
  // arbitrary words in a successful payload (for example, an article titled
  // "Nimbus Error Recovery") as a failed call and accidentally repeat a
  // mutation that already succeeded.
  return !text || /^❌/u.test(text);
}

export function getToolLoopGuidance(messages = []) {
  const resultMessage = messages.at(-1);
  const results = Array.isArray(resultMessage?.content)
    ? resultMessage.content.filter(block => block?.type === "tool_result")
    : [];
  if (!results.length) return "";

  const toolNames = new Map();
  for (const message of messages.slice(0, -1)) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === "tool_use" && block.tool_use_id !== "") {
        toolNames.set(block.id, block.name);
      }
    }
  }
  const observations = results.map(result => ({
    name: toolNames.get(result.tool_use_id),
    failed: toolResultFailed(result.content),
  }));
  const wikiWrite = observations.find(item => item.name === "wiki_write");
  if (wikiWrite) {
    if (wikiWrite.failed) {
      return "The immediately preceding `wiki_write` failed. Retry it once with concise, strictly valid JSON, preserving the requested article content and all source-memory provenance. Do not restart recall or the wider workflow.";
    }
    return "The immediately preceding `wiki_write` completed successfully. Do not call `wiki_write` again. Continue only any verification the user explicitly requested; otherwise give a concise user-visible confirmation now.";
  }

  const recalled = observations.some(item => item.name === "recall" && !item.failed);
  if (!recalled) return "";
  const lastUser = [...messages].reverse().find(message => {
    if (message?.role !== "user") return false;
    if (typeof message.content === "string") return true;
    return Array.isArray(message.content) && message.content.some(block => block?.type === "text");
  });
  const userText = blockText(lastUser?.content);
  if (!isExplicitWikiWriteIntent(userText)) return "";
  return "Recall succeeded for the user's explicitly authorized wiki write. Call `wiki_write` now, not `propose_wiki`. Keep the synthesis concise enough for one tool call, emit strictly valid JSON, and preserve the relevant claims and source_memory_ids provenance.";
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

export async function runLlamaCppLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}, ctx) {
  const { provider, callTool, getSystemPrompt, getOpenAiTools, prepareModelContext, reasoningAdapter, state } = ctx;
  const logProviderError = (message) => {
    logger.error(message);
    appendSessionLog(opts.llamaLogSessionId, message);
  };

  // ── Local VLM image bridge ──────────────────────────────────────────────
  // Analyze user images with the dedicated local VLM before the main model.
  // This keeps visual grounding separate from tool orchestration even when the
  // selected main model (gemma4/qwen3.5) can also see images.
  //
  // If the selected main model is itself the configured VLM, calling the bridge
  // would recurse into the same model. In that special case it handles the raw
  // image directly. VLM-only models still suppress unsupported tool schemas.
  const mainIsConfiguredVLM =
    provider.name === "llamacpp" && provider.model === LLAMACPP_VLM_MODEL;
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
  } else if (hasRawUserImage && !isCapableModel(provider, state.noTools) && !isVisionModel(provider.model)) {
    // Capable local models are trusted with the complete multimodal flow, so
    // keep the image on the main request. Native-vision models get the same
    // treatment even when they have not yet been added to the allowlist. Only
    // a model that is both non-capable and non-vision needs the VLM bridge.
    const standalone = isStandaloneVisionRequest(lastUserTextBeforeBridge, { hasImage: true });
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
      logger.info(`[agent] standalone visual request answered directly by ${LLAMACPP_VLM_MODEL}`);
      return answer;
    }
  }

  let tokenHWM = 0;
  let previousMessageTokens = 0;
  let streamUsage = zeroUsage();
  const ctxSignals = makeContextSignals();
  // Some local models (notably gemma) intermittently end a turn with reasoning
  // but no answer and no tool call (finish_reason "stop", empty completion). The
  // failure is stochastic, so we retry once with thinking forced off and a nudge
  // before falling back to the "no response" message.
  // Cache serialized tool schemas across tool-call loop iterations so they
  // are not re-serialized on every model round-trip within the same user turn.
  let cachedLlamaCppTools = null;
  let cachedToolKey = null;

  let emptyRetries = 0;
  let leakRetries = 0;
  let echoRetries = 0;
  let forceSuppressThinking = false;
  let retryNudge = null;
  // The health probe is a one-time preflight, not a per-turn gate. Once any
  // request has succeeded we KNOW the engine is up, so re-probing each
  // iteration only adds a failure point for a transient slow /health (e.g. the
  // server busy serving a large model right after a tool turn), which would
  // otherwise abort a working conversation with a misleading "not running"
  // message. Genuine mid-conversation outages are still caught by the request
  // error handler below, which reports the actual error.
  //
  // The flag lives on `state` (one object per session) rather than a local, so
  // it survives across user turns. A function-local would reset to false on the
  // next message and re-probe a model that just answered.
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
    let trimmed, systemPrompt, systemPromptLean, llamacppTools;
    if (prepareModelContext) {
      const currentMessageTokens = messages.reduce((sum, message) => sum + estimateMsgTokens(message), 0);
      const projectedInputTokens = projectObservedInputTokens({
        observedInputTokens: tokenHWM,
        previousMessageTokens,
        currentMessageTokens,
      });
      previousMessageTokens = currentMessageTokens;
      const prepared = await prepareModelContext({
        messages,
        observedInputTokens: projectedInputTokens,
        lang: opts.lang,
        extraSystem: opts.extraSystem,
        providerLabel: "",
      });
      trimmed = prepared.messages;
      systemPrompt = prepared.systemPrompt;
      systemPromptLean = prepared.systemPromptNoSkills ?? null;
      // Cache tool schemas across tool-call loop iterations: the tool set
      // doesn't change within the same user turn, only the messages grow.
      const toolKey = prepared.tools.map(t => t.name).sort().join(",");
      if (cachedToolKey === toolKey) {
        llamacppTools = cachedLlamaCppTools;
      } else {
        llamacppTools = prepared.tools.map(tool => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: zodToJsonSchema(tool.inputSchema),
          },
        }));
        cachedLlamaCppTools = llamacppTools;
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
      llamacppTools = getOpenAiTools(lastUserText, trimmed);
    }
    const toolLoopGuidance = getToolLoopGuidance(messages);
    const appendNudges = (prompt) => {
      if (retryNudge) prompt += "\n\n" + retryNudge;
      if (toolLoopGuidance) prompt += "\n\n" + toolLoopGuidance;
      return prompt;
    };
    systemPrompt = appendNudges(systemPrompt);
    let openaiMessages = toOpenAIMessages(trimmed, systemPrompt, provider.vision);
    const requestBudget = Math.floor(provider.contextWindow * REQUEST_HEADROOM_RATIO);
    let fitted = fitToolsToContext(openaiMessages, llamacppTools, provider.contextWindow);
    if (fitted.removed > 0) {
      logger.info(
        `[tools] request preflight capped schemas ${llamacppTools.length}→${fitted.tools.length} ` +
        `(${fitted.estimatedTokens}/${requestBudget} estimated tokens)`,
      );
    }
    // Capping schemas alone can leave the request over budget: matched skills
    // can inject thousands of prompt tokens, and on a small served context
    // llama.cpp rejects the whole request (400 exceed_context_size_error)
    // rather than trimming. Skills are an enhancement, not a correctness
    // requirement — rebuild without them and re-fit before sending a request
    // we already know is doomed.
    if (fitted.estimatedTokens > requestBudget && systemPromptLean) {
      const lean = appendNudges(systemPromptLean);
      openaiMessages = toOpenAIMessages(trimmed, lean, provider.vision);
      const refitted = fitToolsToContext(openaiMessages, llamacppTools, provider.contextWindow);
      logger.info(
        `[tools] request preflight over budget: dropped skill prompts ` +
        `(${fitted.estimatedTokens}→${refitted.estimatedTokens} estimated tokens)`,
      );
      systemPrompt = lean;
      fitted = refitted;
    }
    llamacppTools = fitted.tools;
    if (fitted.estimatedTokens > requestBudget) {
      logger.warn(
        `[tools] request preflight still over budget after capping ` +
        `(${fitted.estimatedTokens}/${requestBudget} estimated tokens, context ${provider.contextWindow})`,
      );
    }
    if (!state.llamacppEverConnected) {
      const health = await checkLlamaCppHealth(provider, emitter, setAbort);
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
    // The router lazily downloads (-hf pull, possibly many GB) and loads the
    // model INSIDE this fetch — from here that's one long-pending promise. The
    // watcher turns those minutes into staged model_status events for the UI;
    // warm models stay silent (grace period + instant "loaded" probe).
    const stopModelWatch = provider.name === "llamacpp"
      ? startModelProgressWatcher({ model: provider.model, routerModelId: provider.requestModel || provider.model, emitter, routerBaseURL: provider.llamacppBaseURL })
      : null;
    let response;
    try { response = await makeLlamaCppRequest(provider, llamacppTools, openaiMessages, noTools, suppressThinking, setAbort); }
    catch (e) {
      if (e.name === "AbortError") { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      const errorMsg = e.isTimeout ? "Request timeout" : e.message;
      if (e.isTimeout) logger.warn(`[llamacpp] request timed out after ${FETCH_TIMEOUT / 1000}s`, { model: provider.model });
      else logProviderError(`[llamacpp] request failed: ${errorMsg}`);
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + errorMsg }); emitter.send({ type: "stream_end", text: errorMsg, usage: streamUsage }); return errorMsg;
    }
    finally { stopModelWatch?.(); }
    if (!response.ok) {
      let err = await response.text();
      // A router left running from before Aperio introduced stable aliases (or
      // an externally managed router) does not know `aperio-main`. Preserve
      // compatibility by retrying once with the real model id. A newly managed
      // router still uses the alias, so its memory-safe preset wins normally.
      if (response.status === 400 && provider.requestModel && provider.requestModel !== provider.model && err.includes(`model '${provider.requestModel}' not found`)) {
        logger.warn(`[llamacpp] router does not know alias "${provider.requestModel}" — retrying with model id "${provider.model}"`);
        try {
          response = await makeLlamaCppRequest({ ...provider, requestModel: provider.model }, llamacppTools, openaiMessages, noTools, suppressThinking, setAbort);
          if (response.ok) {
            state.llamacppEverConnected = true;
            const actualContext = await readRouterModelContext(provider);
            if (actualContext && actualContext !== provider.contextWindow) {
              logger.warn(`[llamacpp] raw-model router window differs from Aperio preset: ${provider.contextWindow} → ${actualContext}; adopting router value for this session`);
              provider.contextWindow = actualContext;
              emitter.send({ type: "provider", name: provider.name, model: provider.model, thinks: state.thinks, contextWindow: actualContext, contextCapacityPct: null });
            }
          } else {
            err = await response.text();
          }
        } catch (e) {
          const errorMsg = e.isTimeout ? "Request timeout" : e.message;
          logProviderError(`[llamacpp] raw-model fallback failed: ${errorMsg}`);
          emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + errorMsg }); emitter.send({ type: "stream_end", text: errorMsg, usage: streamUsage }); return errorMsg;
        }
      }
      if (response.ok) {
        // Continue into the normal stream handler below.
      } else {
      const label = provider.name === "llamacpp" ? "llama.cpp" : provider.name === "gemini" ? "Gemini" : provider.name === "deepseek" ? "DeepSeek" : provider.name;
      logProviderError(`[llamacpp] ${label} API error (${response.status}): ${err.slice(0, 200)}`);
      let errMsg = err;
      try { const parsed = JSON.parse(err); errMsg = parsed?.error?.message ?? parsed?.message ?? err; } catch {}
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: `⚠️ ${label} error: ` + errMsg }); emitter.send({ type: "stream_end", text: errMsg, usage: streamUsage }); return errMsg;
      }
    }
    state.llamacppEverConnected = true;
    const streamHandler = new LlamaCppStreamHandler(response, emitter, reasoningAdapter, callTool, provider, suppressThinking);
    const { cleanText, toolCalls, reasoningContent } = await streamHandler.process();
    streamUsage = streamHandler.streamUsage;
    // A mid-stream error (HTTP 200 then `data: {"error":…}`, e.g. llama-server's
    // "Compute error." on an OOM Metal alloc) yields an empty token stream. Left
    // to the empty-completion path below it would look like a degenerate "no
    // response" turn and waste a retry while hiding the real cause. Surface it
    // verbatim instead — stream_start already fired inside process().
    if (streamHandler.streamError) {
      const label = provider.name === "llamacpp" ? "llama.cpp" : provider.name === "gemini" ? "Gemini" : provider.name === "deepseek" ? "DeepSeek" : provider.name;
      logProviderError(`[llamacpp] ${label} streamed error: ${streamHandler.streamError}`);
      emitter.send({ type: "token", text: `⚠️ ${label} error: ${streamHandler.streamError}` });
      emitter.send({ type: "stream_end", text: streamHandler.streamError, usage: streamUsage });
      return streamHandler.streamError;
    }
    if (streamUsage.thinking_tokens === 0 && reasoningContent)
      streamUsage.thinking_tokens = estimateThinkingTokens(streamUsage.output_tokens, reasoningContent.length, cleanText.length);
    // llamacpp.md Phase 5: carry llama-server's real timings (prompt/gen tok/s,
    // implied load overhead) alongside the usage object rather than logging and
    // discarding them. `streamUsage.timings` rides the same object reference
    // ToolExecutor emits on every `stream_end`, so no extra plumbing is needed
    // for callers that already read `msg.usage`. `state.lastTimings` additionally
    // survives past this turn (state is session-scoped, not loop-scoped) so
    // lib/agent/index.js can read the most recent turn's timings after the
    // provider dispatch returns, for the evidence-gated slow-turn diagnostic.
    if (streamHandler.timings) {
      streamUsage.timings = streamHandler.timings;
      state.lastTimings = streamHandler.timings;
      logger.debug(`[llamacpp] timings model="${provider.model}" prompt_tps=${streamHandler.timings.prompt_per_second ?? "?"} gen_tps=${streamHandler.timings.predicted_per_second ?? "?"}`);
    }
    if (streamHandler.detectedThinking && !state.thinks) { state.thinks = true; logger.info(`[agent] thinking auto-detected for model="${provider.model}"`); }
    // Recover corrupted native tool-call names before dispatch. gemma (esp. with
    // reasoning) sometimes wraps its call in hallucinated channel/harmony markup
    // and llama.cpp dumps the raw text into function.name, so the name matches no
    // tool and MCP returns -32602. Recover the embedded known tool name; if none
    // is found the call is unusable and is handled as a leak just below.
    let corruptToolCall = false;
    const corruptNames = [];
    if (toolCalls.length) {
      const knownToolNames = llamacppTools.map(t => t.function?.name).filter(Boolean);
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
        logToolCallFailure({ model: provider.model, kind: "corrupt_name", persisted: false, detail: corruptNames.join(" | ") });
        continue;
      }
      logger.error(`[agent] corrupted tool name persisted after retry from model="${provider.model}": [${corruptNames.map(n => `"${n}"`).join(", ")}]`);
      logToolCallFailure({ model: provider.model, kind: "corrupt_name", persisted: true, detail: corruptNames.join(" | ") });
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
        detectToolCallLeak(cleanText, llamacppTools.map(t => t.function?.name).filter(Boolean)) &&
        !extractTextToolCall(cleanText, messages)) {
      emitter.send({ type: "retract" });
      if (leakRetries < 1) {
        leakRetries++;
        forceSuppressThinking = true;
        retryNudge = "Your previous reply printed a tool call as plain text (for example \"<execute_tool>\" or \"call(recall, …)\"). Writing that text does NOT run the tool and the user sees nothing happen. To use a tool you must issue a real tool/function call. Either issue the proper tool call now, or answer directly — do not write a fake tool call.";
        logger.warn(`[agent] tool-call leakage from model="${provider.model}" — retrying with thinking suppressed: ${cleanText.slice(0, 120).replace(/\s+/g, " ")}`);
        logToolCallFailure({ model: provider.model, kind: "leak", persisted: false, detail: cleanText });
        continue;
      }
      logger.error(`[agent] tool-call leakage persisted after retry from model="${provider.model}": ${cleanText.slice(0, 200).replace(/\s+/g, " ")}`);
      logToolCallFailure({ model: provider.model, kind: "leak", persisted: true, detail: cleanText });
      return emitLeakFallback();
    }
    // System-prompt echo: instead of answering, the model recited a large
    // verbatim chunk of its own instructions (persona, tool docs, skills) —
    // observed following a confused retry after a tool-call leak. This is not
    // tool-call syntax, so detectToolCallLeak above never sees it; without
    // this guard it renders straight to the user as if it were a real answer,
    // disclosing internal instructions. Same remedy as the other degenerate
    // completions: retry once with thinking off, then fail honestly.
    if (toolCalls.length === 0 && cleanText.trim() && looksLikeSystemPromptEcho(cleanText, systemPrompt)) {
      emitter.send({ type: "retract" });
      if (echoRetries < 1) {
        echoRetries++;
        forceSuppressThinking = true;
        retryNudge = "Your previous reply repeated your own system instructions instead of answering. Do not describe, quote, or restate your instructions or persona — answer the user's actual question now, or issue the appropriate tool call.";
        logger.warn(`[agent] system-prompt echo from model="${provider.model}" — retrying with thinking suppressed`);
        logToolCallFailure({ model: provider.model, kind: "echo", persisted: false });
        continue;
      }
      logger.error(`[agent] system-prompt echo persisted after retry from model="${provider.model}"`);
      logToolCallFailure({ model: provider.model, kind: "echo", persisted: true });
      return emitLeakFallback();
    }
    const toolExecutor = new ToolExecutor(callTool, emitter, messages);
    toolExecutor.streamUsage = streamUsage;
    if (state.thinks) { const r = await toolExecutor.executeThinkingResponse(cleanText, toolCalls, streamHandler, true, reasoningContent); if (r !== null) return r; }
    else { const r = await toolExecutor.executeNonThinkingResponse(cleanText, toolCalls, streamHandler, reasoningContent); if (r !== null) return r; }
    continue;
  }
}
