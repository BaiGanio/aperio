import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

let SESSIONS_DIR = join(process.cwd(), "var/sessions");

export function init(rootDir) {
  SESSIONS_DIR = join(rootDir, "var/sessions");
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

function remove(id) {
  const p = sessionPath(id);
  if (existsSync(p)) unlinkSync(p);
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
      if (m.role === "user" && attachmentsMap) {
        const meta = attachmentsMap.get(m);
        if (meta?.length) readable.attachments = meta;
      }
      return readable;
    })
    .filter(m => m.content);
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
function isMeaningful(messages, attachmentsMap) {
  const realMessages = messages.slice(1);
  const userMessages = realMessages.filter(m => m.role === "user");

  if (userMessages.length < 1) return false;

  // Attachments = meaningful by definition
  if (attachmentsMap) {
    for (const msg of userMessages) {
      const meta = attachmentsMap.get(msg);
      if (meta?.length > 0) return true;
    }
  }

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
// Trivial sessions (hello/goodbye only) are discarded automatically.
// The title is replaced with a meaningful one derived from the conversation content.
export function finaliseSession(id, messages, attachmentsMap = null) {
  const s = read(id);
  if (!s) return;

  // Discard trivial sessions — hello/goodbye chatter doesn't need persisting
  if (!isMeaningful(messages, attachmentsMap)) {
    remove(id);
    return;
  }

  // Derive a meaningful title from the conversation, not the first throwaway message
  s.title = deriveTitle(messages, s.summaries);

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
  const path = sessionPath(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function saveSessionPaths(id, { readPaths, writePaths }) {
  const s = read(id);
  if (!s) return;
  write(id, { ...s, allowedPaths: { readPaths, writePaths } });
}

// Returns a compact resume prompt — only the latest.
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
    // No summary — use the last few messages as a brief reminder
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
