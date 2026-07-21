// lib/emitters/handlers/ws/helpers.js
// Pure per-turn text helpers with no connection state — shared by wsHandler.js
// and the handlers extracted into this directory.

// Collapse any provider-specific content blocks (Anthropic tool_use/tool_result,
// image blocks, etc.) to plain text in-place. Called before a cross-provider
// model switch so the history survives the format change without losing context.
export function normalizeMessages(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!Array.isArray(m.content)) continue; // already a string — leave it
    const text = m.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();
    if (text) {
      msgs[i] = { role: m.role, content: text };
    } else {
      // Message was purely tool_use / tool_result with no text — drop it so
      // the new provider doesn't see an empty or structurally invalid entry.
      msgs.splice(i, 1);
    }
  }
}

const SUMMARIZE_RE = /\b(summarize|summarise|summarization|summary|recap)\b.*\b(our|this|the)?\s*(conversation|chat|discussion|session|history|we('ve| have) (discussed|talked|covered))\b|\bsummarize\s+(it|this|everything|all)\b|\b(tl;?dr|tldr)\b/i;

export function isSummarizeIntent(text) {
  return SUMMARIZE_RE.test(text?.trim() ?? "");
}

export function buildHistoryText(msgs) {
  return msgs
    .filter(m =>
      m.role !== "tool" &&
      !(Array.isArray(m.content) && m.content[0]?.type === "tool_result")
    )
    .map(m => {
      const role = m.role === "user" ? "User" : "Assistant";
      const text = Array.isArray(m.content)
        ? m.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim()
        : String(m.content || "").trim();
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join("\n\n");
}

export function tagLastAssistant(msgs, p) {
  const last = msgs[msgs.length - 1];
  if (last?.role === "assistant") {
    last._model    = p.model;
    last._provider = p.name;
  }
}
