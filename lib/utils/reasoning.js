/**
 * lib/reasoning.js — Per-model reasoning extraction plugins
 *
 * Each adapter describes how a specific model family surfaces its internal
 * reasoning/thinking during a streaming response, and how to strip that
 * reasoning from the final answer text before it reaches the user.
 *
 * ─── Adding a new model ───────────────────────────────────────────────────────
 *
 *   1. Add an entry to REASONING_ADAPTERS below.
 *   2. Set `match` to a lowercase substring that appears in the model name.
 *   3. Implement the two methods:
 *
 *      processDelta(delta, state, emit)
 *        Called for every SSE delta object from the stream.
 *        • delta  — the raw choices[0].delta object
 *        • state  — a mutable object you can use to track in-flight state
 *                   (e.g. whether we're currently inside a reasoning block).
 *                   It is created fresh per request via createState().
 *        • emit   — function(eventObject) to push events to the caller.
 *        Returns { contentToken: string|null } where contentToken is the
 *        portion of the delta that belongs to the final answer (not reasoning).
 *
 *      stripReasoning(fullText)
 *        Called once on the complete accumulated text after the stream ends.
 *        Must return the answer text with all reasoning markup removed.
 *        For adapters that surface reasoning only through delta.reasoning
 *        (never embedded in content), this is usually a no-op: s => s.
 *
 *      createState()  [optional]
 *        Factory for the per-request mutable state object.
 *        Default: () => ({})
 *
 *   Also set `thinks: true` if the model produces reasoning output, `false`
 *   otherwise. This controls whether the loop streams tokens immediately or
 *   buffers them for tool-call detection.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Internal helper: inline tag splitter ─────────────────────────────────────
/**
 * Creates a streaming parser for models that embed reasoning inline in content
 * using open/close XML-style tags, e.g.:
 *
 *   <think>…reasoning…</think>actual answer
 *   <parameter name="thinking">…</parameter>actual answer
 *
 * Because tokens arrive in small chunks, a tag may be split across multiple
 * deltas. The splitter buffers speculatively and only emits once it is sure
 * whether a chunk is reasoning or content.
 *
 * @param {object} opts
 * @param {string}   opts.openTag         - Full opening tag string, e.g. '<think>'
 * @param {string}   opts.closeTag        - Full closing tag string, e.g. '</think>'
 * @param {function} opts.onReasoningStart - () => void
 * @param {function} opts.onReasoningToken - (text: string) => void
 * @param {function} opts.onReasoningDone  - () => void
 * @returns {{ feed(chunk: string): string }}  Object with a feed() method.
 *   feed() accepts each raw chunk and returns the content portion (may be '').
 */
function makeTagSplitter({ openTag, closeTag, onReasoningStart, onReasoningToken, onReasoningDone }) {
  let inReasoning    = false;
  let speculativeBuf = ""; // chunks buffered while we might be inside a tag

  return {
    /** Feed a raw content chunk. Returns the answer-only portion. */
    feed(chunk) {
      speculativeBuf += chunk;
      let contentOut = "";

      while (speculativeBuf.length > 0) {
        if (inReasoning) {
          // Look for the closing tag
          const closeIdx = speculativeBuf.indexOf(closeTag);
          if (closeIdx === -1) {
            // Might still be mid-close-tag; keep a trailing window in buffer
            const safe = speculativeBuf.length - closeTag.length;
            if (safe > 0) {
              onReasoningToken(speculativeBuf.slice(0, safe));
              speculativeBuf = speculativeBuf.slice(safe);
            }
            break;
          }
          // Emit everything before the closing tag as reasoning
          if (closeIdx > 0) onReasoningToken(speculativeBuf.slice(0, closeIdx));
          onReasoningDone();
          inReasoning    = false;
          speculativeBuf = speculativeBuf.slice(closeIdx + closeTag.length);

        } else {
          // Look for the opening tag
          const openIdx = speculativeBuf.indexOf(openTag);
          if (openIdx === -1) {
            // No open tag found; keep a trailing window in case we're mid-tag
            const safe = speculativeBuf.length - openTag.length;
            if (safe > 0) {
              contentOut    += speculativeBuf.slice(0, safe);
              speculativeBuf = speculativeBuf.slice(safe);
            }
            break;
          }
          // Emit everything before the open tag as content
          if (openIdx > 0) contentOut += speculativeBuf.slice(0, openIdx);
          onReasoningStart();
          inReasoning    = true;
          speculativeBuf = speculativeBuf.slice(openIdx + openTag.length);
        }
      }

      return contentOut;
    },

    /** Flush any remaining speculative buffer as content (call after stream ends). */
    flush() {
      const remaining = speculativeBuf;
      speculativeBuf  = "";
      if (inReasoning) {
        // Unclosed reasoning block — treat remainder as reasoning
        if (remaining) onReasoningToken(remaining);
        onReasoningDone();
        inReasoning = false;
        return "";
      }
      return remaining;
    },
  };
}

