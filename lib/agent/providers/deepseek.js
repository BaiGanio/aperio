import { OllamaStreamHandler } from "../../streaming/ollamaHandler.js";
import { ToolExecutor } from "../../tools/executor.js";
import { estimateMsgTokens, trimByTokens, dropOrphanedToolResults, makeContextSignals, ctxPct } from "../../context/trim.js";
import logger from "../../helpers/logger.js";
import { bridgeImagesToVLM } from "../../helpers/imageBridge.js";

const MAX_HISTORY = 20;
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
const FETCH_TIMEOUT = parseInt(process.env.DEEPSEEK_FETCH_TIMEOUT_MS || "120000", 10);

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
  } catch (e) { clearTimeout(timeoutId); throw e; }
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
      const images = vision === false ? [] : m.content.filter(b => b.type === "image").map(b => ({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }));
      const tcs = m.content.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      const content = images.length > 0 ? [{ type: "text", text: text || "" }, ...images] : (text || null);
      return [{ role: m.role, content, ...(tcs.length ? { tool_calls: tcs } : {}), ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) }];
    }
    return [{ role: m.role, content: m.content, ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) }];
  })];
}

export async function runDeepSeekLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}, ctx) {
  const { provider, callTool, getSystemPrompt, getOllamaTools, reasoningAdapter, state } = ctx;

  // ── DeepSeek V4 image bridge ─────────────────────────────────────────────
  // V4 models cannot see images natively. Before the first API call,
  // describe every user-attached image via a local Ollama VLM and
  // replace the raw image blocks with the resulting text.
  if (/deepseek-v4/i.test(provider.model)) {
    await bridgeImagesToVLM(messages, callTool, emitter);
  }

  let tokenHWM = 0;
  let streamUsage = zeroUsage();
  const ctxSignals = makeContextSignals();
  while (true) {
    tokenHWM = Math.max(tokenHWM, streamUsage.input_tokens);
    streamUsage = zeroUsage();
    if (getAbort()?.signal?.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
    const hwm = tokenHWM > 0 ? tokenHWM : messages.reduce((s, m) => s + estimateMsgTokens(m), 0);
    const pct = ctxPct(hwm, provider.contextWindow);
    ctxSignals.emit(emitter, hwm, provider.contextWindow);
    const { messages: rawMessages, dropped } = trimByTokens(messages, hwm, provider.contextWindow);
    const safeRaw = dropped === 0 && rawMessages.length > MAX_HISTORY ? [rawMessages[0], ...rawMessages.slice(-(MAX_HISTORY - 1))] : rawMessages;
    if (dropped > 0) { logger.info(`[agent] deepseek context trimmed: dropped ${dropped} messages at ${pct}% pressure`); emitter.send({ type: "context_trimmed", dropped, pct }); }
    const trimmed = dropOrphanedToolResults(safeRaw);
    const lastUserMsg = [...trimmed].reverse().find(m => m.role === "user");
    const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
    const systemPrompt = getSystemPrompt(lastUserText, opts.lang, opts.extraSystem, messages);
    const openaiMessages = toOpenAIMessages(trimmed, systemPrompt, provider.vision);
    const deepseekTools = getOllamaTools(lastUserText, messages);
    let response;
    const thinkingMode = /deepseek-v4/i.test(provider.model) ? (state.thinks ? "thinking" : "non-thinking") : null;
    try { response = await makeDeepSeekRequest(provider, deepseekTools, openaiMessages, state.noTools || opts.noTools, setAbort, thinkingMode); }
    catch (e) {
      const errorMsg = e.name === "AbortError" ? "Request timeout" : e.message;
      if (e.name !== "AbortError") logger.error(`[deepseek] request failed: ${errorMsg}`, { model: provider.model });
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ " + errorMsg }); emitter.send({ type: "stream_end", text: errorMsg, usage: streamUsage }); return errorMsg;
    }
    if (!response.ok) {
      const err = await response.text();
      if (isImageError(err)) {
        logger.warn(`[agent] DeepSeek rejected image content (model=${provider.model}) — retrying text-only. Vision is not available via this API configuration.`);
        emitter.send({ type: "stream_start" });
        emitter.send({ type: "token", text: `> ⚠️ **Vision not available** — \`${provider.model}\` does not accept image content via this API. Responding based on the text description only.\n\n` });
        try { response = await makeDeepSeekRequest(provider, deepseekTools, stripImages(openaiMessages), state.noTools || opts.noTools, setAbort, thinkingMode); }
        catch (e2) {
          const errorMsg = e2.name === "AbortError" ? "Request timeout" : e2.message;
          if (e2.name !== "AbortError") logger.error(`[deepseek] image-retry request failed: ${errorMsg}`, { model: provider.model });
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