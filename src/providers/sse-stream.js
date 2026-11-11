// src/providers/sse-stream.js - read one OpenAI-style SSE stream from
// llama-server (spec S2.5, adapter behaviour 3).
//
// Ported from v1 lib/streaming/llamacppHandler.js at archive/v1-final: the
// split-line buffer, the idle timeout, the thinking timeout (anchored to the
// first reasoning, bounded partial-line grace, a deadline that also bounds a
// pending read), streamed `error` objects, usage and the `timings` block.
// Changed: one function, no class, no reasoning adapter; values come from the
// caller (AP1), never from process.env. An inline <think> block in content is
// split into reasoning here (L-M07). No module state.

/** A read that sends nothing for this long ends the stream as stalled. */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;
/** Reasoning with no answer and no tool call for this long is cut off. */
export const THINKING_TIMEOUT_MS = 180_000;
/** A due cutoff waits this long for a half-received SSE line (maybe the answer). */
const PARTIAL_LINE_GRACE_MS = 5000;

const WAKE = Symbol('wake');
const PENDING = Symbol('pending');
const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

/**
 * Wait on an already-issued read for at most `ms`. The same read promise is
 * reused across wake-ups: a second reader.read() would swallow a chunk.
 * @param {Promise<any>} pending @param {number} ms
 */
async function waitForRead(pending, ms) {
  let timer;
  const wake = new Promise((resolve) => { timer = setTimeout(() => resolve(WAKE), ms); });
  try {
    return await Promise.race([pending, wake]);
  } finally {
    clearTimeout(timer);
  }
}

/** A read that settled in the same turn the timer fired is taken, not dropped. */
const peekRead = (pending) => Promise.race([pending, Promise.resolve(PENDING)]);

/** Length of the longest suffix of `s` that starts `tag` (a tag cut by a delta). */
function partialTagLength(s, tag) {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (tag.startsWith(s.slice(-n))) return n;
  }
  return 0;
}

/**
 * Split content into answer text and inline <think> reasoning, across deltas.
 * @param {(kind: 'text' | 'reasoning', s: string) => void} out
 */
function createThinkSplitter(out) {
  let inside = false;
  let buf = '';
  return {
    push(s) {
      buf += s;
      for (;;) {
        const tag = inside ? CLOSE_TAG : OPEN_TAG;
        const at = buf.indexOf(tag);
        if (at !== -1) {
          if (at > 0) out(inside ? 'reasoning' : 'text', buf.slice(0, at));
          buf = buf.slice(at + tag.length);
          inside = !inside;
          continue;
        }
        const keep = partialTagLength(buf, tag);
        const ready = buf.slice(0, buf.length - keep);
        if (ready) out(inside ? 'reasoning' : 'text', ready);
        buf = buf.slice(buf.length - keep);
        return;
      }
    },
    flush() {
      if (buf) out(inside ? 'reasoning' : 'text', buf);
      buf = '';
    },
  };
}

/** @param {unknown} v @param {number} fallback */
const positiveOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/**
 * @typedef {{ index: number, id: string, name: string, args: string }} RawToolCall
 * @typedef {{ text: string, reasoning: string | null, toolCalls: RawToolCall[],
 *   usage: { input_tokens: number, output_tokens: number, thinking_tokens: number },
 *   timings: Record<string, number> | null, streamError: string | null,
 *   thinkingTimedOut: boolean, aborted: boolean }} StreamResult
 */

/**
 * Read one streamed chat completion.
 * @param {{ body: { getReader(): any } }} response
 * @param {{ emit?: (e: { type: string, text?: string }) => void, idleTimeoutMs?: number,
 *   thinkingTimeoutMs?: number, signal?: AbortSignal }} [opts]
 *   idleTimeoutMs: a bad value falls back to the default. thinkingTimeoutMs: 0 or
 *   a bad value turns the guard off (it cancels a turn, so "off" is the safe side).
 * @returns {Promise<StreamResult>}
 */
