import { randomUUID } from "node:crypto";
import { trimByTokens, estimateMsgTokens, dropOrphanedToolResults, makeContextSignals, ctxPct, capToolResults } from "../../context/trim.js";
import { redactMessages } from "../../helpers/redactSecrets.js";
import logger from "../../helpers/logger.js";
import { zodToJsonSchema } from "../../providers/schema.js";

const MAX_HISTORY = 20;
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

function contentToParts(content, toolNames = {}) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content) }];
  return content.flatMap(b => {
    if (b.type === "text" && b.text) return [{ text: b.text }];
    if (b.type === "tool_use") return [{ functionCall: { name: b.name, args: b.input } }];
    if (b.type === "tool_result") {
      const toolName = toolNames[b.tool_use_id] || b.tool_use_id;
      if (Array.isArray(b.content)) {
        const textPart = b.content.find(c => c.type === "text")?.text ?? "";
        const imgParts = b.content.filter(c => c.type === "image").map(c => ({ inlineData: { mimeType: c.source.media_type, data: c.source.data } }));
        return [{ functionResponse: { name: toolName, response: { result: textPart || "Image provided" } } }, ...imgParts];
      }
      return [{ functionResponse: { name: toolName, response: { result: b.content } } }];
    }
    if (b.type === "image") return [{ inlineData: { mimeType: b.source.media_type, data: b.source.data } }];
    return [];
  });
}

function toGeminiHistory(messages) {
  const toolNames = {};
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) { if (b.type === "tool_use") toolNames[b.id] = b.name; }
    }
  }
  return messages.map(m => {
    const parts = contentToParts(m.content, toolNames);
    const hasFunctionResponse = parts.some(p => "functionResponse" in p);
    const role = m.role === "assistant" ? "model" : hasFunctionResponse ? "function" : "user";
    return { role, parts };
  });
}

