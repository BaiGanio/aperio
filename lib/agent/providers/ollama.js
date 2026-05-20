import { OllamaStreamHandler } from "../../streaming/ollamaHandler.js";
import { ToolExecutor } from "../../tools/executor.js";
import { CTX_WARN_TARGET, estimateMsgTokens, trimByTokens, dropOrphanedToolResults } from "../../context/trim.js";
import logger from "../../helpers/logger.js";
import { bridgeImagesToVLM } from "../../helpers/imageBridge.js";

const MAX_HISTORY = 20;
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
const HEALTH_CHECK_TIMEOUT = parseInt(process.env.OLLAMA_HEALTH_TIMEOUT_MS || "3000", 10);
const FETCH_TIMEOUT = parseInt(process.env.OLLAMA_FETCH_TIMEOUT_MS || "120000", 10);

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

async function makeOllamaRequest(provider, ollamaTools, openaiMessages, noTools, setAbort) {
  const controller = new AbortController(); setAbort(controller);
  const timeoutController = new AbortController(); const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(`${provider.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
      body: JSON.stringify({ model: provider.model, messages: openaiMessages, stream_options: { include_usage: true }, ...(noTools ? {} : { tools: ollamaTools }), stream: true }),
      signal: AbortSignal.any([controller.signal, timeoutController.signal]),
    });
    clearTimeout(timeoutId); return response;
  } catch (e) { clearTimeout(timeoutId); throw e; }
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
      const content = images.length > 0 ? [{ type: "text", text: text || "" }, ...images] : (text || null);
      const tcs = m.content.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      return [{ role: m.role, content, ...(tcs.length ? { tool_calls: tcs } : {}), ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) }];
    }
    return [{ role: m.role, content: m.content, ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) }];
  })];
}

export async function runOllamaLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}, ctx) {
  const { provider, callTool, getSystemPrompt, getOllamaTools, reasoningAdapter, state } = ctx;

  // ── Local VLM image bridge ──────────────────────────────────────────────
  // Ollama text-only models cannot see images natively. Before the first API
  // call, describe every user-attached image via a local Ollama VLM and
  // replace the raw image blocks with the resulting text.
  await bridgeImagesToVLM(messages, callTool, emitter);

  let tokenHWM = 0;
  let streamUsage = zeroUsage();
  while (true) {
    tokenHWM = Math.max(tokenHWM, streamUsage.input_tokens);
    streamUsage = zeroUsage();
    if (getAbort()?.signal?.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
    const hwm = tokenHWM > 0 ? tokenHWM : messages.reduce((s, m) => s + estimateMsgTokens(m), 0);
    const pct = Math.round((hwm / provider.contextWindow) * 100);
    if (pct >= Math.round(CTX_WARN_TARGET * 100) && pct < Math.round(0.75 * 100)) emitter.send({ type: "context_warning", pct });
    const { messages: rawMessages, dropped } = trimByTokens(messages, hwm, provider.contextWindow);
    const safeRaw = dropped === 0 && rawMessages.length > MAX_HISTORY ? [rawMessages[0], ...rawMessages.slice(-(MAX_HISTORY - 1))] : rawMessages;
    if (dropped > 0) { logger.info(`[agent] context trimmed: dropped ${dropped} messages at ${pct}% pressure`); emitter.send({ type: "context_trimmed", dropped, pct }); }
    const trimmed = dropOrphanedToolResults(safeRaw);
    const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user");
    const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
    const systemPrompt = getSystemPrompt(lastUserText, opts.lang, opts.extraSystem, messages);
    const openaiMessages = toOpenAIMessages(trimmed, systemPrompt, provider.vision);
    const healthy = await checkOllamaHealth(provider, emitter, setAbort);
    if (!healthy) return "Ollama is not running";
    const ollamaTools = getOllamaTools(lastUserText, messages);
    let response;
    try { response = await makeOllamaRequest(provider, ollamaTools, openaiMessages, state.noTools || opts.noTools, setAbort); }
    catch (e) {
      const errorMsg = e.name === "AbortError" ? "Request timeout" : e.message;
      if (e.name !== "AbortError") logger.error(`[ollama] request failed: ${errorMsg}`, { model: provider.model });
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + errorMsg }); emitter.send({ type: "stream_end", text: errorMsg, usage: streamUsage }); return errorMsg;
    }
    if (!response.ok) {
      const err = await response.text();
      const label = provider.name === "ollama" ? "Ollama" : provider.name === "gemini" ? "Gemini" : provider.name === "deepseek" ? "DeepSeek" : provider.name;
      logger.error(`[ollama] ${label} API error (${response.status}): ${err.slice(0, 200)}`);
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: `⚠️ ${label} error: ` + err }); emitter.send({ type: "stream_end", text: err, usage: streamUsage }); return err;
    }
    const streamHandler = new OllamaStreamHandler(response, emitter, reasoningAdapter, callTool, provider);
    const { cleanText, toolCalls, reasoningContent } = await streamHandler.process();
    streamUsage = streamHandler.streamUsage;
    if (streamUsage.thinking_tokens === 0 && reasoningContent) streamUsage.thinking_tokens = Math.max(1, Math.ceil(reasoningContent.length / 4));
    if (streamHandler.detectedThinking && !state.thinks) { state.thinks = true; logger.info(`[agent] thinking auto-detected for model="${provider.model}"`); }
    const toolExecutor = new ToolExecutor(callTool, emitter, messages);
    toolExecutor.streamUsage = streamUsage;
    if (state.thinks) { const r = await toolExecutor.executeThinkingResponse(cleanText, toolCalls, streamHandler, true, reasoningContent); if (r !== null) return r; }
    else { const r = await toolExecutor.executeNonThinkingResponse(cleanText, toolCalls, streamHandler, reasoningContent); if (r !== null) return r; }
    continue;
  }
}