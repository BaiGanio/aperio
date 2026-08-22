// lib/helpers/sessionCrypto.js
// SESSION-01 — opt-in at-rest encryption for session files.
//
// Sessions hold full conversation history (already 0600 from DATA-01). When
// APERIO_SESSION_KEY is set we additionally encrypt the JSON with AES-256-GCM
// so the transcript is unreadable even if the file is copied off the host.
// The key is stretched with scrypt; GCM gives authenticated encryption so a
// tampered file fails to decrypt rather than yielding garbage.
//
// Backwards compatible: when no key is set, sessions are stored as plaintext
// JSON exactly as before, and a plaintext file always decodes regardless of the
// key (so turning encryption on later doesn't strand existing sessions).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const MAGIC      = "APERIO-ENC1:";   // marks an encrypted envelope
const SALT       = "aperio-session-v1";
const IV_LEN     = 12;               // 96-bit nonce, recommended for GCM
const TAG_LEN    = 16;

// 32-byte key derived from APERIO_SESSION_KEY. Returns null when it isn't set
// → encryption is a no-op. Kept independent of APERIO_AUTH_TOKEN so enabling
// network auth doesn't silently change the on-disk session format.
function sessionKey() {
  const secret = process.env.APERIO_SESSION_KEY;
  if (!secret) return null;
  return scryptSync(secret, SALT, 32);
}

export function encryptionEnabled() {
  return sessionKey() !== null;
}

function encrypt(plaintext, key) {
  const iv     = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct     = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return MAGIC + Buffer.concat([iv, tag, ct]).toString("base64");
}

function decrypt(envelope, key) {
  const buf = Buffer.from(envelope.slice(MAGIC.length), "base64");
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct  = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// Serialize a session object to the string written on disk.
export function encodeSession(obj) {
  const json = JSON.stringify(obj, null, 2);
  const key  = sessionKey();
  return key ? encrypt(json, key) : json;
}

// Parse a string read from disk back into a session object. Auto-detects the
// encrypted envelope; plaintext JSON is parsed directly. Throws on failure
// (callers already wrap reads in try/catch).
export function decodeSession(raw) {
  if (typeof raw === "string" && raw.startsWith(MAGIC)) {
    const key = sessionKey();
    if (!key) throw new Error("session is encrypted but no APERIO_SESSION_KEY is set");
    return JSON.parse(decrypt(raw, key));
  }
  return JSON.parse(raw);
}
