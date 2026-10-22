// lib/db-connect/drivers/managed-sqlite.js
//
// Encryption-aware open/close for Aperio-OWNED sqlite files — never a user's
// own external database; encrypting someone else's file with Aperio's key
// would be wrong, so this is only ever used for connections this app itself
// provisions and marks `provisioned: true` (currently just the self-
// provisioned `extraction` connection, #250 WS1).
//
// Honors APERIO_DB_ENCRYPT exactly the way the app's own store already does
// (db/encrypt.js): the file on disk IS the encrypted blob; opening decrypts
// it to a scratch temp file, closing re-encrypts the temp file back and
// removes it. The key itself is resolved here, once per process — a keychain
// shell-out on every db_execute/db_query call would be a real latency
// regression, so the result is cached the same way secrets.js caches its own
// key. createManagedSqliteFile / openManagedSqlite themselves still take the
// key as an explicit parameter (mirroring prepareDatabase / finalizeDatabase's
// own signature), so they stay trivially testable with a fixed key and never
// have to touch the OS keychain in a unit test.
//
// Both functions hold lib/db-connect/file-lock.js's cross-process lock
// (keyed by `${file}.lock`) for their FULL lifecycle — provisioning, and
// open→use→close — not just the initial call. Aperio explicitly supports
// several MCP processes per agent session and Postgres as a multi-agent
// backend, so two SEPARATE processes can legitimately target the SAME
// managed file at once; without a cross-process lock, both would decrypt to
// the same deterministic plaintext temp path, and either process's close()
// could delete it out from under the other's still-open handle, silently
// losing a confirmed write (P1 review finding).

import Database from "better-sqlite3";
import { existsSync, unlinkSync, renameSync } from "fs";
import { randomBytes } from "crypto";
import { SqliteDriver } from "./sqlite.js";
import { isEncryptionEnabled, getOrCreateKey, encryptFile, decryptFile, isPlaintextSqlite, prepareDatabase, finalizeDatabase } from "../../../db/encrypt.js";
import { decryptDbFileInPlace } from "../../../db/sqlite/encryption.js";
import { acquireLock } from "../file-lock.js";

let cachedKey; // undefined = not yet resolved; null = encryption off; Buffer = resolved

/** The encryption key for Aperio-managed sqlite files, resolved from the OS
 *  keychain at most once per process. Null when APERIO_DB_ENCRYPT is off. */
export function managedEncryptionKey() {
  if (cachedKey !== undefined) return cachedKey;
  cachedKey = isEncryptionEnabled() ? getOrCreateKey() : null;
  return cachedKey;
}

/** SQLite never writes its header page until the first actual write
 *  transaction — a brand-new Database that's opened and closed without one
 *  is a genuine 0-byte file on disk. `prepareDatabase`'s own decrypt-then-
 *  verify step insists on seeing the real magic header, so the scratch file
 *  must be forced to materialize it before encrypting; setting user_version
 *  (a no-op value, but a real write) is the smallest operation that does. */
function forceHeaderWrite(db) {
  db.pragma("user_version = 0");
}

const lockPathFor = (file) => `${file}.lock`;

function removeArtifacts(path) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { unlinkSync(path + suffix); } catch { /* already gone */ }
  }
}

/**
 * True when `file` already holds a genuinely complete, valid managed
 * database for the CURRENT encryption mode — never just "a file exists at
 * this path". A process crash between creating the file and finishing its
 * header write (plaintext) or its final encrypted write (encrypted) can
 * leave a zero-byte or truncated file behind; a bare existsSync check can't
 * tell that apart from a real one, and treating it as "already provisioned"
 * registers a connection that can never open again — SQLite refuses a
 * malformed file, and the encryption-off reconcile path can even
 * misidentify the wreckage as "must be encrypted" and request a key that
 * was never actually used (P2 review finding).
 */
