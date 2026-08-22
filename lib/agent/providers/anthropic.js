import { encode } from "gpt-tokenizer";
import { validateOutputSafe } from "../../helpers/validateOutput.js";
import { estimateMsgTokens, trimByTokens, dropOrphanedToolResults, makeContextSignals, ctxPct, capToolResults } from "../../context/trim.js";
import { redactMessages } from "../../helpers/redactSecrets.js";
import logger from "../../helpers/logger.js";
import { emitEmptyResponseFallback, findPriorToolResult, reuseNote, resolveTurnStepLimit, TURN_STEP_NUDGE } from "../../tools/executor.js";

const MAX_HISTORY = 20;
const zeroUsage = () => ({
  input_tokens: 0, output_tokens: 0, thinking_tokens: 0,
  cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
});

// #290 — prompt-cache breakpoints. Anthropic renders a request as
// tools → system → messages and caches by exact-prefix match, so:
//   • a breakpoint on the system block caches the tool schemas *and* the
//     system prompt together (tools sit in front of it);
//   • a second one on the most recent markable message block extends the
//     cached span over the conversation so far.
// Two of the four breakpoints a request may carry. The reliable win is the
// tool-use loop below — tools, system prompt and the growing history are
// re-sent on every iteration of the same turn and that prefix is byte-identical
// each time. Across turns it also hits whenever the turn resolves the same
// skills/tools (the tool list renders first, so a different tool set
// invalidates everything behind it no matter where the breakpoints are).
const CACHE_BREAKPOINT = { type: "ephemeral" };
// Block types Anthropic accepts `cache_control` on. Deliberately excludes
// thinking/redacted_thinking — the last block is a user turn in practice, and
// a marker on a block the API doesn't allow it on is a 400 for the whole turn.
const CACHEABLE_BLOCKS = new Set(["text", "image", "tool_use", "tool_result", "document"]);

function withSystemBreakpoint(systemPrompt) {
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) return systemPrompt;
  return [{ type: "text", text: systemPrompt, cache_control: CACHE_BREAKPOINT }];
}

// How far back to look for a message that can carry the breakpoint. The last
// message is a tool_result turn (block array — markable) throughout the
// tool-use loop; in a plain chat it's the user's new line, which arrives as a
// bare string, so we fall back to the assistant turn behind it and let that
// one line trail outside the cached span.
const BREAKPOINT_LOOKBACK = 2;

