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
function makeTagSplitter({ openTag, closeTag, startResolved = false, onReasoningStart, onReasoningToken, onReasoningDone }) {
  let inReasoning    = false;
  // Until the lead of the stream is "resolved" we don't yet know whether it is a
  // (headless) reasoning block or the answer, so we hold it instead of emitting.
  // A headless block happens when the chat template pre-fills the opening
  // <think>, so the model's content begins *inside* reasoning and only emits the
  // closing </think>. Callers that already know the content is the answer
  // (reasoning arrived via a native field, or thinking was suppressed) pass
  // startResolved:true to stream immediately.
  let resolved       = startResolved;
  let speculativeBuf = ""; // chunks buffered while we might be inside a tag
  const window       = Math.max(openTag.length, closeTag.length) - 1;

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
          resolved       = true;
          speculativeBuf = speculativeBuf.slice(closeIdx + closeTag.length);
          continue;
        }

        const openIdx  = speculativeBuf.indexOf(openTag);
        const closeIdx = speculativeBuf.indexOf(closeTag);

        // Headless reasoning: a closing tag with no preceding opening tag — the
        // template ate the <think>. Everything up to it is reasoning, not answer.
        if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
          onReasoningStart();
          if (closeIdx > 0) onReasoningToken(speculativeBuf.slice(0, closeIdx));
          onReasoningDone();
          resolved       = true;
          speculativeBuf = speculativeBuf.slice(closeIdx + closeTag.length);
          continue;
        }

        // Normal inline block: emit any answer text before the opening tag.
        if (openIdx !== -1) {
          if (openIdx > 0) contentOut += speculativeBuf.slice(0, openIdx);
          onReasoningStart();
          inReasoning    = true;
          speculativeBuf = speculativeBuf.slice(openIdx + openTag.length);
          continue;
        }

        // Neither tag present yet.
        if (!resolved) {
          // The lead could still be a headless block whose </think> hasn't
          // arrived — hold everything until a tag resolves it or the stream ends.
          break;
        }
        // Resolved as answer: stream it, holding only a partial-tag window.
        const safe = speculativeBuf.length - window;
        if (safe > 0) {
          contentOut    += speculativeBuf.slice(0, safe);
          speculativeBuf = speculativeBuf.slice(safe);
        }
        break;
      }

      return contentOut;
    },

    /** Flush any remaining speculative buffer (call after stream ends). */
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
      // Unresolved lead that never produced a </think> was the answer all along.
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
// ── Inline-<think> adapter factory ────────────────────────────────────────────
// Qwen3-family models (including the qwen35-architecture Ornith) surface
// thinking in one of two ways depending on the Ollama build / model renderer:
//   • Newer builds split thinking into a dedicated `delta.reasoning` field.
//   • Others leave it inline in `delta.content` as <think>…</think> — and when
//     the renderer's tool/thinking parser intermittently fails under load, even
//     a native-reasoning model dumps a headless "…</think>answer" into content.
// We handle both: the reasoning field is emitted directly, and content is run
// through a tag splitter so an inline (or headless) <think> block is surfaced as
// hidden reasoning_* events instead of leaking into the answer.
function makeInlineThinkAdapter(match) {
  return {
    match,
    thinks: true,
    noTools: false,

    createState(suppressThinking = false) {
      return { sentReasoningStart: false, splitter: null, sawNativeReasoning: false, suppressed: !!suppressThinking };
    },

    processDelta(delta, state, emit) {
      // Native reasoning field (newer Ollama separates <think> for us).
      if (delta.reasoning) {
        state.sawNativeReasoning = true;
        if (!state.sentReasoningStart) {
          state.sentReasoningStart = true;
          emit({ type: "reasoning_start" });
        }
        emit({ type: "reasoning_token", text: delta.reasoning });
      }

      // Ollama emits `content: ""` on every reasoning chunk; an empty string is
      // not real answer content and must NOT close the reasoning block, or each
      // token would be split into its own bubble.
      if (!delta.content) return { contentToken: null };

      // Content arriving — close any open native reasoning block first.
      if (state.sentReasoningStart) {
        emit({ type: "reasoning_done" });
        state.sentReasoningStart = false;
      }

      // Route content through the inline <think> splitter (created lazily so it
      // can capture `emit`). Returns only the answer portion. When reasoning
      // already came via the native field, or thinking was suppressed, the
      // content is the answer — stream it immediately (startResolved). Otherwise
      // the lead may be a headless <think> block, so the splitter holds it until
      // a </think> (or the stream end) decides.
      if (!state.splitter) {
        state.splitter = makeTagSplitter({
          openTag: "<think>",
          closeTag: "</think>",
          startResolved: state.sawNativeReasoning || state.suppressed,
          onReasoningStart: ()  => emit({ type: "reasoning_start" }),
          onReasoningToken: (t) => emit({ type: "reasoning_token", text: t }),
          onReasoningDone:  ()  => emit({ type: "reasoning_done" }),
        });
      }
      const contentToken = state.splitter.feed(delta.content);
      return { contentToken: contentToken || null };
    },

    // Flush the splitter after the stream ends (handler calls flushState).
    flushState(state) {
      return state.splitter ? state.splitter.flush() : "";
    },

    stripReasoning(fullText) {
      // Inline <think> is already stripped by the splitter; nothing left to do.
      return fullText;
    },
  };
}

