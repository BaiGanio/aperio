import { readFileSync, readdirSync, existsSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { ensureSecureDir, writeSecureFile } from "./secureFile.js";
import { encodeSession, decodeSession } from "./sessionCrypto.js";
import { truncateServerLog, saveServerLog, deleteServerLog } from "./startLlamaCpp.js";

let SESSIONS_DIR = join(process.cwd(), "var/sessions");
let LOGS_DIR     = join(process.cwd(), "var/logs");
let SCRATCH_DIR  = join(process.cwd(), "var/scratch");
let ARTIFACTS_DIR = join(process.cwd(), "var/agent-artifacts");

export function init(rootDir) {
  SESSIONS_DIR = join(rootDir, "var/sessions");
  LOGS_DIR     = join(rootDir, "var/logs");
  SCRATCH_DIR  = join(rootDir, "var/scratch");
  ARTIFACTS_DIR = join(rootDir, "var/agent-artifacts");
}

// Per-session scratch workspace: where skill-generated artifacts (pptx/xlsx
// generator scripts and their output) are written, so they can be deleted
// together with the session when it is pruned or removed.
export function sessionScratchDir(id) {
  return join(SCRATCH_DIR, id);
}

function deleteSessionScratch(id) {
  if (!id) return;
  try { rmSync(sessionScratchDir(id), { recursive: true, force: true }); }
  catch { /* non-fatal */ }
}

function deleteSessionArtifacts(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return;
  try { rmSync(join(ARTIFACTS_DIR, "sessions", id), { recursive: true, force: true }); }
  catch { /* non-fatal */ }
}

// True if the session produced any generated artifacts in its scratch workspace.
// Such a session is worth keeping even if its chat looks trivial, so we don't
// delete files the user may still want to download before retention expires.
function scratchHasFiles(id) {
  if (!id) return false;
  try { return readdirSync(sessionScratchDir(id)).length > 0; }
  catch { return false; }
}

// ── Internal helpers ──────────────────────────────────────────

function ensureDir() {
  // DATA-01: sessions hold full conversation history — keep the dir private (0700).
  ensureSecureDir(SESSIONS_DIR);
}

function sessionPath(id) {
  return join(SESSIONS_DIR, `${id}.json`);
}

function read(id) {
  // SESSION-01: decodeSession transparently handles encrypted or plaintext files.
  try { return decodeSession(readFileSync(sessionPath(id), "utf8")); }
  catch { return null; }
}

function write(id, data) {
  ensureDir();
  // DATA-01: 0600 so other OS users can't read the conversation at rest.
  // SESSION-01: encodeSession encrypts when APERIO_SESSION_KEY is set (else plaintext).
  writeSecureFile(sessionPath(id), encodeSession(data));
}

function remove(id) {
  const p = sessionPath(id);
  if (existsSync(p)) unlinkSync(p);
}

// Delete uploaded files referenced in a finalised session's messages array.
function deleteSessionFiles(s) {
  if (!s?.messages) return;
  for (const msg of s.messages) {
    for (const att of (msg.attachments ?? [])) {
      if (att.savedPath) try { unlinkSync(att.savedPath); } catch { /* non-fatal */ }
    }
  }
}

// Delete uploaded files while they are still held in the in-memory WeakMap
// (called for trivial sessions that are discarded before being written to disk).
function deleteSessionFilesFromMemory(messages, attachmentsMap) {
  if (!attachmentsMap) return;
  for (const msg of messages) {
    const meta = attachmentsMap.get(msg);
    if (meta) {
      for (const m of meta) {
        if (m.savedPath) try { unlinkSync(m.savedPath); } catch { /* non-fatal */ }
      }
    }
  }
}

function deleteSessionLog(id) {
  const logPath = join(LOGS_DIR, `${id}.log`);
  if (existsSync(logPath)) try { unlinkSync(logPath); } catch { /* non-fatal */ }
  deleteServerLog(id);
}

function toReadableMessages(messages, attachmentsMap = null) {
  return messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => {
      const readable = {
        role: m.role,
        content: Array.isArray(m.content)
          ? m.content.filter(b => b.type === "text").map(b => b.text).join("").trim()
          : String(m.content ?? "").trim(),
      };
      if (m._model)    readable.model    = m._model;
      if (m._provider) readable.provider = m._provider;
      if (m.role === "user" && attachmentsMap) {
        const meta = attachmentsMap.get(m);
        if (meta?.length) readable.attachments = meta;
      }
      return readable;
    })
    .filter(m => m.content || m.attachments?.length);
}