function isValidManagedFile(file, keyBuf) {
  if (!existsSync(file)) return false;
  if (!keyBuf) return isPlaintextSqlite(file);

  const probe = `${file}.validate-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    decryptFile(file, probe, keyBuf);
    return isPlaintextSqlite(probe);
  } catch {
    return false;
  } finally {
    try { unlinkSync(probe); } catch { /* never created, or already gone */ }
  }
}

/**
 * Create a brand-new managed sqlite file at `file` if it doesn't already
 * hold a valid one. When `keyBuf` is supplied, the file is written straight
 * to disk as an encrypted blob — the plaintext form never persists at
 * `file`, not even transiently.
 *
 * Written via a scratch path and an atomic rename into place, never directly
 * at `file` — a process crash mid-write (or mid-encrypt) would otherwise
 * leave a zero-byte or truncated file AT `file` itself (see
 * isValidManagedFile). With an atomic rename, `file` only ever holds a
 * complete write; an interrupted attempt leaves nothing there to
 * misidentify, and a subsequent call's isValidManagedFile check recovers by
 * simply replacing the leftover wreckage.
 *
 * Async: held under the cross-process lock for its full duration, so two
 * processes racing to provision the SAME file for the first time serialize
 * instead of writing to the same scratch/destination paths at once.
 */
export async function createManagedSqliteFile(file, keyBuf) {
  const release = await acquireLock(lockPathFor(file));
  try {
    if (isValidManagedFile(file, keyBuf)) return;

    const scratch = `${file}.init-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
    try {
      const db = new Database(scratch);
      forceHeaderWrite(db);
      db.close();

      if (!keyBuf) {
        renameSync(scratch, file);
        return;
      }

      const encScratch = `${scratch}.enc`;
      try {
        encryptFile(scratch, encScratch, keyBuf);
        renameSync(encScratch, file);
      } finally {
        try { unlinkSync(encScratch); } catch { /* moved into place, or never created */ }
      }
    } finally {
      try { unlinkSync(scratch); } catch { /* already gone */ }
    }
  } finally {
    release();
  }
}

/** Wrap a driver's close() so releasing the cross-process lock (and, when
 *  supplied, finalizing the encrypted write-back) happens exactly once,
 *  right after the underlying handle closes — never before, so the next
 *  queued opener never sees a half-closed predecessor. `release()` runs
 *  from its OWN nested finally: if `onClose` throws (e.g. finalizeDatabase
 *  fails because the disk is full or the destination becomes unwritable), a
 *  bare sibling statement after it would never run — the lock would stay
 *  held forever and every subsequent open for this file would hang, in any
 *  process. Nesting guarantees release() always fires, and the original
 *  error still propagates after it. */
function releaseLockOnClose(driver, release, onClose) {
  const baseClose = driver.close.bind(driver);
  driver.close = () => {
    try {
      return baseClose();
    } finally {
      try {
        onClose?.();
      } finally {
        release();
      }
    }
  };
  return driver;
}

/**
 * Open a managed sqlite file for one call. When `keyBuf` is supplied the
 * caller MUST call the returned driver's close() exactly once — that is the
 * only point a write gets re-encrypted back to `file`; skipping it leaves
 * writes stranded in a scratch temp file (never lost, but never saved back
 * either, so the confirm-before-write flow's own finally-block close() is
 * load-bearing here, not just tidy).
 *
 * When `keyBuf` is null (encryption off) but a prior run left the file
 * encrypted, it's reconciled — decrypted in place with the still-existing
 * key — the same one-time migration db/sqlite/store.js already performs for
 * the app's own primary store; a managed file needs the same transition or
 * it opens as garbage (SQLITE_NOTADB) forever once encryption is disabled.
 *
 * Async: opening for a given file waits its turn behind the cross-process
 * lock (see the module comment) — held by a previous, not-yet-closed open
 * of the SAME file, in THIS process or any other.
 */
export async function openManagedSqlite({ file, readOnly = false, keyBuf = null }) {
  const release = await acquireLock(lockPathFor(file));
  let tempPath;
  try {
    if (!keyBuf) {
      if (existsSync(file) && !isPlaintextSqlite(file)) decryptDbFileInPlace(file);
      const driver = new SqliteDriver(new Database(file, { readonly: readOnly, fileMustExist: true }), { readOnly, ownsHandle: true });
      return releaseLockOnClose(driver, release);
    }

    tempPath = prepareDatabase(file, keyBuf);
    const db = new Database(tempPath, { readonly: readOnly, fileMustExist: true });
    const driver = new SqliteDriver(db, { readOnly, ownsHandle: true });
    return releaseLockOnClose(driver, release, () => finalizeDatabase(file, tempPath, keyBuf));
  } catch (err) {
    // prepareDatabase already wrote the FULL plaintext database to tempPath
    // before the Database constructor ran; if SQLite then refuses to open
    // it, that plaintext must not linger on disk indefinitely — the
    // encrypted source at `file` is untouched, so there is nothing else to
    // preserve here (P2 review finding).
    if (tempPath) removeArtifacts(tempPath);
    release();
    throw err;
  }
}
