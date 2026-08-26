// lib/helpers/secureFile.js
// DATA-01 — helpers for writing local state (sessions, handoffs) that may carry
// personal data or secrets. Files land 0600 and their dirs 0700 so other OS
// users can't read them. writeFileSync's `mode` is ignored when the file already
// exists, so we chmod explicitly after every write (same gotcha as SECRET-01).

import { writeFileSync, mkdirSync, chmodSync, existsSync, openSync, closeSync } from "fs";
import logger from "./logger.js";

// mkdir -p with private (0700) permissions, hardened on every call.
export function ensureSecureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dirs */ }
}

// Write a file 0600, creating it private and forcing the mode if it pre-existed.
export function writeSecureFile(path, data, encoding = "utf-8") {
  const existed = existsSync(path);
  writeFileSync(path, data, { encoding, mode: 0o600 });
  if (existed) {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  }
}

// Force an already-existing file to 0600. Needed for files a third-party library
// creates for us (better-sqlite3 opens the database itself, so no `mode` can be
// passed at creation time and the process umask decides — 0644 by default).
// Two failures are expected and stay silent: the file is absent (WAL/SHM
// sidecars appear lazily, so callers harden opportunistically on every open)
// and Windows, which has no POSIX modes to set. Anything else means the file is
// still readable by other local users and we could not fix it — that is a real
// security gap (a group-owned database we can write but not chmod, a filesystem
// that rejects mode changes), so it is logged loudly instead of swallowed.
// Returns true only when the mode is now 0600.
export function restrictFileMode(path) {
  try {
    chmodSync(path, 0o600);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;      // sidecar not created (yet)
    if (process.platform === "win32") return false; // no POSIX modes to set
    logger.warn(
      `[secure-file] could not set 0600 on ${path} (${err?.code || err?.message}) — ` +
      `it may stay readable by other users on this machine`
    );
    return false;
  }
}

// Create `path` with 0600 *before* a third-party library opens it. better-sqlite3
// creates the database under the process umask, so without this there is a window
// where the file exists at 0644 and a local user can open it and keep the
// descriptor while migrations and settings are written — a later chmod cannot
// revoke an already-open handle. `a` only applies `mode` when it creates the
// file, so an existing database keeps its mode (restrictFileMode fixes that).
export function precreateSecureFile(path) {
  try {
    closeSync(openSync(path, "a", 0o600));
    return true;
  } catch (err) {
    logger.debug(`[secure-file] pre-create skipped for ${path}: ${err?.message}`);
    return false;
  }
}