// Copy-on-write: the marked message is a fresh object so the persistent
// `messages` history never grows a cache_control field.
//
// Only ever *adds* a `cache_control` key — never reshapes content. Converting a
// string content to a text block to hold the marker would make that message's
// wire shape differ between the request that marks it and the next one (where
// the marker has moved on), and only Anthropic can say whether the two
// normalize to the same cached bytes. `cache_control` itself is a marker rather
// than content, so a moving breakpoint over unchanged blocks is the documented
// multi-turn pattern and keeps earlier entries readable.
function withMessageBreakpoint(msgs) {
  const floor = Math.max(0, msgs.length - BREAKPOINT_LOOKBACK);
  for (let m = msgs.length - 1; m >= floor; m--) {
    const msg = msgs[m];
    if (!Array.isArray(msg?.content) || msg.content.length === 0) continue;
    const i = msg.content.length - 1;
    if (!CACHEABLE_BLOCKS.has(msg.content[i]?.type)) continue;
    const content = [...msg.content];
    content[i] = { ...content[i], cache_control: CACHE_BREAKPOINT };
    return [...msgs.slice(0, m), { ...msg, content }, ...msgs.slice(m + 1)];
  }
  return msgs;
}

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
  // Per-turn tool-step cap (lib/tools/executor.js). Set once and never cleared,
  // so the turn gets exactly one tool-free pass and then ends: with no `tools`
  // in the request the API cannot return a tool_use block, so the loop must fall
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
    // The step cap's one tool-free pass. Withdrawing the tools invalidates the
    // prompt cache for this request (tools render in front of the system block,
    // see the breakpoint notes above) — a one-off cost on a turn that has
    // already spent far more than that going round the loop.
    if (forceAnswerOnly) {
      tools = undefined;
      systemPrompt = `${systemPrompt}\n\n${TURN_STEP_NUDGE}`;
    }
    if (cancelled) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
    let fullText = "", toolUses = [], currentToolUse = null, currentThinkingBlock = null, inputJson = "", stopReason = null, contentBlocks = [];
    // null = the API never reported a breakdown this turn (thinking off, or an
    // older account) — keep the diff-estimate fallback below. Any non-null value,
    // including 0, means we saw the real field and must trust it (D2).
    let realThinkingTokens = null;
    // Prompt-token accounting (#290). Once caching is live the API's
    // `input_tokens` is only the *uncached remainder*; everything downstream
    // (the context bar, and the tokenHWM that drives trimByTokens) means
    // "prompt tokens this request", so streamUsage.input_tokens stays the full
    // prompt and the cache split rides alongside in its own fields. Both
    // message_start and message_delta report cumulative totals for the same
    // message, so each field is assigned, never accumulated.
    let uncachedInput = 0, cacheRead = 0, cacheCreated = 0;
    const applyPromptUsage = (u = {}) => {
      if (u.input_tokens != null) uncachedInput = u.input_tokens;
      if (u.cache_read_input_tokens != null) cacheRead = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens != null) cacheCreated = u.cache_creation_input_tokens;
      streamUsage.input_tokens = uncachedInput + cacheRead + cacheCreated;
      streamUsage.cache_read_input_tokens = cacheRead;
      streamUsage.cache_creation_input_tokens = cacheCreated;
    };
    let stream;
    try {
      // PRIVACY-01: scrub secrets from the outgoing (derived) array; the
      // persistent `messages` history is left intact.
      // budget_tokens must be < max_tokens (SDK requirement, min budget 1024) —
      // grow max_tokens to leave headroom for the visible answer beyond it.
      const maxTokens = thinkingBudget > 0 ? thinkingBudget + 8192 : 8192;
      stream = provider.client.messages.stream({
        model: provider.model, max_tokens: maxTokens,
        system: withSystemBreakpoint(systemPrompt), ...(tools ? { tools } : {}),
        messages: withMessageBreakpoint(redactMessages(trimmed)),
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
          streamUsage.output_tokens = event.message.usage.output_tokens ?? 0;
          applyPromptUsage(event.message.usage);
          if (event.message.usage.output_tokens_details) realThinkingTokens = event.message.usage.output_tokens_details.thinking_tokens ?? 0;
        }
        if (event.type === "message_delta") {
          stopReason = event.delta.stop_reason;
          if (event.usage) {
            streamUsage.output_tokens = event.usage.output_tokens ?? streamUsage.output_tokens;
            applyPromptUsage(event.usage);
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
    if (cacheRead > 0 || cacheCreated > 0) {
      logger.info(`[anthropic] cache: read=${cacheRead} created=${cacheCreated} uncached=${uncachedInput}`);
    }
    const validatedText = validateOutputSafe(fullText, "anthropic");
    streamUsage.thinking_tokens = realThinkingTokens != null
      ? realThinkingTokens
      : Math.max(0, streamUsage.output_tokens - encode(validatedText).length);
    const textBlock = contentBlocks.find(b => b.type === "text");
    if (textBlock) textBlock.text = validatedText;

    if (stopReason === "tool_use" && toolUses.length > 0) {
      emitter.send({ type: "stream_end", text: validatedText, usage: streamUsage });
      // Detect in-turn duplicates before pushing this turn's own tool_use blocks,
      // so the current call can't match itself (same dedup executor.js applies
      // for llamacpp/deepseek — see findPriorToolResult).
      const cachedByTc = new Map(toolUses.map(tool => [tool.id, findPriorToolResult(messages, tool.name, tool.input)]));
      messages.push({ role: "assistant", content: contentBlocks });
      const toolResults = [];
      for (const tool of toolUses) {
        const cached = cachedByTc.get(tool.id);
        let content;
        if (cached != null) {
          logger.warn(`[anthropic] duplicate tool call "${tool.name}" (identical args, same turn) — reusing prior result, not re-executing`);
          content = reuseNote(tool.name, cached);
        } else {
          content = await callTool(tool.name, tool.input);
        }
        toolResults.push({ type: "tool_result", tool_use_id: tool.id, content });
      }
      messages.push({ role: "user", content: toolResults });
      if (emitter._confirmPending) { delete emitter._confirmPending; return ""; }
      if (cancelled) { emitter.send({ type: "stream_end", text: "", usage: streamUsage }); return ""; }
      // Per-turn step cap — the only bound that holds when the model keeps
      // calling DIFFERENT tools, which resets every repeated-call counter.
      toolSteps++;
      if (!forceAnswerOnly && turnStepLimit > 0 && toolSteps >= turnStepLimit) {
        logger.warn(`[anthropic] turn step cap: model="${provider.model}" made ${toolSteps} tool-calling passes in one turn (limit ${turnStepLimit}) — forcing a tool-free answer`);
        emitter.send({ type: "tool_step_limit", steps: toolSteps, limit: turnStepLimit, model: provider.model });
        forceAnswerOnly = true;
      }
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
