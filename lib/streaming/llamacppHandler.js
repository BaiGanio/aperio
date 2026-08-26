const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

// Both timeouts below come from user-editable settings and are used as timer
// durations. parseInt yields NaN for anything nonnumeric (or empty), and a NaN
// duration makes setTimeout fire immediately while NaN arithmetic poisons every
// remaining-budget subtraction — the read loop would spin on the same pending
// read forever instead of ever reporting a stalled stream. A value that is not
// a usable number falls back to the documented default rather than propagating.
const msSetting = (raw, fallback, min = 1) => {
  const parsed = parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
};

// Bounds a single reader.read() call, not the whole stream — a long prefill is
// legitimate (verified live: llama-server (build 10090) pings a 3-byte SSE
// comment `:\n\n` roughly every 30s while prefilling a 20k-token prompt, well
// before the first real token), so this only needs margin over that cadence,
// not over total generation time. Without this, a connection that genuinely
// stops responding (server crash, dead slot) leaves reader.read() pending
// forever — no error, no retry, just a silently hung turn.
const STREAM_IDLE_TIMEOUT_MS = msSetting(process.env.LLAMACPP_STREAM_IDLE_TIMEOUT_MS, 120000);
// The wait ended before the read did — re-evaluate the guards and wait again
// on the SAME pending read. Not an outcome by itself: the loop decides whether
// that means a stalled connection, a thinking cutoff, or just a slow chunk.
const STREAM_TIMER_WAKE = Symbol("stream-timer-wake");
const STREAM_READ_PENDING = Symbol("stream-read-pending");

// Grace granted when the thinking cutoff comes due while the tail of an SSE
// line is still buffered. That fragment may be the first piece of a real
// answer — split `data:` lines are routine here (see this.sseBuffer) — and
// cutting off now would discard it, because processLine never ran on the
// partial line and the cutoff path deliberately skips the trailing-buffer
// flush. Bounded rather than open-ended so a stream whose reads habitually
// end mid-line cannot starve the guard indefinitely.
const PARTIAL_LINE_GRACE_MS = 5000;

// Bounds a stream that keeps producing reasoning tokens but never reaches a
// real answer or tool call — distinct from STREAM_IDLE_TIMEOUT_MS, which only
// catches a connection that goes silent. A model stuck reasoning stays chatty
// (tokens every ~second) so idle timeout never trips; observed live as a 900s
// turn that emitted 4,678 thinking tokens and nothing else (gemma4-E4B,
// id/reference/tech-debt.md "Runaway reasoning"). Deliberately generous
// (well under the harness's external kill) so a turn legitimately reasoning
// hard isn't cut off early. Default only — this class is shared with
// runDeepSeekLoop, which has no suppressed-thinking retry to fall into after
// a cutoff (unlike runLlamaCppLoop), so its call site passes 0 to disable
// this guard entirely rather than turn a long DeepSeek reasoning turn into a
// bare empty-response fallback.
// min 0 rather than 1: 0 is the documented way to disable this guard (see the
// runDeepSeekLoop note above), so it must survive normalization intact.
const THINKING_TIMEOUT_MS = msSetting(process.env.LLAMACPP_THINKING_TIMEOUT_MS, 180000, 0);

// Waits on an ALREADY-ISSUED read for at most `ms`. The read promise is owned
// by the caller and reused across wake-ups: calling reader.read() again while
// a previous call is still pending queues a second request against the same
// reader, and the abandoned first one silently swallows a chunk.
async function waitForRead(pending, ms) {
  let timer;
  const wake = new Promise(resolve => { timer = setTimeout(() => resolve(STREAM_TIMER_WAKE), ms); });
  try {
    return await Promise.race([pending, wake]);
  } finally {
    clearTimeout(timer);
  }
}

// Non-blocking look at a read that may have settled in the same turn the
// wake-up timer fired. Promise.race attaches to `pending` first, so a read
// that is already settled wins the tie against an immediately-resolved
// promise — data that arrived is taken instead of being discarded by the
// cutoff decision that follows.
const peekRead = (pending) => Promise.race([pending, Promise.resolve(STREAM_READ_PENDING)]);

