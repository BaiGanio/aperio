import { encode } from "gpt-tokenizer";

export const CTX_WARN_TARGET      = 0.60;
export const CTX_HANDOFF_TARGET   = 0.72;
export const CTX_TRIM_TARGET      = 0.75;
export const CTX_SUMMARIZE_TARGET = 0.80;
export const CTX_EMERGENCY_TARGET = 0.90;

// Absolute caps. Large windows (Anthropic 200k, Gemini 1M) would otherwise
// only trigger past the empirical dumb zone, which starts near 80–100k tokens
// regardless of nominal window size.
export const CTX_WARN_ABS_CAP    =  80_000;
export const CTX_HANDOFF_ABS_CAP = 120_000;

const CTX_MIN_MESSAGES = 4;

function warnThreshold(contextWindow) {
  return Math.min(contextWindow * CTX_WARN_TARGET, CTX_WARN_ABS_CAP);
}
function handoffThreshold(contextWindow) {
  return Math.min(contextWindow * CTX_HANDOFF_TARGET, CTX_HANDOFF_ABS_CAP);
}

export function shouldWarn(hwm, contextWindow) {
  return hwm >= warnThreshold(contextWindow);
}
export function shouldHandoff(hwm, contextWindow) {
  return hwm >= handoffThreshold(contextWindow);
}
export function shouldAutoSummarize(hwm, contextWindow) {
  return contextWindow > 0 && hwm >= contextWindow * CTX_SUMMARIZE_TARGET;
}
export function ctxPct(hwm, contextWindow) {
  return Math.round((hwm / contextWindow) * 100);
}

// Per-loop context-signal emitter. Holds a single flag object so each event
// fires at most once per loop instance (i.e. once per ws session).
//
//   const sig = makeContextSignals();
//   sig.emit(emitter, hwm, provider.contextWindow);
export function makeContextSignals() {
  const fired = { warn: false, handoff: false, summarize: false };
  return {
    emit(emitter, hwm, contextWindow) {
      if (!emitter || !contextWindow) return;
      const pct = ctxPct(hwm, contextWindow);
      if (!fired.warn && shouldWarn(hwm, contextWindow)) {
        fired.warn = true;
        emitter.send({ type: "context_warning", pct, hwm });
      }
      if (!fired.handoff && shouldHandoff(hwm, contextWindow)) {
        fired.handoff = true;
        emitter.send({ type: "context_handoff_suggested", pct, hwm });
      }
      if (!fired.summarize && shouldAutoSummarize(hwm, contextWindow)) {
        fired.summarize = true;
        emitter.send({ type: "context_summarize_suggested", pct, hwm });
      }
    },
  };
}

export function estimateMsgTokens(msg) {
  let text = "";
  if (typeof msg.content === "string") {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (typeof b === "string") { text += b; continue; }
      if (b.type === "text") text += b.text || "";
      else if (b.type === "tool_result") text += typeof b.content === "string" ? b.content : "";
      else if (b.type === "tool_use") text += JSON.stringify(b.input || {});
    }
  }
  return Math.max(1, Math.ceil(encode(text).length));
}

export function estimateTotalTokens(msgs) {
  return msgs.reduce((s, m) => s + estimateMsgTokens(m), 0);
}

// True when every content block is a tool_use (assistant side of a tool call).
function isToolOnlyAssistant(msg) {
  return msg.role === "assistant" && Array.isArray(msg.content) &&
    msg.content.length > 0 && msg.content.every(b => b.type === "tool_use");
}

// True when every content block is a tool_result (user side of a tool call).
function isToolResultUser(msg) {
  return msg.role === "user" && Array.isArray(msg.content) &&
    msg.content.length > 0 && msg.content.every(b => b.type === "tool_result");
}

export function trimByTokens(msgs, hwm, contextWindow) {
  if (hwm < contextWindow * CTX_TRIM_TARGET) return { messages: msgs, dropped: 0 };
  const pressure = (hwm - contextWindow * CTX_TRIM_TARGET) / (contextWindow * (1 - CTX_TRIM_TARGET));
  const targetFreeTokens = Math.floor(hwm * Math.min(0.4, pressure * 0.5));
  let dropped = 0, freed = 0;
  const rest = msgs.slice(1);
  // Emergency (≥90%): drop to 1 tail message; normal: keep CTX_MIN_MESSAGES - 1
  const minTail = hwm >= contextWindow * CTX_EMERGENCY_TARGET ? 1 : CTX_MIN_MESSAGES - 1;

  // Pass 1: drop pure tool-call/result pairs before text exchanges.
  // These are lower priority — their content is already captured in the surrounding answers.
  let i = 0;
  while (i + 1 < rest.length - minTail && freed < targetFreeTokens) {
    if (isToolOnlyAssistant(rest[i]) && isToolResultUser(rest[i + 1])) {
      freed += estimateMsgTokens(rest[i]) + estimateMsgTokens(rest[i + 1]);
      rest.splice(i, 2);
      dropped += 2;
    } else {
      i++;
    }
  }

  // Pass 2: drop oldest remaining messages
  while (rest.length > minTail && freed < targetFreeTokens) {
    freed += estimateMsgTokens(rest[0]);
    rest.shift();
    dropped++;
  }

  return { messages: [msgs[0], ...rest], dropped };
}

export function dropOrphanedToolResults(msgs) {
  let i = 1;
  while (i < msgs.length) { const m = msgs[i]; if (m.role !== "tool" && !(Array.isArray(m.content) && m.content[0]?.type === "tool_result")) break; i++; }
  return i === 1 ? msgs : [msgs[0], ...msgs.slice(i)];
}
