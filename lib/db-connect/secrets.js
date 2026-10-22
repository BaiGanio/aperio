// lib/db-connect/secrets.js
//
// Field-level encryption for external-database connection passwords (issue #170).
// Connections are stored DB-backed in the settings store; the password field is
// encrypted here so it is never persisted in clear text, independent of whether
// whole-database encryption (APERIO_DB_ENCRYPT) is also on.
//
// Trust model: AES-256-GCM with a 256-bit machine-local key kept in
// var/db-connect.key (0600). The key file is the trust root — same trust level
// as the database file itself. No cloud, no shared secret. Decryption only
// happens server-side when actually opening a connection; the password is never
// returned by db_connections or the config schema (see maskConnection).

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ALGORITHM = "aes-256-gcm";
const NONCE_LEN = 12;
const TAG_LEN = 16;
const PREFIX = "enc:v1:"; // marks an encrypted blob so we can detect/skip plaintext

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KEY_PATH = join(ROOT, "var", "db-connect.key");

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  if (existsSync(KEY_PATH)) {
    const hex = readFileSync(KEY_PATH, "utf8").trim();
    if (hex.length === 64) {
      cachedKey = Buffer.from(hex, "hex");
      return cachedKey;
    }
  }
  // First use (or corrupt key): provision a fresh one with restrictive perms.
  const hex = randomBytes(32).toString("hex");
  mkdirSync(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(KEY_PATH, hex, { mode: 0o600, encoding: "utf8" });
  cachedKey = Buffer.from(hex, "hex");
  return cachedKey;
}

/** Encrypt a secret string. Empty/nullish → "" (nothing to protect). */
export function encryptSecret(plain) {
  if (plain == null || plain === "") return "";
  if (typeof plain === "string" && plain.startsWith(PREFIX)) return plain; // already encrypted
  const key = loadKey();
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([nonce, ct, tag]).toString("base64");
}

/** Decrypt a value produced by encryptSecret. Plaintext (no prefix) passes through. */
export function decryptSecret(blob) {
  if (blob == null || blob === "") return "";
  if (typeof blob !== "string" || !blob.startsWith(PREFIX)) return blob; // legacy/plaintext
  const buf = Buffer.from(blob.slice(PREFIX.length), "base64");
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(NONCE_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, loadKey(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Whether a value is one of our encrypted blobs. */
export function isEncrypted(v) {
  return typeof v === "string" && v.startsWith(PREFIX);
}