// ── Adapter registry ──────────────────────────────────────────────────────────
/**
 * Each entry:
 *   match        {string}   Lowercase substring matched against the model name.
 *   thinks       {boolean}  Whether this model produces reasoning/thinking output.
 *                           When true: content tokens are streamed immediately and
 *                           post-stream tool-call interception is used.
 *                           When false: tokens are buffered to detect tool-call JSON.
 *   noTools      {boolean}  Whether the model cannot use structured tool calls.
 *   createState  {function} Returns a fresh per-request state object.
 *   processDelta {function} (delta, state, emit) => { contentToken }
 *   stripReasoning {function} (fullText) => string
 */
export const REASONING_ADAPTERS = [

  // ── Qwen3 ────────────────────────────────────────────────────────────────────
  // Surfaces reasoning via a dedicated `delta.reasoning` field (never in content).
  {
    match: "qwen3",
    thinks: true,
    noTools: false,

    createState() {
      return { sentReasoningStart: false };
    },

    processDelta(delta, state, emit) {
      // Reasoning field
      if (delta.reasoning) {
        if (!state.sentReasoningStart) {
          state.sentReasoningStart = true;
          emit({ type: "reasoning_start" });
        }
        emit({ type: "reasoning_token", text: delta.reasoning });
      }

      // Content field — close reasoning block if still open
      if (delta.content) {
        if (state.sentReasoningStart) {
          emit({ type: "reasoning_done" });
          state.sentReasoningStart = false;
        }
        return { contentToken: delta.content };
      }

      return { contentToken: null };
    },

    stripReasoning(fullText) {
      // Qwen3 never embeds reasoning in content, nothing to strip.
      return fullText;
    },
  },

  // ── DeepSeek-R1 ──────────────────────────────────────────────────────────────
  // Same delta.reasoning field as Qwen3; also cannot use structured tool calls.
  {
    match: "deepseek-r1",
    thinks: true,
    noTools: true,

    createState() {
      return { sentReasoningStart: false };
    },

    processDelta(delta, state, emit) {
      if (delta.reasoning) {
        if (!state.sentReasoningStart) {
          state.sentReasoningStart = true;
          emit({ type: "reasoning_start" });
        }
        emit({ type: "reasoning_token", text: delta.reasoning });
      }

      if (delta.content) {
        if (state.sentReasoningStart) {
          emit({ type: "reasoning_done" });
          state.sentReasoningStart = false;
        }
        return { contentToken: delta.content };
      }

      return { contentToken: null };
    },

    stripReasoning(fullText) {
      return fullText;
    },
  },

  // ── Gemma 4 ───────────────────────────────────────────────────────────────────
  // Ollama surfaces Gemma's thinking via `delta.reasoning` — identical to Qwen3.
  // Despite Gemma's documentation describing "channel-based" inline tags, the actual
  // Ollama implementation uses the same dedicated field as Qwen3.
  {
    match: "gemma",
    thinks: true,
    noTools: false,

    createState() {
      return { sentReasoningStart: false };
    },

    processDelta(delta, state, emit) {
      // Thinking field
      if (delta.reasoning) {
        if (!state.sentReasoningStart) {
          state.sentReasoningStart = true;
          emit({ type: "reasoning_start" });
        }
        emit({ type: "reasoning_token", text: delta.reasoning });
      }

      // Content field — close reasoning block if still open
      if (delta.content) {
        if (state.sentReasoningStart) {
          emit({ type: "reasoning_done" });
          state.sentReasoningStart = false;
        }
        return { contentToken: delta.content };
      }

      return { contentToken: null };
    },

    stripReasoning(fullText) {
      // delta.thinking never appears in content — nothing to strip.
      return fullText;
    },
  },

  // ── Llama (no reasoning) ─────────────────────────────────────────────────────
  // Plain content-only model; included so the resolver always finds a match
  // for llama-family models without thinking capability.
  {
    match: "llama",
    thinks: false,
    noTools: false,

    createState() { return {}; },

    processDelta(delta, _state, _emit) {
      return { contentToken: delta.content ?? null };
    },

    stripReasoning(fullText) { return fullText; },
  },
];

// ── Resolver ──────────────────────────────────────────────────────────────────
/**
 * Returns the best matching adapter for a given model name string,
 * or a safe no-op adapter if nothing matches.
 *
 * @param {string} modelName
 * @returns {object} adapter
 */
export function resolveReasoningAdapter(modelName) {
  const lower = modelName.toLowerCase();
  return (
    REASONING_ADAPTERS.find(a => lower.includes(a.match)) ?? noopAdapter()
  );
}

function noopAdapter() {
  return {
    match:    "__noop__",
    thinks:   false,
    noTools:  false,
    createState()                { return {}; },
    processDelta(delta, _, __)   { return { contentToken: delta.content ?? null }; },
    stripReasoning(text)         { return text; },
  };
}