// lib/helpers/secureFile.js
// DATA-01 — helpers for writing local state (sessions, handoffs) that may carry
// personal data or secrets. Files land 0600 and their dirs 0700 so other OS
// users can't read them. writeFileSync's `mode` is ignored when the file already
// exists, so we chmod explicitly after every write (same gotcha as SECRET-01).

import { writeFileSync, mkdirSync, chmodSync, existsSync } from "fs";

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
