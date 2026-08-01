// lib/db-connect/file-lock.js
//
// A dependency-free, cross-process advisory lock (#250 WS1, P1 review
// finding). Aperio explicitly supports several MCP processes per agent
// session, and Postgres as a multi-agent backend (mcp/index.js, AGENTS.md) —
// an in-process-only lock (a JS Map, as managed-sqlite.js used to have) does
// nothing to stop TWO SEPARATE processes from both decrypting the same
// APERIO_DB_ENCRYPT-managed file to the same deterministic plaintext temp
// path at once. Either process's close() can then delete that temp file out
// from under the other's still-open handle, silently losing a confirmed
// write. This lock is held for the FULL open→use→close (or provision)
// lifecycle, not just the initial call, so only one process — and, since the
// same primitive also serializes same-process callers (Node's fs 'Sync'
// calls plus the single-threaded event loop mean only one can be mid-attempt
// at a time), only one caller within that process — ever has the file
// decrypted and writable at once.
//
// Implementation: a lock FILE created with O_EXCL ('wx'), which the OS
// guarantees only one creator can succeed at, even across processes, on any
// local filesystem (this is the standard "lockfile" technique). A holder
// that crashes leaves the lock file behind. Reclamation is liveness-first:
// a lock whose pid is confirmably dead is reclaimed IMMEDIATELY, not after
// any elapsed-time threshold — a process that crashed and was restarted
// right away must not have its first operation guaranteed to time out
// waiting for a clock that never gated anything real (P2 review finding: the
// original single stale threshold was 30s, ABOVE the 15s acquire deadline,
// so a quick restart's reclaim attempt always lost the race against its own
// acquire deadline). A live pid is never stolen from
// regardless of elapsed time — a query that's merely slow (large file, disk
// contention) must not have its still-valid lock stolen by a second process,
// which could then delete or overwrite the first's still-open plaintext temp
// file (P1 review finding). UNREADABLE_LOCK_STALE_MS is only a fallback for a
// lock file whose pid can't be determined at all (e.g. a holder that crashed
// between creating the lock file and writing its pid into it, or a read
// caught mid-write) — it MUST stay well under ACQUIRE_TIMEOUT_MS: a threshold
// at or beyond the acquire deadline would let this exact crash scenario
// starve every acquirer's own attempt before the fallback ever got to fire
// (P2 review finding).
//
// A matching pid alone isn't proof of the SAME holder, though: after a crash
// (or reboot) leaves this lock file behind, the OS can and does reuse pids —
// an entirely unrelated later process can end up with the exact pid the dead
// holder had, and isAlive() would report it as still live forever, wedging
// every acquirer behind it until that unrelated process happens to exit (P2
// review finding). The lock file therefore also records the holder's process
// START TIME alongside its pid — stable for the life of that one process,
// and different for whatever process the OS later hands the same pid to.
// Read from /proc/<pid>/stat on Linux (plain fs, no subprocess, and this is
// the platform Aperio's actual multi-process scenario — several MCP
// processes / Postgres multi-agent, per the module comment above — runs on:
// Docker containers). Elsewhere, `ps -o lstart=` is used instead; only ever
// on this already-slow, already-polling reclaim path, never the hot
// uncontended acquire path. A mismatch means "this pid belongs to a
// different process now" and is reclaimed exactly like a confirmably-dead
// one; an undeterminable signature (lookup unavailable, or wasn't recorded
// by an older lock writer) falls back to trusting isAlive() alone, same as
// before this check existed — never a NEW way to steal a genuinely live
// holder's lock, only a way to stop trusting a pid that no longer means what
// it used to.

import { openSync, closeSync, writeSync, readFileSync, unlinkSync, statSync } from "fs";
import { platform } from "os";
import { execFileSync } from "child_process";

const POLL_MS = 50;
const ACQUIRE_TIMEOUT_MS = 15_000;
const UNREADABLE_LOCK_STALE_MS = 5_000; // << ACQUIRE_TIMEOUT_MS, so a fresh acquirer recovers within its own attempt