export async function readSseStream(response, opts = {}) {
  const emit = opts.emit ?? (() => {});
  const idleMs = positiveOr(opts.idleTimeoutMs, STREAM_IDLE_TIMEOUT_MS);
  const thinkingMs = opts.thinkingTimeoutMs === undefined ? THINKING_TIMEOUT_MS : positiveOr(opts.thinkingTimeoutMs, 0);
  const { signal } = opts;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  /** @type {RawToolCall[]} */
  const toolCalls = [];
  let text = '';
  let reasoning = '';
  let sseBuffer = '';
  let streamError = null;
  let thinkingTimedOut = false;
  let aborted = false;
  let usage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };
  let timings = null;
  let afterToolCall = false;
  let reasoningStartMs = null;
  let cutoffDeferredSince = null;

  const cancelReader = () => {
    const p = reader.cancel?.();
    // cleanup: the stream is being dropped; a failed cancel changes nothing.
    if (p && typeof p.catch === 'function') p.catch(() => {});
  };
  const onAbort = () => { aborted = true; cancelReader(); };
  signal?.addEventListener('abort', onAbort, { once: true });

  const markReasoning = () => { if (reasoningStartMs === null) reasoningStartMs = Date.now(); };
  const addReasoning = (s) => { reasoning += s; markReasoning(); emit({ type: 'reasoning_token', text: s }); };
  const addText = (s) => {
    text += s;
    if (!afterToolCall) emit({ type: 'token', text: s });
  };
  const splitter = createThinkSplitter((kind, s) => (kind === 'reasoning' ? addReasoning(s) : addText(s)));

  const processDelta = (delta) => {
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        toolCalls[i] ??= { index: i, id: '', name: '', args: '' };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].name = tc.function.name;
        if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
      }
      afterToolCall = true; // later content may be leaked call syntax: keep it, do not stream it
      return;
    }
    if (delta.reasoning_content) addReasoning(delta.reasoning_content);
    if (delta.reasoning) addReasoning(delta.reasoning);
    if (typeof delta.content === 'string' && delta.content) splitter.push(delta.content);
  };

  /** @returns {boolean} true when the stream should end */
  const processLine = (line) => {
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return true;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return false; } // a broken line is skipped, as llama-server never sends one on purpose
    if (parsed.error) {
      streamError = parsed.error.message || parsed.error.type || 'unknown streaming error';
      return true;
    }
    if (parsed.usage) {
      usage = {
        input_tokens: parsed.usage.prompt_tokens ?? 0,
        output_tokens: parsed.usage.completion_tokens ?? 0,
        thinking_tokens: parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0,
      };
    }
    if (parsed.timings) timings = parsed.timings;
    const delta = parsed.choices?.[0]?.delta;
    if (delta) processDelta(delta);
    return false;
  };

  const processChunk = (chunk) => {
    sseBuffer += chunk;
    let nl;
    while ((nl = sseBuffer.indexOf('\n')) !== -1) {
      const line = sseBuffer.slice(0, nl);
      sseBuffer = sseBuffer.slice(nl + 1);
      if (processLine(line)) return true;
    }
    return false;
  };

  const guardActive = () => thinkingMs > 0 && reasoningStartMs !== null
    && toolCalls.length === 0 && !text.trim();

  const cutoffDue = () => {
    if (!guardActive() || Date.now() - reasoningStartMs < thinkingMs) { cutoffDeferredSince = null; return false; }
    if (!sseBuffer) return true;
    cutoffDeferredSince ??= Date.now();
    return Date.now() - cutoffDeferredSince >= PARTIAL_LINE_GRACE_MS;
  };

  const nextWaitMs = (idleRemaining) => {
    let wait = idleRemaining;
    if (guardActive()) {
      const deadline = cutoffDeferredSince !== null ? cutoffDeferredSince + PARTIAL_LINE_GRACE_MS : reasoningStartMs + thinkingMs;
      wait = Math.min(wait, deadline - Date.now());
    }
    return Math.max(wait, 1);
  };

  let pendingRead = null;
  let idleRemaining = idleMs;
  const take = (result) => {
    pendingRead = null;
    idleRemaining = idleMs;
    if (result.done) return true;
    return processChunk(decoder.decode(result.value, { stream: true }));
  };

  try {
    if (signal?.aborted) onAbort();
    while (!aborted) {
      if (idleRemaining <= 0) {
        streamError = `stream stalled: no data for ${idleMs / 1000}s`;
        cancelReader();
        break;
      }
      if (cutoffDue()) {
        thinkingTimedOut = true; // not an error: the caller retries with thinking off
        cancelReader();
        break;
      }
      pendingRead ??= reader.read();
      const waitMs = nextWaitMs(idleRemaining);
      const result = await waitForRead(pendingRead, waitMs);
      if (result !== WAKE) { if (take(result)) break; continue; }
      idleRemaining -= waitMs;
      const settled = await peekRead(pendingRead);
      if (settled !== PENDING && take(settled)) break;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  // A cut-off turn stays empty, so the caller's empty-completion retry fires.
  if (!thinkingTimedOut && !aborted) {
    if (sseBuffer) { const last = sseBuffer; sseBuffer = ''; processLine(last); }
    splitter.flush();
  }

  return {
    text,
    reasoning: reasoning || null,
    toolCalls: toolCalls.filter(Boolean),
    usage,
    timings,
    streamError,
    thinkingTimedOut,
    aborted,
  };
}
