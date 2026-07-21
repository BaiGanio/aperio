// tests/lib/helpers/redactSecrets.test.js
// PRIVACY-01 — secret scrubbing before cloud egress.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactMessages } from "../../lib/helpers/redactSecrets.js";

describe("redactSecrets", () => {
  test("redacts an Anthropic-style key", () => {
    const out = redactSecrets("key is sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF here");
    assert.match(out, /\[REDACTED:api-key\]/);
    assert.doesNotMatch(out, /sk-ant-api03/);
  });

  test("redacts a GitHub token", () => {
    const out = redactSecrets("ghp_" + "a".repeat(36));
    assert.equal(out, "[REDACTED:github-token]");
  });

  test("redacts an AWS access key id", () => {
    assert.equal(redactSecrets("AKIAIOSFODNN7EXAMPLE"), "[REDACTED:aws-key]");
  });

  test("redacts a Google API key", () => {
    const out = redactSecrets("AIza" + "b".repeat(35));
    assert.equal(out, "[REDACTED:google-key]");
  });

  test("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    assert.equal(redactSecrets(jwt), "[REDACTED:jwt]");
  });

  test("redacts a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc123\n-----END RSA PRIVATE KEY-----";
    assert.equal(redactSecrets(pem), "[REDACTED:private-key]");
  });

  test("redacts the password in a postgres URI but keeps the rest", () => {
    const out = redactSecrets("DATABASE_URL=postgresql://aperio:s3cr3tPass@db.host:5432/aperio");
    assert.match(out, /postgresql:\/\/aperio:\[REDACTED:uri-password\]@db\.host/);
  });

  test("redacts an assigned secret value", () => {
    const out = redactSecrets('api_key="abcdef123456"');
    assert.match(out, /api_key.*\[REDACTED:assigned-secret\]/);
    assert.doesNotMatch(out, /abcdef123456/);
  });

  test("leaves ordinary prose untouched", () => {
    const prose = "The quick brown fox writes a function to summarize the document.";
    assert.equal(redactSecrets(prose), prose);
  });

  test("non-string input passes through", () => {
    assert.equal(redactSecrets(null), null);
    assert.equal(redactSecrets(42), 42);
  });
});

describe("redactMessages", () => {
  test("scrubs string content", () => {
    const out = redactMessages([{ role: "user", content: "token ghp_" + "a".repeat(36) }]);
    assert.equal(out[0].content, "token [REDACTED:github-token]");
  });

  test("scrubs text blocks, preserves non-text structure", () => {
    const msgs = [{
      role: "user",
      content: [
        { type: "text", text: "AKIAIOSFODNN7EXAMPLE" },
        { type: "tool_result", tool_use_id: "x", is_error: false },
      ],
    }];
    const out = redactMessages(msgs);
    assert.equal(out[0].content[0].text, "[REDACTED:aws-key]");
    assert.deepEqual(out[0].content[1], { type: "tool_result", tool_use_id: "x", is_error: false });
  });

  test("does not mutate the input", () => {
    const msgs = [{ role: "user", content: "AKIAIOSFODNN7EXAMPLE" }];
    redactMessages(msgs);
    assert.equal(msgs[0].content, "AKIAIOSFODNN7EXAMPLE");
  });
});