/** True if `pid` is a running process this OS user can see. EPERM means the
 *  process exists but is owned by someone else — still alive, just not
 *  signalable by us; only ESRCH means genuinely gone. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** A per-process signal that changes whenever the OS hands `pid` to a
 *  DIFFERENT process, even though the pid number itself repeats. Returns
 *  null when it can't be determined (process already gone, platform lookup
 *  unsupported/failed) — callers must treat null as "unknown", not "no
 *  match". */
function processStartSignature(pid) {
  if (platform() === "linux") {
    try {
      // /proc/<pid>/stat: fields are space-separated, but the 2nd field
      // (comm, the executable name in parens) can itself contain spaces and
      // parens — skip past its closing ')' before splitting the rest.
      // Field 22 overall (starttime, clock ticks since boot) is then index
      // 19 of the fields AFTER comm.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
      return afterComm.split(" ")[19] || null;
    } catch {
      return null;
    }
  }
  try {
    // macOS/BSD: no /proc. `ps -o lstart=` prints the process's absolute
    // wall-clock start time — stable across re-queries of the SAME process,
    // different for whatever process later reuses its pid.
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// This process's OWN start signature never changes for its lifetime, so it's
// computed at most once and cached — acquireLock's common, uncontended path
// (the first openSync('wx') just succeeds) must stay a plain fs call, not pay
// for a `ps` subprocess spawn on every single db_execute/db_query. Only the
// (rare, already-slow, already-polling) reclaim path below looks up ANOTHER
// process's signature fresh each time, since that pid's identity is exactly
// what's in question there.
let ownStartSignature; // undefined = not yet computed
function myStartSignature() {
  if (ownStartSignature === undefined) ownStartSignature = processStartSignature(process.pid) || "";
  return ownStartSignature;
}

function readHolderRecord(lockPath) {
  try {
    const [pidLine, sigLine] = readFileSync(lockPath, "utf8").split("\n");
    const pid = parseInt(pidLine, 10);
    return { pid: Number.isInteger(pid) ? pid : null, signature: sigLine || null };
  } catch {
    return { pid: null, signature: null };
  }
}

function reclaimIfStale(lockPath) {
  try {
    const { pid: holderPid, signature: recordedSignature } = readHolderRecord(lockPath);
    if (holderPid !== null) {
      // A pid we can identify: liveness decides it, not the clock. Dead means
      // abandoned (crash) — reclaim right away, however recently it was
      // written, so a fast restart isn't forced to wait out any elapsed-time
      // threshold. Alive is only trusted as "still the same holder" when its
      // start signature still matches what was recorded; a positively
      // confirmed mismatch means the pid was reused by an unrelated process,
      // which is exactly as reclaimable as a confirmably-dead one.
      if (!isAlive(holderPid)) { unlinkSync(lockPath); return; }
      if (recordedSignature) {
        const currentSignature = processStartSignature(holderPid);
        if (currentSignature && currentSignature !== recordedSignature) unlinkSync(lockPath);
      }
      return;
    }
    // No readable pid (corrupted lock file, or caught mid-write): fall back
    // to the elapsed-time heuristic as the only signal left.
    if (Date.now() - statSync(lockPath).mtimeMs > UNREADABLE_LOCK_STALE_MS) unlinkSync(lockPath);
  } catch { /* lock vanished (holder released it) or lost a race with another reclaimer — the next loop iteration retries cleanly either way */ }
}

/**
 * Acquire the lock at `lockPath`, waiting (with stale-lock reclamation) up
 * to ACQUIRE_TIMEOUT_MS. Returns a release() function; the caller MUST call
 * it exactly once when done — typically in a finally block — or every later
 * acquire attempt for the same path blocks until the stale-lock timeout.
 */
export async function acquireLock(lockPath) {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid}\n${myStartSignature()}`);
      closeSync(fd);
      return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      reclaimIfStale(lockPath);
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the lock at ${lockPath} — another process may be stuck holding it.`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}
