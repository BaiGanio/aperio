import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

let SESSIONS_DIR = join(process.cwd(), "sessions");

export function init(rootDir) {
  SESSIONS_DIR = join(rootDir, "sessions");
}

// ── Internal helpers ──────────────────────────────────────────

function ensureDir() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(id) {
  return join(SESSIONS_DIR, `${id}.json`);
}

function read(id) {
  try { return JSON.parse(readFileSync(sessionPath(id), "utf8")); }
  catch { return null; }
}

function write(id, data) {
  ensureDir();
  writeFileSync(sessionPath(id), JSON.stringify(data, null, 2));
}

function toReadableMessages(messages) {
  return messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.filter(b => b.type === "text").map(b => b.text).join("").trim()
        : String(m.content ?? "").trim(),
    }))
    .filter(m => m.content);
}

// ── Public API ────────────────────────────────────────────────

export function createSession({ model, provider }) {
  ensureDir();
  const id = randomUUID();
  write(id, {
    id,
    startedAt: new Date().toISOString(),
    endedAt: null,
    model,
    provider,
    title: null,
    summaries: [],
    messages: [],
  });
  return id;
}

export function setSessionTitle(id, firstUserText) {
  const s = read(id);
  if (!s || s.title) return;
  const title = firstUserText.replace(/\n/g, " ").trim().slice(0, 80);
  write(id, { ...s, title: title || "Untitled session" });
}

// Called BEFORE compressing messages — captures the full transcript
// and the summary at this checkpoint.
export function appendSummary(id, { content, messages }) {
  const s = read(id);
  if (!s) return;
  // messages[0] is the internal greeting prompt — skip it, store only real exchanges
  s.summaries.push({
    generatedAt: new Date().toISOString(),
    messageCount: messages.length - 1,
    content,
    transcript: toReadableMessages(messages.slice(1)),
  });
  write(id, s);
}

// Called on ws.on("close") — saves the human-readable conversation, not internals.
export function finaliseSession(id, messages) {
  const s = read(id);
  if (!s) return;

  // messages[0] is always the synthetic greeting prompt injected by buildGreeting().
  // Find the title from the first *real* user message (index 2+).
  if (!s.title) {
    const firstReal = messages.slice(2).find(m => m.role === "user");
    const text = typeof firstReal?.content === "string"
      ? firstReal.content
      : firstReal?.content?.find?.(b => b.type === "text")?.text ?? "";
    s.title = text.replace(/\n/g, " ").trim().slice(0, 80) || "Untitled session";
  }

  // Store only the actual conversation — skip the internal greeting prompt at [0]
  s.messages = toReadableMessages(messages.slice(1));
  s.endedAt = new Date().toISOString();
  write(id, s);
}

export function listSessions() {
  ensureDir();
  return readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(".json"))
    .flatMap(f => {
      try {
        const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf8"));
        return [{
          id: s.id,
          title: s.title ?? "Untitled",
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          model: s.model,
          provider: s.provider,
          summaryCount: s.summaries?.length ?? 0,
          messageCount: s.messages?.length ?? 0,
        }];
      } catch { return []; }
    })
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

export function getSession(id) {
  return read(id);
}

// Returns a compact resume prompt — only the latest summary.
// Full history is intentionally excluded to protect the context window.
export function buildResumeContext(session) {
  const date = new Date(session.startedAt).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
  const lines = [
    `You are resuming a previous conversation titled: "${session.title ?? "Untitled"}" (started ${date}).`,
    "",
  ];

  if (session.summaries?.length) {
    const latest = session.summaries.at(-1);
    lines.push("Here is what was covered:", "", latest.content, "");
  } else if (session.messages?.length) {
    // No summary exists — use the last few messages as a brief reminder
    const tail = session.messages.slice(-4)
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 200)}`)
      .join("\n");
    lines.push("Here are the last exchanges:", "", tail, "");
  }

  lines.push(
    "Acknowledge briefly that you remember the previous conversation and ask how the user would like to continue.",
    "Do not use any tools for this message.",
  );

  return lines.join("\n");
}
