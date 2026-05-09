import { encode } from "gpt-tokenizer";

export const CTX_WARN_TARGET = 0.60;
export const CTX_TRIM_TARGET = 0.75;
const CTX_MIN_MESSAGES = 4;

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

export function trimByTokens(msgs, hwm, contextWindow) {
  if (hwm < contextWindow * CTX_TRIM_TARGET) return { messages: msgs, dropped: 0 };
  const pressure = (hwm - contextWindow * CTX_TRIM_TARGET) / (contextWindow * (1 - CTX_TRIM_TARGET));
  const targetFreeTokens = Math.floor(hwm * Math.min(0.4, pressure * 0.5));
  let dropped = 0, freed = 0;
  const rest = msgs.slice(1);
  while (rest.length > CTX_MIN_MESSAGES - 1 && freed < targetFreeTokens) {
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