export const REASONING_ADAPTERS = [

  // ── Qwen3 ────────────────────────────────────────────────────────────────────
  makeInlineThinkAdapter("qwen3"),

  // ── Ornith (deepreinforce-ai/Ornith-1.0-9B, qwen35 architecture) ─────────────
  // Ships a custom Ollama RENDERER/PARSER ("ornith") that normally emits reasoning
  // via delta.reasoning and tool calls as a native tool_calls array. Under load
  // that parser intermittently leaks: reasoning arrives inline as "…</think>" in
  // content (handled by this inline-think adapter) and tool calls arrive as raw
  // "[tool_call](name) [key]val[/key]" bbcode (recovered in tools/executor.js).
  makeInlineThinkAdapter("ornith"),

  // ── DeepSeek V4 (thinking mode, with tools) ─────────────────────────────────
  // DeepSeek V4 Flash and similar models use delta.reasoning_content and support
  // tool calling. The API requires reasoning_content to be echoed back in history.
  {
    match: "deepseek-v4",
    thinks: true,
    noTools: false,

    createState() {
      return { sentReasoningStart: false };
    },

    processDelta(delta, state, emit) {
      if (delta.reasoning_content) {
        if (!state.sentReasoningStart) {
          state.sentReasoningStart = true;
          emit({ type: "reasoning_start" });
        }
        emit({ type: "reasoning_token", text: delta.reasoning_content });
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

  // ── DeepSeek-Reasoner (API) ───────────────────────────────────────────────────
  // DeepSeek's cloud API uses delta.reasoning_content (not delta.reasoning).
  // Tool calling is not supported on the reasoner model.
  {
    match: "deepseek-reasoner",
    thinks: true,
    noTools: true,

    createState() {
      return { sentReasoningStart: false };
    },

    processDelta(delta, state, emit) {
      if (delta.reasoning_content) {
        if (!state.sentReasoningStart) {
          state.sentReasoningStart = true;
          emit({ type: "reasoning_start" });
        }
        emit({ type: "reasoning_token", text: delta.reasoning_content });
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
    // Gemma occasionally writes a *plan* to call a tool inside its thinking
    // channel and then stops (finish_reason "stop") without emitting the
    // tool_call when the input is large — leaving an empty answer. Rather than
    // suppressing reasoning on every tool turn (which hides thinking the user
    // asked to see), runOllamaLoop catches the empty completion and retries the
    // turn once with thinking forced off (reasoning_effort:"none"). The Ollama
    // OpenAI-compat endpoint only honors reasoning_effort:"none" for this — it
    // ignores `think:false`. See runOllamaLoop's empty-completion retry.

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