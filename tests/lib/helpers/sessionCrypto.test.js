// tests/lib/helpers/sessionCrypto.test.js
// SESSION-01 — opt-in AES-256-GCM encryption for session files.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { encodeSession, decodeSession, encryptionEnabled } from "../../../lib/helpers/sessionCrypto.js";

const sample = { id: "abc", title: "secret chat", messages: [{ role: "user", content: "hi" }] };

afterEach(() => {
  delete process.env.APERIO_SESSION_KEY;
  delete process.env.APERIO_AUTH_TOKEN;
});

describe("sessionCrypto", () => {
  test("no key → plaintext JSON round-trips (back-compat)", () => {
    const raw = encodeSession(sample);
    assert.ok(!raw.startsWith("APERIO-ENC1:"));
    assert.deepEqual(JSON.parse(raw), sample);          // it's literally JSON
    assert.deepEqual(decodeSession(raw), sample);
    assert.equal(encryptionEnabled(), false);
  });

  test("with key → ciphertext envelope round-trips", () => {
    process.env.APERIO_SESSION_KEY = "a-strong-key";
    const raw = encodeSession(sample);
    assert.ok(raw.startsWith("APERIO-ENC1:"));
    assert.ok(!raw.includes("secret chat"));            // plaintext not present
    assert.deepEqual(decodeSession(raw), sample);
    assert.equal(encryptionEnabled(), true);
  });

  test("plaintext still decodes even when a key is set (turning encryption on later)", () => {
    const plain = encodeSession(sample);                // written with no key
    process.env.APERIO_SESSION_KEY = "a-strong-key";
    assert.deepEqual(decodeSession(plain), sample);
  });

  test("encrypted file is unreadable without the key", () => {
    process.env.APERIO_SESSION_KEY = "a-strong-key";
    const raw = encodeSession(sample);
    delete process.env.APERIO_SESSION_KEY;
    assert.throws(() => decodeSession(raw), /no APERIO_SESSION_KEY/);
  });

  test("tampered ciphertext fails authentication", () => {
    process.env.APERIO_SESSION_KEY = "a-strong-key";
    const raw = encodeSession(sample);
    // Flip a byte in the base64 body.
    const body = raw.slice("APERIO-ENC1:".length);
    const tampered = "APERIO-ENC1:" + (body[0] === "A" ? "B" : "A") + body.slice(1);
    assert.throws(() => decodeSession(tampered));
  });

  test("APERIO_AUTH_TOKEN alone does NOT enable encryption", () => {
    process.env.APERIO_AUTH_TOKEN = "auth-secret";
    assert.equal(encryptionEnabled(), false);
    const raw = encodeSession(sample);
    assert.ok(!raw.startsWith("APERIO-ENC1:"));   // plaintext
  });
});
