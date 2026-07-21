// lib/helpers/llamacpp/sessionLog.js — per-session live tee of the shared
// llama-server log, so a single session can be debugged in isolation.
//
//   createSession    → beginSessionLog(id) creates var/llamacpp/{id}.log
//                      immediately and enrolls it in the tee
//   (every second)   → pumpServerLogTee() appends the bytes server.log grew
//                      by to every active session's log
//   finaliseSession  → endSessionLog(id) drains and unenrolls; an empty log
//                      (session never touched llama-server) is removed
//   deleteSessionLog → delete var/llamacpp/{id}.log (explicit session delete)
//   pruneServerLogs  → daily sweep; these files are debugging aids with no
//                      lasting value, kept LLAMACPP_LOG_RETENTION_DAYS (1 by
//                      default), independent of the session's own retention
//
// Written live (not copied at finalisation) deliberately: a crash of the app
// or of llama-server itself is exactly what these logs exist to diagnose, and
// a write-at-end scheme loses the log in every crash. Concurrent sessions
// each receive the full server output for their lifetime — llama-server is
// one shared process, so its log can't be attributed to a single session.

import { writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, readdirSync, readSync, appendFileSync } from "fs";
import { join } from "path";
import { PRESET_DIR, SERVER_LOG_PATH } from "./constants.js";

const TEE_INTERVAL_MS = 1000;
const activeSessionLogs = new Set(); // session ids currently enrolled
let teePos = 0;                      // how far into server.log we've copied
let teeTimer = null;

function sessionLogPath(id) {
  return join(PRESET_DIR, `${id}.log`);
}

// Drop NUL bytes from a log chunk. llama-server output is plain text, so any
// 0x00 is corruption — most often the zero-fill left when a file is truncated
// (openSync "w") out from under a stale child fd that then writes at its old
// offset. Stripping here guarantees a human-readable session log no matter how
// the shared server.log got holed; the unlink-before-recreate at spawn stops
// the hole forming in the first place, this is the belt to that suspenders.
function stripNuls(buf) {
  if (!buf.includes(0)) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) { const b = buf[i]; if (b !== 0) out[n++] = b; }
  return out.subarray(0, n);
}

/**
 * Copy whatever server.log grew by since the last pump to every active
 * session log. Runs on a 1s timer between beginSessionLog/endSessionLog;
 * exported for tests. A shrunken server.log means a server restart truncated
 * it (spawn opens it with "w") — restart from 0 so active sessions capture
 * the new server's boot output too.
 */
export function pumpServerLogTee() {
  let size = 0;
  try { size = statSync(SERVER_LOG_PATH).size; } catch { size = 0; }
  if (size < teePos) teePos = 0;
  if (size === teePos) return;
  if (activeSessionLogs.size === 0) { teePos = size; return; }
  let chunk;
  try {
    const fd = openSync(SERVER_LOG_PATH, "r");
    try {
      const buf = Buffer.allocUnsafe(size - teePos);
      // readSync can return fewer bytes than requested; slice to what was
      // actually read so allocUnsafe's uninitialized tail never leaks into a log.
      const bytesRead = readSync(fd, buf, 0, buf.length, teePos);
      chunk = buf.subarray(0, bytesRead);
      teePos += bytesRead;
    } finally { closeSync(fd); }
  } catch { return; /* retry from the same position next pump */ }
  chunk = stripNuls(chunk);
  if (chunk.length === 0) return;
  for (const id of activeSessionLogs) {
    try { appendFileSync(sessionLogPath(id), chunk); } catch { /* best-effort */ }
  }
}

/**
 * Start a session's server log: create var/llamacpp/{id}.log (empty, so it is
 * visible and tail-able from the moment the session starts) and enroll it in
 * the tee. Called at session creation.
 */
export function beginSessionLog(id) {
  if (!id) return;
  // Tests must not write to the real filesystem. Allow the test runner to
  // suppress the per-session llama debug log with an env guard so mock-heavy
  // test files (wsHandler, etc.) never touch var/llamacpp/ on disk.
  if (process.env.APERIO_NO_LLAMA_LOG) return;
  try {
    mkdirSync(PRESET_DIR, { recursive: true });
    // Catch the tee up BEFORE enrolling, so output that predates this session
    // never leaks into its log.
    pumpServerLogTee();
    writeFileSync(sessionLogPath(id), "");
    activeSessionLogs.add(id);
    if (!teeTimer) {
      teeTimer = setInterval(pumpServerLogTee, TEE_INTERVAL_MS);
      teeTimer.unref?.();
    }
  } catch { /* best-effort */ }
}

/**
 * Finish a session's server log: drain any pending output, unenroll it, and
 * remove the file if the session never produced server output (e.g. it ran on
 * a cloud provider). Called at session finalisation — including for trivial
 * sessions that get discarded, whose debug log is deliberately KEPT for the
 * pruner's retention window.
 *
 * Returns true if a NON-EMPTY log was kept — the caller uses that to pair
 * session-keeping with "did this session actually exercise llama-server", so a
 * session that produced a debug log is never deleted out from under its log.
 */
export function endSessionLog(id) {
  if (!id) return false;
  try {
    pumpServerLogTee();
    activeSessionLogs.delete(id);
    if (activeSessionLogs.size === 0 && teeTimer) {
      clearInterval(teeTimer);
      teeTimer = null;
    }
    const p = sessionLogPath(id);
    if (statSync(p).size === 0) { unlinkSync(p); return false; }
    return true;
  } catch { return false; /* log already gone — nothing to clean */ }
}

/**
 * Append an Aperio-side llama.cpp diagnostic to the active session log.
 * llama-server errors normally arrive through server.log, but streamed API
 * errors (for example a mid-stream `Compute error.`) are observed by the
 * provider in this process instead of the child process. Keep those lines in
 * the same session file so it remains the useful diagnostic entry point.
 */
export function appendSessionLog(id, message) {
  if (!id || !activeSessionLogs.has(id) || !message) return;
  try {
    appendFileSync(sessionLogPath(id), `${new Date().toISOString()} [aperio] ${message}\n`);
  } catch { /* best-effort */ }
}

// Session log files are named {uuid}.log — never matches server.log,
// models.ini, or state.json, which live in the same directory.
const SESSION_LOG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/i;

/**
 * Delete session log files older than `retentionDays` (by mtime). Runs from
 * the daily llamacpp-log-prune worker; also catches logs orphaned by sessions
 * that were never finalised. Returns the number of files removed.
 */
export function pruneServerLogs(retentionDays = 1) {
  const days = Math.max(1, Number(retentionDays) || 1);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const f of readdirSync(PRESET_DIR)) {
      if (!SESSION_LOG_RE.test(f)) continue;
      const p = join(PRESET_DIR, f);
      try {
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; }
      } catch { /* raced with deletion — skip */ }
    }
  } catch { /* dir doesn't exist yet */ }
  return removed;
}

/**
 * Delete var/llamacpp/{id}.log. Called by deleteSessionLog during session
 * deletion and retention pruning. No-op when id is missing or file absent.
 */
export function deleteServerLog(id) {
  if (!id) return;
  try {
    const p = join(PRESET_DIR, `${id}.log`);
    if (existsSync(p)) unlinkSync(p);
  } catch { /* best-effort */ }
}
