import { encode } from "gpt-tokenizer";
import { validateOutputSafe } from "../../helpers/validateOutput.js";
import { estimateMsgTokens, trimByTokens, dropOrphanedToolResults, makeContextSignals, ctxPct, capToolResults } from "../../context/trim.js";
import { redactMessages } from "../../helpers/redactSecrets.js";
import logger from "../../helpers/logger.js";
import { emitEmptyResponseFallback } from "../../tools/executor.js";

const MAX_HISTORY = 20;
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

export async function runAnthropicLoop(messages, emitter, opts = {}, getAbort = () => null, setAbort = () => {}, ctx) {
  const { provider, callTool, getSystemPrompt, getAnthropicTools, prepareModelContext, state } = ctx;
  let tokenHWM = 0;
  let streamUsage = zeroUsage();
  const ctxSignals = makeContextSignals();
  // WS4/D1: extended thinking, gated by ANTHROPIC_THINKING_BUDGET (default 0 = off
  // — thinking tokens are billed output, see plan Risks). Read live (not a
  // module-level constant like GEMINI_THINKING_BUDGET) so it can change without a
  // process restart and so tests can toggle it per-case.
  const thinkingBudget = parseInt(process.env.ANTHROPIC_THINKING_BUDGET ?? "0", 10) || 0;
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
    let trimmed, systemPrompt, tools;
    if (prepareModelContext) {
      const prepared = await prepareModelContext({
        messages,
        observedInputTokens: tokenHWM,
        lang: opts.lang,
        extraSystem: opts.extraSystem,
        providerLabel: "anthropic",
      });
      trimmed = prepared.messages;
      systemPrompt = prepared.systemPrompt;
      tools = prepared.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    } else {
      const capped = capToolResults(messages, provider.contextWindow);
      const hwm = tokenHWM > 0 ? tokenHWM : capped.reduce((s, m) => s + estimateMsgTokens(m), 0);
      const pct = ctxPct(hwm, provider.contextWindow);
      ctxSignals.emit(emitter, hwm, provider.contextWindow);
      const { messages: raw, dropped } = trimByTokens(capped, hwm, provider.contextWindow);
      if (dropped > 0) { logger.info(`[agent] anthropic context trimmed: dropped ${dropped} messages at ${pct}% pressure`); emitter.send({ type: "context_trimmed", dropped, pct }); }
      const safe = dropped === 0 && raw.length > MAX_HISTORY ? [raw[0], ...raw.slice(-(MAX_HISTORY - 1))] : raw;
      // Trimming can orphan a tool_result from its matching tool_use.
      trimmed = dropOrphanedToolResults(safe);
      const lastUserMsg = [...trimmed].reverse().find(m =>
        m.role === "user" && (typeof m.content === "string" || (Array.isArray(m.content) && m.content.some(b => b.type === "text")))
      );
      const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
      systemPrompt = getSystemPrompt(lastUserText, opts.lang, opts.extraSystem, trimmed);
      tools = getAnthropicTools(lastUserText, trimmed);
    }
    if (cancelled) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
    let fullText = "", toolUses = [], currentToolUse = null, currentThinkingBlock = null, inputJson = "", stopReason = null, contentBlocks = [];
    // null = the API never reported a breakdown this turn (thinking off, or an
    // older account) — keep the diff-estimate fallback below. Any non-null value,
    // including 0, means we saw the real field and must trust it (D2).
    let realThinkingTokens = null;
    let stream;
    try {
      // PRIVACY-01: scrub secrets from the outgoing (derived) array; the
      // persistent `messages` history is left intact.
      // budget_tokens must be < max_tokens (SDK requirement, min budget 1024) —
      // grow max_tokens to leave headroom for the visible answer beyond it.
      const maxTokens = thinkingBudget > 0 ? thinkingBudget + 8192 : 8192;
      stream = provider.client.messages.stream({
        model: provider.model, max_tokens: maxTokens, system: systemPrompt, tools, messages: redactMessages(trimmed),
        ...(thinkingBudget > 0 ? { thinking: { type: "enabled", budget_tokens: thinkingBudget } } : {}),
      }, { signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      const errorMsg = e.message ?? String(e);
      logger.error("[anthropic] failed to open stream:", e);
      emitter.send({ type: "stream_start" });
      emitter.send({ type: "token", text: "⚠️ " + errorMsg });
      emitter.send({ type: "stream_end", text: errorMsg, usage: streamUsage });
      return errorMsg;
    }
    emitter.send({ type: "stream_start" });
    try {
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "text") contentBlocks.push({ type: "text", text: "" });
          else if (event.content_block.type === "thinking") {
            // Signature accumulates via signature_delta below and must ride back
            // with the block on the next request — required by the API to
            // validate a thinking block that precedes tool_use in the same turn.
            currentThinkingBlock = { type: "thinking", thinking: "", signature: "" };
            contentBlocks.push(currentThinkingBlock);
            emitter.send({ type: "reasoning_start" });
          }
          else if (event.content_block.type === "redacted_thinking") {
            // Delivered whole here — opaque `data`, no subsequent deltas. Must
            // be replayed verbatim on the next request or Anthropic rejects a
            // tool-use turn that followed it (P1 review fix).
            currentThinkingBlock = { type: "redacted_thinking", data: event.content_block.data };
            contentBlocks.push(currentThinkingBlock);
            emitter.send({ type: "reasoning_start" });
          }
          else if (event.content_block.type === "tool_use") {
            currentToolUse = { type: "tool_use", id: event.content_block.id, name: event.content_block.name, input: {} };
            inputJson = ""; contentBlocks.push(currentToolUse); emitter.send({ type: "tool", name: event.content_block.name });
          }
        }
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") { fullText += event.delta.text; emitter.send({ type: "token", text: event.delta.text }); const last = contentBlocks[contentBlocks.length - 1]; if (last?.type === "text") last.text += event.delta.text; }
          else if (event.delta.type === "input_json_delta") inputJson += event.delta.partial_json;
          else if (event.delta.type === "thinking_delta") {
            // Adaptive-thinking turns can carry an empty string here (verified
            // live via the claude-agent-sdk, which shares this exact event
            // shape) — still accumulate it for replay, just skip the no-op
            // emit. Never fires for a redacted_thinking block (delivered whole,
            // no deltas) — guarded anyway so it can't corrupt `.data`.
            if (currentThinkingBlock?.type === "thinking") currentThinkingBlock.thinking += event.delta.thinking;
            if (event.delta.thinking) emitter.send({ type: "reasoning_token", text: event.delta.thinking });
          }
          else if (event.delta.type === "signature_delta") {
            if (currentThinkingBlock?.type === "thinking") currentThinkingBlock.signature += event.delta.signature;
          }
        }
        if (event.type === "content_block_stop") {
          if (currentToolUse) { try { currentToolUse.input = JSON.parse(inputJson || "{}"); } catch {} toolUses.push({ ...currentToolUse }); currentToolUse = null; inputJson = ""; }
          else if (currentThinkingBlock) { emitter.send({ type: "reasoning_done" }); currentThinkingBlock = null; }
        }
        if (event.type === "message_start") {
          streamUsage = { input_tokens: event.message.usage.input_tokens ?? 0, output_tokens: event.message.usage.output_tokens ?? 0, thinking_tokens: 0 };
          if (event.message.usage.output_tokens_details) realThinkingTokens = event.message.usage.output_tokens_details.thinking_tokens ?? 0;
        }
        if (event.type === "message_delta") {
          stopReason = event.delta.stop_reason;
          if (event.usage) {
            streamUsage.output_tokens = event.usage.output_tokens ?? streamUsage.output_tokens;
            if (event.usage.output_tokens_details) realThinkingTokens = event.usage.output_tokens_details.thinking_tokens ?? 0;
          }
        }
      }
    } catch (e) {
      if (controller.signal.aborted) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      const errorMsg = e.message ?? String(e);
      logger.error("[anthropic] stream error:", e);
      emitter.send({ type: "token", text: "⚠️ " + errorMsg });
      emitter.send({ type: "stream_end", text: errorMsg, usage: streamUsage });
      return errorMsg;
    }
    const validatedText = validateOutputSafe(fullText, "anthropic");
    streamUsage.thinking_tokens = realThinkingTokens != null
      ? realThinkingTokens
      : Math.max(0, streamUsage.output_tokens - encode(validatedText).length);
    const textBlock = contentBlocks.find(b => b.type === "text");
    if (textBlock) textBlock.text = validatedText;

    if (stopReason === "tool_use" && toolUses.length > 0) {
      emitter.send({ type: "stream_end", text: validatedText, usage: streamUsage });
      messages.push({ role: "assistant", content: contentBlocks });
      const toolResults = [];
      for (const tool of toolUses) toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: await callTool(tool.name, tool.input) });
      messages.push({ role: "user", content: toolResults });
      if (emitter._confirmPending) { delete emitter._confirmPending; return ""; }
      if (cancelled) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      continue;
    }

    // WS5/E2: no answer and no tool call — same shared fallback as every
    // other provider loop instead of a silent empty stream_end.
    if (!validatedText.trim()) return emitEmptyResponseFallback(emitter, messages, streamUsage);

    emitter.send({ type: "stream_end", text: validatedText, usage: streamUsage });
    messages.push({ role: "assistant", content: contentBlocks });
    return validatedText;
  }
}
