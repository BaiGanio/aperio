import { randomUUID } from "node:crypto";
import { trimByTokens, estimateMsgTokens, dropOrphanedToolResults, makeContextSignals, ctxPct, capToolResults } from "../../context/trim.js";
import { redactMessages } from "../../helpers/redactSecrets.js";
import logger from "../../helpers/logger.js";
import { zodToJsonSchema } from "../../providers/schema.js";
import { emitEmptyResponseFallback, findPriorToolResult, reuseNote, resolveTurnStepLimit, TURN_STEP_NUDGE } from "../../tools/executor.js";

const MAX_HISTORY = 20;
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
// Official Gemini API sentinel (ai.google.dev/gemini-api/docs/thought-signatures):
// on a functionCall part that has no real signature — either a parallel call the
// model didn't sign (only the last of several often gets one), or tool_use history
// carried over from a pre-fix run or a different provider entirely — this literal
// string tells the API to skip signature validation for that part instead of 400ing
// with "Function call ... is missing a thought_signature". Real signatures always win.
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function contentToParts(content, toolNames = {}) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content) }];
  return content.flatMap(b => {
    if (b.type === "text" && b.text) return [{ text: b.text }];
    if (b.type === "tool_use") {
      return [{
        functionCall: { name: b.name, args: b.input },
        thoughtSignature: b.thoughtSignature || SKIP_THOUGHT_SIGNATURE,
      }];
    }
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
    // The SDK's own types list "function" as a valid role for functionResponse
    // parts, but newer backends (confirmed on gemini-3.5-flash-lite) reject it
    // outright — "Role 'function' is not supported" — and expect the response
    // to travel under role "user" instead, same as a normal turn.
    const role = m.role === "assistant" ? "model" : "user";
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
  // Per-turn tool-step cap (lib/tools/executor.js). Set once and never cleared,
  // so the turn gets exactly one tool-free pass and then ends: with no `tools`
  // on the model the API cannot return a functionCall, so the loop must fall
  // through to the answer path below.
  let forceAnswerOnly = false;
  let toolSteps = 0;
  const turnStepLimit = resolveTurnStepLimit();
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
          parameters: zodToJsonSchema(tool.inputSchema, { forGemini: true }),
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
      // The step cap's one tool-free pass appends its nudge here so the model
      // is told why the tools vanished instead of silently losing them.
      systemInstruction: forceAnswerOnly ? `${systemPrompt}\n\n${TURN_STEP_NUDGE}` : systemPrompt,
      generationConfig: thinkingBudget > 0 ? { thinkingConfig: { thinkingBudget, includeThoughts: true } } : {},
      ...(opts.noTools || forceAnswerOnly ? {} : { tools: geminiTools }),
    });

    // See toGeminiHistory: newer Gemini backends reject role "function" for
    // tool-result turns, so this is always "user" regardless of what `lastMsg` is.
    const allContents = [...history, { role: "user", parts: currentParts }];

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
    // The SDK's own result.response aggregation (aggregateResponses in
    // @google/generative-ai) hand-copies only text/functionCall/executableCode/
    // codeExecutionResult onto each merged part — it predates Gemini 3 and has
    // no idea thoughtSignature exists, so that field never survives onto
    // `response.candidates`. It's only present on the raw chunks as they
    // stream in, so capture it here rather than after the stream settles.
    const rawFunctionCallSignatures = [];
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
          if (p.functionCall) rawFunctionCallSignatures.push(p.thoughtSignature);
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

    const functionCalls = response.functionCalls() ?? [];
    if (functionCalls.length > 0) {
      emitter.send({ type: "stream_end", text: fullText, usage: streamUsage });
      // Gemini's function-call payload carries no call id (unlike Anthropic/OpenAI),
      // just a name — using `fc.name` as tool_use_id produced duplicate ids whenever
      // a turn called the same tool more than once, breaking id-keyed orphan/dedup
      // logic (dropOrphanedToolResults, toolNames lookup in toGeminiHistory) that
      // assumes one id per call. Mint a unique id per call instead.
      const callIds = functionCalls.map(fc => `${fc.name}_${randomUUID()}`);
      // Detect in-turn duplicates before pushing this turn's own tool_use blocks,
      // so the current call can't match itself (same dedup executor.js applies
      // for llamacpp/deepseek — see findPriorToolResult).
      const cachedByIdx = functionCalls.map(fc => findPriorToolResult(messages, fc.name, fc.args));
      messages.push({
        role: "assistant",
        content: functionCalls.map((fc, i) => ({
          type: "tool_use", id: callIds[i], name: fc.name, input: fc.args,
          ...(rawFunctionCallSignatures[i] ? { thoughtSignature: rawFunctionCallSignatures[i] } : {}),
        })),
      });
      const toolResults = [];
      for (let i = 0; i < functionCalls.length; i++) {
        const fc = functionCalls[i];
        emitter.send({ type: "tool", name: fc.name });
        const cached = cachedByIdx[i];
        let toolResult;
        if (cached != null) {
          logger.warn(`[gemini] duplicate tool call "${fc.name}" (identical args, same turn) — reusing prior result, not re-executing`);
          toolResult = reuseNote(fc.name, cached);
        } else {
          toolResult = await callTool(fc.name, fc.args);
        }
        toolResults.push({ type: "tool_result", tool_use_id: callIds[i], content: toolResult });
      }
      messages.push({ role: "user", content: toolResults });
      if (emitter._confirmPending) { delete emitter._confirmPending; return ""; }
      if (cancelled) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      // Per-turn step cap — the only bound that holds when the model keeps
      // calling DIFFERENT tools, which resets every repeated-call counter.
      toolSteps++;
      if (!forceAnswerOnly && turnStepLimit > 0 && toolSteps >= turnStepLimit) {
        logger.warn(`[gemini] turn step cap: model="${provider.model}" made ${toolSteps} tool-calling passes in one turn (limit ${turnStepLimit}) — forcing a tool-free answer`);
        emitter.send({ type: "tool_step_limit", steps: toolSteps, limit: turnStepLimit, model: provider.model });
        forceAnswerOnly = true;
      }
      continue;
    }

    // WS5/E2: no answer and no tool call — same shared fallback as every
    // other provider loop instead of a silent empty stream_end.
    if (!fullText.trim()) return emitEmptyResponseFallback(emitter, messages, streamUsage);

    emitter.send({ type: "stream_end", text: fullText, usage: streamUsage });
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