// ── Text helpers ──────────────────────────────────────────────

/**
 * Extract plain text content from a message regardless of format.
 */
function extractText(msg) {
  if (!msg?.content) return "";
  if (typeof msg.content === "string") return msg.content.trim();
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Truncate at a word boundary with an ellipsis.
 */
function truncateAtWord(text, maxLen) {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.7 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

/**
 * Clean up a title candidate: strip leading filler words and articles.
 */
function cleanTitle(text) {
  if (!text) return "";
  let t = text.trim();
  // Strip leading filler patterns
  t = t.replace(
    /^(so\s+|ok(?:ay)?[,!\s]+|right\s+now\s+|well\s+|actually\s+|basically\s+|essentially\s+|just\s+)/i,
    ""
  );
  // Strip leading articles
  t = t.replace(/^(a\s+|an\s+|the\s+)/i, "");
  // Capitalize first letter
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.trim();
}

/**
 * Messages that are meta-commands about the conversation itself, not topics.
 */
const META_COMMANDS = [
  /^(end of conversation|end chat|stop|done for now|that's all|that is all)\b/i,
  /^(summarise|summarize)\b/i,
  /^(save|remember|forget|delete)\b/i,
];

// ── Meaningfulness check ──────────────────────────────────────

/**
 * Determines whether a session had substantive content worth keeping.
 *
 * A session is trivial if every real user message is a greeting, pleasantry,
 * one-word answer, or very short small talk — with no substantive topic,
 * question, code, link, attachment, or decision.
 */
function isMeaningful(messages, attachmentsMap, hadAttachments = false) {
  // A session that ever had file uploads is always worth keeping — checked first
  // so it survives even after summarization compresses the messages array (which
  // would otherwise remove the original user messages and empty the WeakMap lookup).
  if (hadAttachments) return true;

  const realMessages = messages.slice(1);
  const userMessages = realMessages.filter(m => m.role === "user");

  // Fallback WeakMap check (covers sessions without the hadAttachments flag).
  if (attachmentsMap) {
    for (const msg of userMessages) {
      const meta = attachmentsMap.get(msg);
      if (meta?.length > 0) return true;
    }
  }

  if (realMessages.length < 7) return false;

  const TRIVIAL = [
    /^(hi|hello|hey|howdy|greetings|yo|sup)\b/i,
    /^(good morning|good evening|good afternoon|good day|g[mo]rnin)/i,
    /^(how are you|how's it going|how do you do|what's up|whats up|how's everything|how are things)/i,
    /^(how (are|r) (you|u)\??)\s*$/i,
    /^(not much|nothing|just (chilling|browsing|looking|passing through|testing))\b/i,
    /^(fine|good|great|ok|okay|alright|not bad|could be worse)\s*$/i,
    /^(thanks|thank you|ty|thx|cheers|appreciate it|much appreciated)\s*$/i,
    /^(bye|goodbye|see you|cya|talk later|later|cool|nice|got it|understood|sounds good)\s*$/i,
    /^(yes|no|yep|nope|yeah|nah|sure|maybe|probably|absolutely|definitely|correct|right)\s*$/i,
    /^(lol|lmao|rofl|lmfao|haha|heh|nice one|funny)\s*$/i,
    /^(!+|\.+|…+)$/,
    /^[\s]*$/,
  ];

  const isTrivial = (text) => {
    if (!text) return true;
    if (text.length > 50) return false;
    return TRIVIAL.some(p => p.test(text));
  };

  const substantive = userMessages.filter(m => !isTrivial(extractText(m)));
  return substantive.length > 0;
}

// ── Title derivation ──────────────────────────────────────────

/**
 * Derive a meaningful session title from the conversation content.
 *
 * Priority:
 *   1. Extract topic from the latest summary's first bullet point
 *   2. Pick the longest non-trivial user message that isn't a meta-command
 *   3. Fall back to the first real user message
 *   4. Last resort: "Untitled session"
 *
 * @param {object[]} messages  — raw agent messages (index 0 = internal greeting)
 * @param {object[]} summaries — session summaries array (may be empty)
 * @returns {string} a short, meaningful title (≤ 60 chars)
 */
function deriveTitle(messages, summaries) {
  // Priority 1: extract topic from summary
  if (summaries?.length > 0) {
    const latest = summaries.at(-1);
    const content = latest.content || "";

    // Find the first bullet point — it usually names the main topic
    const firstBullet = content
      .split("\n")
      .find(l => l.trim().startsWith("-") || l.trim().startsWith("*"))
      ?.replace(/^[-*\s]+/, "")
      .trim();

    if (firstBullet) {
      // Take the segment before the first semicolon or dash — the subject
      const segment = firstBullet.split(/[;–—]| — /)[0].trim();
      // Remove verb framing: "User shared X" → "X", "Assistant discussed Y" → "Y"
      const cleaned = segment
        .replace(
          /^(User|Assistant|The user|The assistant)\s+(shared|asked|discussed|requested|mentioned|talked about|provided|gave|sent|started|wanted to know about)\s+/i,
          ""
        )
        .replace(/^(User|Assistant)\s+/i, "")
        .trim();
      if (cleaned.length > 15) return truncateAtWord(cleanTitle(cleaned), 60);
    }

    // Fallback within summaries: first line without the dash marker
    const firstLine = content
      .split("\n")[0]
      .replace(/^[-*\s]+/, "")
      .trim();
    if (firstLine.length > 15) return truncateAtWord(cleanTitle(firstLine), 60);
  }

  // Priority 2: find the best user message as title
  const userMessages = messages
    .filter(m => m.role === "user")
    .slice(2); // skip [0] internal greeting prompt and [1] AI response

  if (userMessages.length === 0) return "Untitled session";

  // Score candidates: prefer long, substantive, non-meta messages
  const candidates = userMessages
    .map(m => extractText(m))
    .filter(t => t.length > 5)
    .map(text => ({
      text,
      score: text.length - (META_COMMANDS.some(p => p.test(text)) ? 200 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (best) return truncateAtWord(cleanTitle(best.text), 60);

  // Fallback: first real user message
  return truncateAtWord(cleanTitle(extractText(userMessages[0])), 60) || "Untitled session";
}

// ── Public API ────────────────────────────────────────────────

export function createSession({ model, provider, source = "web", parentId = null }) {
  ensureDir();
  const id = randomUUID();
  // Truncate the shared server log so this session starts with a clean slate.
  // The server opens it with O_APPEND, so after truncation the next write
  // lands at byte 0. Best-effort — no-op when server isn't running.
  truncateServerLog();
  write(id, {
    id,
    startedAt: new Date().toISOString(),
    endedAt: null,
    model,
    provider,
    source,
    title: null,
    parentId,
    providerSessions: {},
    summaries: [],
    messages: [],
  });
  return id;
}

/**
 * Sets a quick initial title from the first user message (for immediate display).
 * This is a rough placeholder — finaliseSession replaces it with a better one.
 */
export function setSessionTitle(id, firstUserText) {
  const s = read(id);
  if (!s || s.title) return;
  const title = firstUserText.replace(/\n/g, " ").trim().slice(0, 80);
  write(id, { ...s, title: title || "Untitled session" });
}

export function updateSessionModel(id, { model, provider }) {
  const s = read(id);
  if (!s) return;
  write(id, { ...s, model, provider });
}

export function getProviderSessionId(id, key) {
  if (!id || !key) return null;
  const s = read(id);
  const value = s?.providerSessions?.[key]?.sessionId;
  return typeof value === "string" && value ? value : null;
}

export function updateProviderSessionId(id, key, sessionId) {
  if (!id || !key || !sessionId) return false;
  const s = read(id);
  if (!s) return false;
  write(id, {
    ...s,
    providerSessions: {
      ...(s.providerSessions ?? {}),
      [key]: { sessionId },
    },
  });
  return true;
}

// Called BEFORE compressing messages — checkpoints the summary at this point.
// Only the summary text is stored; the full transcript is intentionally NOT
// persisted here (nothing reads it back — resume uses `content`, the History
// view renders `content`, and RAG indexing is handled separately). Storing the
// whole conversation just bloated the session file.
export function appendSummary(id, { content, messages }) {
  const s = read(id);
  if (!s) return;
  s.summaries.push({
    generatedAt: new Date().toISOString(),
    // messages[0] is the internal greeting prompt — exclude it from the count
    messageCount: messages.length - 1,
    content,
  });
  write(id, s);
}

// Called on ws.on("close") — saves the human-readable conversation, not internals.
// Trivial sessions (hello/goodbye only) are discarded automatically.
// The title is replaced with a meaningful one derived from the conversation content.
export function finaliseSession(id, messages, attachmentsMap = null, hadAttachments = false) {
  const s = read(id);
  if (!s) return;

  // Discard trivial sessions — hello/goodbye chatter doesn't need persisting.
  // A session that generated files is never trivial: keep it (and its scratch
  // workspace) so the artifacts survive until retention.
  if (!isMeaningful(messages, attachmentsMap, hadAttachments) && !scratchHasFiles(id)) {
    deleteSessionFilesFromMemory(messages, attachmentsMap);
    deleteSessionLog(id);
    deleteSessionScratch(id);
    deleteSessionArtifacts(id);
    remove(id);
    return;
  }

  // Derive a meaningful title from the conversation, not the first throwaway message
  s.title = deriveTitle(messages, s.summaries);

  // Save this session's llama-server log to var/llamacpp/{id}.log.
  // Best-effort — no-op when the server isn't running.
  saveServerLog(id);

  // Store only the actual conversation — skip the internal greeting prompt at [0]
  s.messages = toReadableMessages(messages.slice(1), attachmentsMap);
  s.endedAt = new Date().toISOString();
  write(id, s);
}

export function listSessions({ page, limit } = {}) {
  ensureDir();
  const all = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(".json"))
    .flatMap(f => {
      try {
        const s = decodeSession(readFileSync(join(SESSIONS_DIR, f), "utf8"));
        return [{
          id: s.id,
          title: s.title ?? "Untitled",
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          model: s.model,
          provider: s.provider,
          source: s.source ?? "web",
          parentId: s.parentId ?? null,
          pinned: !!s.pinned,
          summaryCount: s.summaries?.length ?? 0,
          messageCount: s.messages?.length ?? 0,
        }];
      } catch { return []; }
    })
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

  // If no pagination params, return everything (backwards compat)
  if (page === undefined || limit === undefined) {
    return all;
  }

  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const start = (Math.max(1, page) - 1) * limit;
  const sessions = all.slice(start, start + limit);

  return { sessions, total, page, limit, pages };
}

export function getSession(id) {
  return read(id);
}

export function deleteSession(id) {
  const p = sessionPath(id);
  if (!existsSync(p)) return false;
  const s = read(id);
  deleteSessionFiles(s);
  deleteSessionLog(id);
  deleteSessionScratch(id);
  deleteSessionArtifacts(id);
  unlinkSync(p);
  return true;
}

export function pinSession(id, pinned) {
  const s = read(id);
  if (!s) return false;
  write(id, { ...s, pinned: !!pinned });
  return true;
}

export function pruneOldSessions() {
  ensureDir();
  const retentionDays = Math.max(1, Number(process.env.SESSION_RETENTION_DAYS) || 90);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"))) {
    try {
      const s = decodeSession(readFileSync(join(SESSIONS_DIR, f), "utf8"));
      if (!s.pinned && new Date(s.startedAt).getTime() < cutoff) {
        deleteSessionFiles(s);
        deleteSessionLog(s.id);
        deleteSessionScratch(s.id);
        deleteSessionArtifacts(s.id);
        unlinkSync(join(SESSIONS_DIR, f));
        removed++;
      }
    } catch { /* skip unreadable files */ }
  }
  return removed;
}

export const RESUME_SYSTEM_INSTRUCTIONS =
  "The user is resuming a previous conversation. Acknowledge briefly that you remember it and ask how they would like to continue.";

// Returns a compact resume context as a user message — only the latest summary or
// last few exchanges. Full history is intentionally excluded to protect the context window.
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
    const tail = session.messages.slice(-4)
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 200)}`)
      .join("\n");
    lines.push("Here are the last exchanges:", "", tail, "");
  }

  return lines.join("\n");
}