// Generic OpenAI-compatible SSE stream reader — shared by any provider speaking
// the /v1/chat/completions protocol (originally written for Ollama; llama.cpp's
// llama-server exposes the same wire format, plus a `timings` block on the
// final chunk that Ollama doesn't send).
export class LlamaCppStreamHandler {
  constructor(response, emitter, reasoningAdapter, callTool, provider, suppressThinking = false, thinkingTimeoutMs = THINKING_TIMEOUT_MS) {
    this.response = response; this.emitter = emitter; this.adapter = reasoningAdapter;
    this.callTool = callTool; this.provider = provider;
    // A caller-supplied budget that is not a usable positive number disables
    // the guard (0) rather than arming it with nonsense: this cutoff cancels
    // and discards a turn, so its fail-safe direction is "do nothing".
    this.thinkingTimeoutMs = Number.isFinite(thinkingTimeoutMs) && thinkingTimeoutMs > 0 ? thinkingTimeoutMs : 0;
    this.fullText = ""; this.reasoningContent = ""; this.toolCalls = [];
    this.tokenBuffer = ""; this.mightBeToolCall = false;
    // Set alongside — but never in place of — reasoningContent: an inline
    // <think>-tag adapter (makeInlineThinkAdapter, used by qwen3/ornith) emits
    // reasoning_token events through the adapter's own `emit` callback and
    // never populates delta.reasoning/reasoning_content, so reasoningContent
    // alone would miss it and the thinking-timeout below would never fire for
    // those models — the exact runaway case it exists to catch. Set from both
    // the native-field path and the emit-callback path below, without
    // changing what reasoningContent itself means to callers downstream.
    // Deliberately does NOT cover an inline adapter's unresolved lead (still
    // buffering, no tag seen either way) — that state is indistinguishable
    // from an ordinary tag-free answer that just hasn't finished yet,
    // so treating it as confirmed reasoning would let this destructive
    // (cancel + discard) guard cut off and discard a legitimate slow answer.
    this.reasoningSeen = false;
    // A streamed error object. llama-server returns HTTP 200 for a streaming
    // request, then emits `data: {"error":{…}}` if inference fails mid-stream
    // (e.g. "Compute error." on an OOM Metal alloc). Captured here so the caller
    // surfaces the real failure instead of treating the empty token stream as a
    // degenerate "no response" completion and burning a pointless retry.
    this.streamError = null;
    this.adapterState = reasoningAdapter.createState(suppressThinking); this.detectedThinking = false;
    this.streamUsage = zeroUsage();
    // llama-server's final SSE chunk carries a `timings` block (prompt_ms,
    // predicted_ms, prompt_per_second, predicted_per_second, cache_n) — not
    // part of the OpenAI schema, so it's captured separately from streamUsage.
    this.timings = null;
    // Carries an incomplete trailing SSE line between network chunks. A single
    // `data: {…}` line is routinely split across two reader.read() reads; without
    // this buffer both halves fail the `data:`/JSON checks and the token is
    // silently dropped — corrupting long outputs (e.g. a streamed HTML page)
    // with scattered missing characters.
    this.sseBuffer = "";
    this.thinkingTimedOut = false;
    // Anchored to the first reasoning activity, not stream start — a long
    // prompt prefill (llama-server pings a keep-alive comment throughout it,
    // never a real delta) must not count against the budget, or a turn whose
    // prefill alone exceeds thinkingTimeoutMs would be cut off the instant
    // reasoning actually begins.
    this.reasoningStartMs = null;
    // When a due cutoff was first held back by a buffered partial SSE line
    // (null whenever it is not being held back). See PARTIAL_LINE_GRACE_MS.
    this.cutoffDeferredSince = null;
  }
  // Marks reasoning-equivalent activity exactly once, capturing when it
  // first started. Called from both the native-field path and the resolved
  // inline-adapter path (a real reasoning_token event) below, so every
  // CONFIRMED shape of "the model is thinking" anchors the same deadline.
  _markReasoningSeen() {
    if (!this.reasoningSeen) { this.reasoningSeen = true; this.reasoningStartMs = Date.now(); }
  }
  // Whether the thinking guard can still fire on this turn: a budget is set,
  // reasoning has actually started, and the turn still has nothing to show
  // for it. Checked before every wait as well as before every read, so the
  // wait is never bounded by a deadline that can no longer matter (which
  // would wake the loop forever once an answer had arrived).
  _thinkingGuardActive() {
    return !!this.thinkingTimeoutMs && this.reasoningStartMs !== null
      && this.toolCalls.length === 0 && !this.adapter.stripReasoning(this.fullText).trim();
  }
  // True once the whole thinking budget is spent with nothing to show for it.
  // A due cutoff is held back while a partial SSE line sits in the buffer,
  // for at most PARTIAL_LINE_GRACE_MS.
  _thinkingCutoffDue() {
    // Any state that is not a due cutoff also clears a held-back one, so a
    // stale deferral can never expire retroactively on a later turn of the loop.
    if (!this._thinkingGuardActive() || Date.now() - this.reasoningStartMs < this.thinkingTimeoutMs) { this.cutoffDeferredSince = null; return false; }
    if (!this.sseBuffer) return true;
    if (this.cutoffDeferredSince === null) this.cutoffDeferredSince = Date.now();
    return Date.now() - this.cutoffDeferredSince >= PARTIAL_LINE_GRACE_MS;
  }
  // How long the next wait may block. The idle timeout is the ceiling, but a
  // pending thinking deadline (or the grace holding one back) cuts it short —
  // otherwise a single read could stay pending for the full idle timeout past
  // the deadline, and sparse reasoning chunks arriving just under that
  // interval would stretch a 180s thinking budget to nearly 300s.
  _nextWaitMs(idleRemainingMs) {
    let wait = idleRemainingMs;
    if (this._thinkingGuardActive()) {
      const deadline = this.cutoffDeferredSince !== null
        ? this.cutoffDeferredSince + PARTIAL_LINE_GRACE_MS
        : this.reasoningStartMs + this.thinkingTimeoutMs;
      wait = Math.min(wait, deadline - Date.now());
    }
    // Both deadlines are re-checked at the top of the loop before this runs,
    // so neither remainder is ever negative here; the floor is belt-and-braces.
    return Math.max(wait, 1);
  }
  async process() {
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    this.emitter.send({ type: "stream_start" });
    let pendingRead = null;
    // Idle is tracked as a budget drained by the waits that actually expired,
    // not as a wall-clock delta: a wait cut short by the thinking deadline
    // must not count as a full idle interval, and the connection is only
    // "silent" for as long as the loop really sat waiting on it.
    let idleRemainingMs = STREAM_IDLE_TIMEOUT_MS;
    // Consumes a settled read result; returns true when the stream should end.
    const take = (result) => {
      pendingRead = null;
      idleRemainingMs = STREAM_IDLE_TIMEOUT_MS;
      if (result.done) return true;
      return this.processChunk(decoder.decode(result.value, { stream: true }));
    };
    while (true) {
      if (idleRemainingMs <= 0) {
        this.streamError = `stream stalled — no data received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`;
        reader.cancel?.()?.catch(() => {});
        break;
      }
      // Not a streamError: leaving cleanText/toolCalls empty lets this fall
      // into the caller's existing empty-completion retry (forces thinking
      // off, nudges for a direct answer) instead of surfacing as a hard error.
      if (this._thinkingCutoffDue()) {
        this.thinkingTimedOut = true;
        // The adapter's own buffer is left untouched (no flushAdapter() call —
        // see the skip below), but a reasoning_start already sent to the
        // emitter still needs its matching reasoning_done, or a UI that pairs
        // them (e.g. the CLI's inReasoning flag, which stream_start does not
        // reset) stays stuck "in reasoning" through the retry that follows.
        if (this.reasoningSeen) this.emitter.send({ type: "reasoning_done" });
        reader.cancel?.()?.catch(() => {});
        break;
      }
      if (!pendingRead) pendingRead = reader.read();
      const waitMs = this._nextWaitMs(idleRemainingMs);
      const result = await waitForRead(pendingRead, waitMs);
      if (result !== STREAM_TIMER_WAKE) { if (take(result)) break; continue; }
      idleRemainingMs -= waitMs;
      // The wait expired. The read may still have settled in that same turn,
      // so take its data before looping back into the guards above.
      const settled = await peekRead(pendingRead);
      if (settled !== STREAM_READ_PENDING && take(settled)) break;
    }
    // A timed-out turn is cut off deliberately with fullText/toolCalls still
    // empty (the guard's own precondition) so the caller's empty-completion
    // retry fires. Skip both the trailing partial-line and the adapter flush
    // below in that case — flushAdapter() would otherwise recover an inline
    // adapter's still-unresolved speculative buffer as if it were a finished
    // answer (per its own documented flush() semantics), which would make
    // cleanText non-empty, silently skip that retry, and surface incomplete,
    // private mid-thought reasoning to the user as the final answer instead.
    if (!this.thinkingTimedOut) {
      // Process any final line that arrived without a trailing newline.
      if (this.sseBuffer) { const last = this.sseBuffer; this.sseBuffer = ""; this.processLine(last); }
      this.flushAdapter();
    }
    return { text: this.fullText, toolCalls: this.toolCalls, cleanText: this.adapter.stripReasoning(this.fullText), reasoningContent: this.reasoningContent || null };
  }
  processChunk(chunk) {
    this.sseBuffer += chunk;
    let nlIdx;
    // Only consume up to the last newline; keep the (possibly partial) remainder
    // buffered until the next chunk completes it.
    while ((nlIdx = this.sseBuffer.indexOf("\n")) !== -1) {
      const line = this.sseBuffer.slice(0, nlIdx);
      this.sseBuffer = this.sseBuffer.slice(nlIdx + 1);
      if (this.processLine(line)) return true;
    }
    return false;
  }
  processLine(line) {
    if (!line.startsWith("data: ")) return false;
    const data = line.slice(6).trim();
    if (data === "[DONE]") return true;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return false; }
    // A mid-stream error object carries no `choices`/`delta`, so the token path
    // below would silently drop it. Capture the message and end the stream so
    // the caller can report it verbatim.
    if (parsed.error) { this.streamError = parsed.error?.message || parsed.error?.type || "unknown streaming error"; return true; }
    if (parsed.usage) this.streamUsage = { input_tokens: parsed.usage.prompt_tokens ?? 0, output_tokens: parsed.usage.completion_tokens ?? 0, thinking_tokens: parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0 };
    if (parsed.timings) this.timings = parsed.timings;
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return false;
    this.processDelta(delta);
    return false;
  }
  processDelta(delta) {
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        if (!this.toolCalls[i]) this.toolCalls[i] = { id: "", name: "", args: "" };
        if (tc.id) this.toolCalls[i].id = tc.id;
        if (tc.function?.name) this.toolCalls[i].name = tc.function.name;
        if (tc.function?.arguments) this.toolCalls[i].args += tc.function.arguments;
      }
      this.mightBeToolCall = true; return;
    }
    if (delta.reasoning_content) { this.reasoningContent += delta.reasoning_content; this._markReasoningSeen(); }
    if (delta.reasoning) { this.reasoningContent += delta.reasoning; this._markReasoningSeen(); }
    if (!this.adapter.thinks && (delta.reasoning || delta.reasoning_content)) this.detectedThinking = true;
    const { contentToken } = this.adapter.processDelta(delta, this.adapterState, (o) => {
      if (o.type === "reasoning_token" && o.text) this._markReasoningSeen();
      this.emitter.send(o);
    });
    // Deliberately NOT marked as reasoning: a headless inline block (a chat
    // template pre-fills <think>, so content starts inside it with no opening
    // tag) holds every chunk in the splitter's speculative buffer and fires
    // no event until </think> arrives — but that unresolved state is
    // observably identical to an ordinary tag-free answer that simply hasn't
    // finished yet. Treating it as confirmed reasoning would let this
    // destructive (cancel + discard) guard cut off and discard a legitimate
    // slow answer; there is no signal available here to tell the two apart
    // before the stream ends. See id/reference/tech-debt.md "Runaway
    // reasoning" for why this was tried and reverted.
    if (contentToken) { this.fullText += contentToken; if (this.mightBeToolCall) this.tokenBuffer += contentToken; else this.emitter.send({ type: "token", text: contentToken }); }
  }
  flushAdapter() { if (typeof this.adapter.flushState === "function") { const flushed = this.adapter.flushState(this.adapterState); if (flushed) { this.fullText += flushed; if (this.mightBeToolCall) this.tokenBuffer += flushed; else this.emitter.send({ type: "token", text: flushed }); } } }
  flushRemainingTokenBuffer() { if (this.tokenBuffer) { this.emitter.send({ type: "stream_start" }); this.emitter.send({ type: "token", text: this.tokenBuffer }); this.tokenBuffer = ""; } }
  // A real native tool call fired, so whatever content streamed alongside/after
  // it (buffered rather than shown live, in case it turned out to be tool-call
  // syntax leaking into the content field) is the model's genuine preamble —
  // e.g. "Let me write the script and execute it." trailing off mid-word right
  // where the tool_calls delta began. Unlike flushRemainingTokenBuffer(), a
  // bubble is already streaming here (the text before the buffering kicked in
  // was sent live), so this appends via a plain token event rather than
  // restarting the stream.
  flushBufferedContent() { if (this.tokenBuffer) { this.emitter.send({ type: "token", text: this.tokenBuffer }); this.tokenBuffer = ""; } }
}
