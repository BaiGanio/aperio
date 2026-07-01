import { encode, decode } from "gpt-tokenizer";

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

// True when the message is the tool-result side of a tool call. Two shapes
// reach here: Anthropic-style `{role:"user", content:[{type:"tool_result"}]}`
// and the OpenAI-compatible `{role:"tool", content:[…]}` the executor pushes
// for ollama/deepseek. Both must be recognized so the trimmer drops a result
// together with its tool_use (never orphaning it).
function isToolResultMsg(msg) {
  if (msg.role === "tool") return true;
  return msg.role === "user" && Array.isArray(msg.content) &&
    msg.content.length > 0 && msg.content.every(b => b.type === "tool_result");
}

// Truncate text to a head + tail token budget, dropping the middle. Tool
// outputs (test runs, build logs) put the verdict at the tail, so we keep more
// of the end than the start. Returns the original string when it already fits.
function truncateToTokens(text, headTokens, tailTokens) {
  const toks = encode(text);
  if (toks.length <= headTokens + tailTokens) return text;
  const head = decode(toks.slice(0, headTokens));
  const tail = decode(toks.slice(toks.length - tailTokens));
  const omitted = toks.length - headTokens - tailTokens;
  return `${head}\n\n… [${omitted} tokens truncated to fit context — showing head + tail] …\n\n${tail}`;
}

// A single tool result can dwarf a small context window (e.g. a 150KB shell
// dump is ~37k tokens, larger than a 32k Ollama window in its entirety). Left
// whole, trimming drops its paired tool_use and the orphan filter then deletes
// the result outright — the model answers blind. Cap each tool_result's text
// to a fraction of the window (head + tail) so the freshest result always fits
// and survives. Returns the original array untouched when nothing was capped.
export function capToolResults(msgs, contextWindow) {
  if (!contextWindow) return msgs;
  const budget = Math.floor(contextWindow * 0.25);
  const headTokens = Math.floor(budget / 3);
  const tailTokens = budget - headTokens;
  let changed = false;
  const out = msgs.map(m => {
    if (!Array.isArray(m.content)) return m;
    let blockChanged = false;
    const content = m.content.map(b => {
      if (b?.type === "tool_result" && typeof b.content === "string") {
        const capped = truncateToTokens(b.content, headTokens, tailTokens);
        if (capped !== b.content) { blockChanged = true; return { ...b, content: capped }; }
      }
      return b;
    });
    if (blockChanged) { changed = true; return { ...m, content }; }
    return m;
  });
  return changed ? out : msgs;
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
    if (isToolOnlyAssistant(rest[i]) && isToolResultMsg(rest[i + 1])) {
      freed += estimateMsgTokens(rest[i]) + estimateMsgTokens(rest[i + 1]);
      rest.splice(i, 2);
      dropped += 2;
    } else {
      i++;
    }
  }

  // Pass 2: drop oldest remaining messages. Drop a tool_use/tool_result pair
  // together — dropping the tool_use alone would leave its result orphaned, and
  // dropOrphanedToolResults would then delete the freshest result, leaving the
  // model to answer with no tool output at all.
  while (rest.length > minTail && freed < targetFreeTokens) {
    if (isToolOnlyAssistant(rest[0]) && isToolResultMsg(rest[1])) {
      freed += estimateMsgTokens(rest[0]) + estimateMsgTokens(rest[1]);
      rest.splice(0, 2);
      dropped += 2;
    } else {
      freed += estimateMsgTokens(rest[0]);
      rest.shift();
      dropped++;
    }
  }

  return { messages: [msgs[0], ...rest], dropped };
}

export function dropOrphanedToolResults(msgs) {
  let i = 1;
  while (i < msgs.length) { const m = msgs[i]; if (m.role !== "tool" && !(Array.isArray(m.content) && m.content[0]?.type === "tool_result")) break; i++; }
  return i === 1 ? msgs : [msgs[0], ...msgs.slice(i)];
}
