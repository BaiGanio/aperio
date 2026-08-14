import { readFileSync, readdirSync, existsSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { ensureSecureDir, writeSecureFile } from "./secureFile.js";
import { encodeSession, decodeSession } from "./sessionCrypto.js";
import { beginSessionLog, endSessionLog, deleteServerLog } from "./startLlamaCpp.js";

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

// Several ids reaching this module are client-controlled (resume_session's
// `id` over the websocket; the /api/sessions/:id route params) and get joined
// straight into a filesystem path below; without this gate an id like
// "../../package" resolves inside SESSIONS_DIR to the repo's own
// package.json, and the caller's normal read/write/delete on "the session"
// silently reads/overwrites/deletes that escaped file instead (AGENTS.md's
// path-validation requirement — same class of bug lib/routes/paths.js guards
// against for user-directed file access). createSession() always mints ids
// via randomUUID(), but this deliberately doesn't require UUID shape — it
// only excludes path separators (the sole way `join()` can be made to escape
// the base dir) and a leading dot (which would make ".." itself pass) — so a
// human-readable id from a test fixture or another id source stays valid.
// Same character class deleteSessionArtifacts already uses below.
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isValidSessionId(id) {
  return typeof id === "string" && SAFE_ID_RE.test(id);
}

function assertValidSessionId(id) {
  if (!isValidSessionId(id)) throw new Error(`Invalid session id: ${JSON.stringify(id)}`);
}

// Per-session scratch workspace: where skill-generated artifacts (pptx/xlsx
// generator scripts and their output) are written, so they can be deleted
// together with the session when it is pruned or removed.
export function sessionScratchDir(id) {
  assertValidSessionId(id);
  return join(SCRATCH_DIR, id);
}

function deleteSessionScratch(id) {
  if (!id) return;
  try { rmSync(sessionScratchDir(id), { recursive: true, force: true }); }
  catch { /* non-fatal */ }
}

function deleteSessionArtifacts(id) {
  if (!isValidSessionId(id)) return;
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
  assertValidSessionId(id);
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

// Full removal of a session's log files — the winston per-session error log
// AND its llama-server debug log. Used when a session is explicitly deleted or
// aged out by retention. NOT used for the trivial-session discard at
// finalisation: a trivial chat can still have exercised llama-server, and its
// debug log is time-pruned like any other (see finaliseSession).
function deleteSessionLog(id) {
  assertValidSessionId(id);
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
 * True if the user actually engaged — at least one non-empty user turn.
 * Deliberately laxer than isMeaningful: it draws the line at "did anything
 * happen" rather than "was it substantive", used to preserve a session
 * INTERRUPTED by shutdown (which the user didn't choose to end) while still
 * dropping a phantom session from a browser that connected but never sent a
 * turn.
 *
 * `messages[0]` is only a non-content placeholder — a resume/branch context
 * note injected by handleResumeSession/handleBranchConversation — when
 * `firstMessageSynthetic` is true. A fresh conversation never seeds one (see
 * wsHandler.js's init(): the greeting is deliberately never pushed into
 * `messages`), so index 0 there is the user's real first turn and must count.
 */
function hasUserEngagement(messages, firstMessageSynthetic = false) {
  const real = firstMessageSynthetic ? messages.slice(1) : messages;
  return real.some(m => m.role === "user" && extractText(m).length > 0);
}

/**
 * Determines whether a session had substantive content worth keeping.
 *
 * A session is trivial if every real user message is a greeting, pleasantry,
 * one-word answer, or very short small talk — with no substantive topic,
 * question, code, link, attachment, or decision.
 *
 * See hasUserEngagement's doc comment for what `firstMessageSynthetic` means
 * and when `messages[0]` actually is a placeholder to drop.
 */
function isMeaningful(messages, attachmentsMap, hadAttachments = false, firstMessageSynthetic = false) {
  // A session that ever had file uploads is always worth keeping — checked first
  // so it survives even after summarization compresses the messages array (which
  // would otherwise remove the original user messages and empty the WeakMap lookup).
  if (hadAttachments) return true;

  const realMessages = firstMessageSynthetic ? messages.slice(1) : messages;
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
 * @param {object[]} messages  — raw agent messages
 * @param {object[]} summaries — session summaries array (may be empty)
 * @param {boolean}  firstMessageSynthetic — true when messages[0] is a resume/
 *   branch context note rather than a real user turn (see hasUserEngagement)
 * @returns {string} a short, meaningful title (≤ 60 chars)
 */
function deriveTitle(messages, summaries, firstMessageSynthetic = false) {
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
    // Only skip a leading entry when it's the synthetic resume/branch context
    // note, not a real user turn (see hasUserEngagement's doc comment).
    .slice(firstMessageSynthetic ? 1 : 0);

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
  // Open this session's live llama-server debug log immediately, so it exists
  // and can be tailed from the moment the session starts — not written at the
  // end (which lost it on any crash) and not tied to whether the session turns
  // out meaningful. No-op cost when the provider isn't llama.cpp: the file just
  // stays empty and is removed at finalisation.
  beginSessionLog(id);
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

export function clearProviderSessionId(id, key) {
  if (!id || !key) return false;
  const s = read(id);
  if (!s) return false;
  const providerSessions = { ...(s.providerSessions ?? {}) };
  delete providerSessions[key];
  write(id, { ...s, providerSessions });
  return true;
}

// Called BEFORE compressing messages — checkpoints the summary at this point.
// Only the summary text is stored; the full transcript is intentionally NOT
// persisted here (nothing reads it back — resume uses `content`, the History
// view renders `content`, and RAG indexing is handled separately). Storing the
// whole conversation just bloated the session file.
export function appendSummary(id, { content, messages, firstMessageSynthetic = false }) {
  const s = read(id);
  if (!s) return;
  s.summaries.push({
    generatedAt: new Date().toISOString(),
    // messages[0] is only synthetic (a resume/handoff seed, not a real turn)
    // when the caller says so — see hasUserEngagement's doc comment above.
    messageCount: firstMessageSynthetic ? messages.length - 1 : messages.length,
    content,
  });
  write(id, s);
}

// Called on ws.on("close") — saves the human-readable conversation, not internals.
// Trivial sessions (hello/goodbye only) are discarded automatically.
// The title is replaced with a meaningful one derived from the conversation content.
export function finaliseSession(id, messages, attachmentsMap = null, hadAttachments = false, opts = {}) {
  const s = read(id);
  if (!s) return;

  // Drain and close this session's live llama-server debug log up front. The
  // return value tells us whether the session actually exercised llama-server
  // (a non-empty log was kept); an empty log — a cloud-provider session that
  // never touched it — is removed here.
  const hasServerLog = endSessionLog(id);

  // The doc_batch session dedup cache (lib/docgraph/retrieval.js's
  // sessionReadFacts) is released from HERE at the ws-close call site in
  // lib/emitters/handlers/wsHandler.js, not from this function — that cache
  // lives inside the separate MCP child process (mcp/index.js), and this
  // module has no handle to reach it. See wsHandler.js's ws.on("close", ...)
  // (clearDocSessionCache) and lib/agent/index.js's clearDocSessionCache(),
  // which reaches mcp/index.js's custom "aperio/clearDocSessionCache" method
  // (llamacpp-multiturn-latency.md Step 3 review, round 3 P2 / round 5 P2).

  // A summarized session is meaningful by construction — summarization only
  // fires on a substantial conversation, and it does so by WIPING messages[]
  // down to a summary + a couple of anchor turns (see handleSummarize in
  // wsHandler). Without this guard, isMeaningful sees that compressed array,
  // reads "< 7 messages = trivial", and deletes a real conversation — along
  // with the summaries already saved to it — the moment its socket closes
  // (e.g. on server stop). Small local-model context windows make auto-
  // summarize routine, so this hit ordinary chats, not edge cases.
  const wasSummarized = (s.summaries?.length ?? 0) > 0;

  // A session finalised because the server/CLI is SHUTTING DOWN was interrupted,
  // not ended — the user hit Ctrl+C, they didn't declare the chat trivial. The
  // triviality heuristic exists for a natural end (tab close after hello/
  // goodbye); applying it on shutdown silently deletes whatever the user was in
  // the middle of. On shutdown, keep any session that did real work — the user
  // engaged with it, OR it produced a llama-server log — so a session is never
  // deleted out from under the debug log sitting right next to it. Only a truly
  // empty one (connected, greeted, never a user turn, no server output) drops.
  const keepInterrupted = opts.onShutdown === true &&
    (hasUserEngagement(messages, opts.firstMessageSynthetic) || hasServerLog);

  // True when this session already has a persisted transcript from a PRIOR
  // finalisation — i.e. it was resumed on this (or another) connection rather
  // than started fresh here. `messages` in that case is only the resume's
  // compact suffix (buildResumeContext deliberately excludes full history to
  // protect the context window — see buildResumeContext below), not the whole
  // conversation, so it must never be judged trivial-and-discardable, never
  // have its title clobbered by a post-resume exchange that said nothing new,
  // and never REPLACE the existing transcript wholesale (round 12, P1).
  const isContinuation = !!s.endedAt || (s.messages?.length ?? 0) > 0;

  // Discard trivial sessions — hello/goodbye chatter doesn't need persisting.
  // A session that generated files is never trivial: keep it (and its scratch
  // workspace) so the artifacts survive until retention. A continuation is
  // never trivial either: it already has real persisted history, and this
  // connection only ever sees the resume's short suffix of it.
  if (!keepInterrupted && !wasSummarized && !isContinuation &&
      !isMeaningful(messages, attachmentsMap, hadAttachments, opts.firstMessageSynthetic) &&
      !scratchHasFiles(id)) {
    deleteSessionFilesFromMemory(messages, attachmentsMap);
    // The winston per-session error log has no debug value for a discarded
    // chat — remove it along with the rest of the session's footprint. (The
    // llama-server log, if any, was already handled by endSessionLog above and
    // is left to the 24h pruner.)
    const winstonLog = join(LOGS_DIR, `${id}.log`);
    if (existsSync(winstonLog)) try { unlinkSync(winstonLog); } catch { /* non-fatal */ }
    deleteSessionScratch(id);
    deleteSessionArtifacts(id);
    remove(id);
    return;
  }

  // Derive a meaningful title from the conversation, not the first throwaway
  // message — but a continuation with nothing new to go on (no summary, no
  // substantive post-resume user turn) must not clobber an already-meaningful
  // title with the "no candidate found" fallback.
  const derivedTitle = deriveTitle(messages, s.summaries, opts.firstMessageSynthetic);
  if (!isContinuation || derivedTitle !== "Untitled session") {
    s.title = derivedTitle;
  }

  // Store the actual conversation. `messages[0]` is only dropped when the
  // CALLER says it's the synthetic resume/branch context note (opts.
  // firstMessageSynthetic) — a fresh session never seeds one (wsHandler.js's
  // init() deliberately never pushes the greeting into `messages`), so its
  // real first user turn must survive here. Before this flag existed, this
  // slice was unconditional and silently dropped every session's genuine
  // opening message on its first-ever finalise (id/reference/tech-debt.md,
  // "Sessions — persisted transcript", 2026-08-02).
  // For a continuation, APPEND the new turns to the existing persisted
  // transcript instead of replacing it: `messages` here holds only what
  // happened on this connection since the resume, and replacing would
  // silently erase everything the session held before it (round 12, P1).
  const realMessages = opts.firstMessageSynthetic ? messages.slice(1) : messages;
  const newReadable = toReadableMessages(realMessages, attachmentsMap);
  s.messages = isContinuation ? [...(s.messages ?? []), ...newReadable] : newReadable;
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
  if (!isValidSessionId(id)) return null;
  return read(id);
}

export function deleteSession(id) {
  if (!isValidSessionId(id)) return false;
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
  if (!isValidSessionId(id)) return false;
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