export async function runGeminiLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}, ctx) {
  const { provider, callTool, getSystemPrompt, getGeminiTools, prepareModelContext, state } = ctx;
  let tokenHWM = 0;
  let streamUsage = zeroUsage();
  const ctxSignals = makeContextSignals();
  // Read live (not a frozen module-level constant) so it can change without a
  // process restart and so tests can toggle it per-case (WS4/D1).
  const thinkingBudget = parseInt(process.env.GEMINI_THINKING_BUDGET ?? "0", 10) || 0;
  if (thinkingBudget > 0 && state) state.thinks = true;
  // wsHandler nulls out its abortController closure the instant it processes
  // a "stop" message, so getAbort() can no longer see it once that happens —
  // a Stop pressed while we're awaiting prepareModelContext/callTool (i.e.
  // between model requests, with no fetch/stream currently listening on the
  // signal) would otherwise be silently lost and a follow-up request would
  // fire anyway. Latch our own copy the moment the registered controller is
  // aborted, independent of wsHandler forgetting its reference.
  let cancelled = false;
  while (true) {
    tokenHWM = Math.max(tokenHWM, streamUsage.input_tokens);
    streamUsage = zeroUsage();
    if (cancelled || getAbort()?.signal?.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => { cancelled = true; });
    setAbort(controller);
    let trimmed, systemPrompt, geminiTools;
    if (prepareModelContext) {
      const prepared = await prepareModelContext({
        messages,
        observedInputTokens: tokenHWM,
        lang: opts.lang,
        extraSystem: opts.extraSystem,
        providerLabel: "gemini",
        userTextRole: "any",
      });
      trimmed = prepared.messages;
      systemPrompt = prepared.systemPrompt;
      geminiTools = [{
        functionDeclarations: prepared.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: zodToJsonSchema(tool.inputSchema),
        })),
      }];
    } else {
      const capped = capToolResults(messages, provider.contextWindow);
      const hwm = tokenHWM > 0 ? tokenHWM : capped.reduce((s, m) => s + estimateMsgTokens(m), 0);
      const pct = ctxPct(hwm, provider.contextWindow);
      ctxSignals.emit(emitter, hwm, provider.contextWindow);
      const { messages: raw, dropped } = trimByTokens(capped, hwm, provider.contextWindow);
      if (dropped > 0) { logger.info(`[agent] gemini context trimmed: dropped ${dropped} messages at ${pct}% pressure`); emitter.send({ type: "context_trimmed", dropped, pct }); }
      const safe = dropped === 0 && raw.length > MAX_HISTORY ? [raw[0], ...raw.slice(-(MAX_HISTORY - 1))] : raw;
      trimmed = dropOrphanedToolResults(safe);
      const lastTextMsg = [...trimmed].reverse().find(m =>
        typeof m.content === "string" || (Array.isArray(m.content) && m.content.some(b => b.type === "text"))
      );
      const lastUserText = typeof lastTextMsg?.content === "string" ? lastTextMsg.content : lastTextMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
      systemPrompt = getSystemPrompt(lastUserText, opts.lang, opts.extraSystem, trimmed);
      geminiTools = getGeminiTools(lastUserText, trimmed);
    }
    if (cancelled) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
    const lastMsg = trimmed[trimmed.length - 1];

    // PRIVACY-01: scrub secrets from the outgoing (derived) content.
    const history = toGeminiHistory(redactMessages(trimmed.slice(0, -1)));
    const redactedLast = redactMessages([lastMsg])[0];
    const currentParts = contentToParts(redactedLast?.content ?? "", buildToolNameMap(trimmed));

    const geminiModel = provider.client.getGenerativeModel({
      model: provider.model,
      systemInstruction: systemPrompt,
      generationConfig: thinkingBudget > 0 ? { thinkingConfig: { thinkingBudget, includeThoughts: true } } : {},
      ...(opts.noTools ? {} : { tools: geminiTools }),
    });

    const lastMsgIsToolResult = Array.isArray(lastMsg?.content) && lastMsg.content.some(b => b.type === "tool_result");
    const currentRole = lastMsgIsToolResult ? "function" : "user";
    const allContents = [...history, { role: currentRole, parts: currentParts }];

    let result;
    try {
      result = await geminiModel.generateContentStream({ contents: allContents }, { signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      const msg = e.message ?? String(e);
      logger.error(`[gemini] generateContentStream failed: ${msg}`, { model: provider.model });
      emitter.send({ type: "stream_start" }); emitter.send({ type: "token", text: "⚠️ Gemini error: " + msg }); emitter.send({ type: "stream_end", text: msg, usage: streamUsage });
      return msg;
    }

    // The SDK derives `stream` and `response` from a single tee()'d source
    // (see @google/generative-ai's processStream/getResponseStream): if the
    // underlying fetch reader fails mid-read, both branches reject
    // independently with an equivalent error. We only reach `await
    // result.response` below after the `for await` loop over `result.stream`
    // finishes — if the stream throws first, `result.response` is left a
    // rejected promise nobody ever attaches a handler to, which Node reports
    // as an unhandled rejection (and can trip the crash breaker after enough
    // of them). Prime it now so it's always handled; the real value/error is
    // still consumed via the `await result.response` below.
    try { result.response?.catch?.(() => {}); } catch { /* accessing .response itself threw; nothing to prime */ }

    emitter.send({ type: "stream_start" });
    let fullText = "";
    // Thought-summary parts (`part.thought === true`, verified live against the
    // real API — untyped in this SDK version) always precede the answer's text
    // parts within a turn; reasoning_done fires the moment a non-thought part
    // arrives, never after (D1 ordering).
    let reasoningOpen = false;
    try {
      for await (const chunk of result.stream) {
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) {
          if (p.thought) {
            if (!reasoningOpen) { reasoningOpen = true; emitter.send({ type: "reasoning_start" }); }
            if (p.text) emitter.send({ type: "reasoning_token", text: p.text });
            continue;
          }
          if (reasoningOpen) { emitter.send({ type: "reasoning_done" }); reasoningOpen = false; }
          if (p.text) { fullText += p.text; emitter.send({ type: "token", text: p.text }); }
        }
      }
      if (reasoningOpen) { emitter.send({ type: "reasoning_done" }); reasoningOpen = false; }
    } catch (e) {
      if (controller.signal.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      const msg = e.message ?? String(e);
      logger.error(`[gemini] stream read failed: ${msg}`, { model: provider.model });
      emitter.send({ type: "token", text: "⚠️ Gemini error: " + msg }); emitter.send({ type: "stream_end", text: fullText || msg, usage: streamUsage });
      return msg;
    }

    let response;
    try { response = await result.response; } catch (e) {
      if (controller.signal.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      const msg = e.message ?? String(e);
      logger.error(`[gemini] result.response failed: ${msg}`, { model: provider.model });
      emitter.send({ type: "stream_end", text: fullText || msg, usage: streamUsage }); return msg;
    }

    const thinkTok = response.usageMetadata?.thoughtsTokenCount ?? 0;
    streamUsage = {
      input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: (response.usageMetadata?.candidatesTokenCount ?? 0) + thinkTok,
      thinking_tokens: thinkTok,
    };
    emitter.send({ type: "stream_end", text: fullText, usage: streamUsage });

    const functionCalls = response.functionCalls() ?? [];
    if (functionCalls.length > 0) {
      // Gemini's function-call payload carries no call id (unlike Anthropic/OpenAI),
      // just a name — using `fc.name` as tool_use_id produced duplicate ids whenever
      // a turn called the same tool more than once, breaking id-keyed orphan/dedup
      // logic (dropOrphanedToolResults, toolNames lookup in toGeminiHistory) that
      // assumes one id per call. Mint a unique id per call instead.
      const callIds = functionCalls.map(fc => `${fc.name}_${randomUUID()}`);
      messages.push({ role: "assistant", content: functionCalls.map((fc, i) => ({ type: "tool_use", id: callIds[i], name: fc.name, input: fc.args })) });
      const toolResults = [];
      for (let i = 0; i < functionCalls.length; i++) {
        const fc = functionCalls[i];
        emitter.send({ type: "tool", name: fc.name });
        const toolResult = await callTool(fc.name, fc.args);
        toolResults.push({ type: "tool_result", tool_use_id: callIds[i], content: toolResult });
      }
      messages.push({ role: "user", content: toolResults });
      if (emitter._confirmPending) { delete emitter._confirmPending; return ""; }
      if (cancelled) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      continue;
    }

    messages.push({ role: "assistant", content: fullText });
    return fullText;
  }
}

function buildToolNameMap(messages) {
  const map = {};
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) { if (b.type === "tool_use") map[b.id] = b.name; }
    }
  }
  return map;
}
