// tests/lib/helpers/envFile.test.js
// Tests for .env file helpers.
//
// envQuote and setKey are pure string-transform functions and are tested
// directly. writeEnvFromWizard touches the filesystem at hardcoded paths
// (ROOT/.env and ROOT/.env.example) determined at module load time — we
// save/restore those files around the tests.

import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

import { envQuote, setKey, writeEnvFromWizard } from "../../../lib/helpers/envFile.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const ENV_PATH = resolve(ROOT, ".env");
const EXAMPLE_PATH = resolve(ROOT, ".env.example");

// Snapshots of the real files so we can restore after tests that modify them.
let originalEnv = null;
let originalExample = null;

before(() => {
  if (existsSync(ENV_PATH))    originalEnv     = readFileSync(ENV_PATH, "utf8");
  if (existsSync(EXAMPLE_PATH)) originalExample = readFileSync(EXAMPLE_PATH, "utf8");
});

after(() => {
  // Restore originals, or delete files that didn't exist originally
  if (originalEnv !== null) writeFileSync(ENV_PATH, originalEnv, "utf8");
  else if (existsSync(ENV_PATH)) unlinkSync(ENV_PATH);

  if (originalExample !== null) writeFileSync(EXAMPLE_PATH, originalExample, "utf8");
  else if (existsSync(EXAMPLE_PATH)) unlinkSync(EXAMPLE_PATH);
});

// =============================================================================
// envQuote
// =============================================================================

describe("envQuote", () => {
  test("wraps a plain string in double quotes", () => {
    assert.strictEqual(envQuote("hello"), '"hello"');
  });

  test("escapes backslashes", () => {
    assert.strictEqual(envQuote("a\\b"), '"a\\\\b"');
  });

  test("escapes double quotes inside the value", () => {
    assert.strictEqual(envQuote('say "hi"'), '"say \\"hi\\""');
  });

  test("replaces newlines with spaces", () => {
    assert.strictEqual(envQuote("line1\nline2\r\nline3"), '"line1 line2 line3"');
  });

  test("strips control characters (null, escape, etc.) but preserves tab", () => {
    // Tab (\x09) is intentionally excluded from the strip regex — it's printable.
    assert.strictEqual(envQuote("a\x00b\x01c"), '"abc"');
  });

  test("coerces non-string inputs", () => {
    assert.strictEqual(envQuote(42), '"42"');
    assert.strictEqual(envQuote(undefined), '"undefined"');
  });

  test("handles empty string", () => {
    assert.strictEqual(envQuote(""), '""');
  });
});

// =============================================================================
// setKey
// =============================================================================

describe("setKey", () => {
  test("replaces an existing key in the content", () => {
    const result = setKey("PORT=3000\nAI_PROVIDER=ollama\n", "AI_PROVIDER", "anthropic");
    assert.strictEqual(result, 'PORT=3000\nAI_PROVIDER="anthropic"\n');
  });

  test("appends a key that does not exist yet", () => {
    const result = setKey("PORT=3000\n", "AI_PROVIDER", "ollama");
    assert.strictEqual(result, 'PORT=3000\nAI_PROVIDER="ollama"\n');
  });

  test("preserves comments and other content", () => {
    const result = setKey("# This is a comment\nPORT=3000\n", "PORT", "8080");
    assert.strictEqual(result, '# This is a comment\nPORT="8080"\n');
  });

  test("treats $ in the value as literal (not a backreference)", () => {
    const result = setKey("KEY=old\n", "KEY", "$pecial$");
    assert.strictEqual(result, 'KEY="$pecial$"\n');
  });

  test("adds a newline at the end when appending to empty content", () => {
    const result = setKey("", "MY_KEY", "myval");
    assert.strictEqual(result, '\nMY_KEY="myval"\n');
  });

  test("replaces only the first occurrence (uncommented line)", () => {
    const result = setKey("PORT=3000\n#PORT=4000\n", "PORT", "5000");
    assert.strictEqual(result, 'PORT="5000"\n#PORT=4000\n');
  });
});

// =============================================================================
// writeEnvFromWizard  (filesystem — save/restore)
// =============================================================================

describe("writeEnvFromWizard", () => {
  beforeEach(() => {
    // The wizard only CREATES a .env, so each "writes …" case starts from a
    // clean slate (no .env → seeds from .env.example). The preservation test
    // below writes its own .env first to exercise the never-overwrite guard.
    if (existsSync(ENV_PATH)) unlinkSync(ENV_PATH);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  test("throws for unknown provider", () => {
    assert.throws(
      () => writeEnvFromWizard({ provider: "unknown" }),
      /Unknown provider/,
    );
  });

  test("throws for cloud provider without API key", () => {
    assert.throws(
      () => writeEnvFromWizard({ provider: "anthropic" }),
      /requires an API key/,
    );
  });

  test("throws for ollama without model", () => {
    assert.throws(
      () => writeEnvFromWizard({ provider: "ollama" }),
      /ollama requires a model/,
    );
  });

  // ── Success paths ───────────────────────────────────────────────────────────

  test("writes .env for ollama provider", () => {
    writeEnvFromWizard({ provider: "ollama", model: "llama3.1" });
    const env = readFileSync(ENV_PATH, "utf8");
    assert.match(env, /^AI_PROVIDER="ollama"$/m);
    assert.match(env, /^OLLAMA_MODEL="llama3\.1"$/m);
  });

  test("writes .env for anthropic with API key and model", () => {
    writeEnvFromWizard({ provider: "anthropic", apiKey: "sk-ant-xxx", model: "claude-sonnet-4-6" });
    const env = readFileSync(ENV_PATH, "utf8");
    assert.match(env, /^AI_PROVIDER="anthropic"$/m);
    assert.match(env, /^ANTHROPIC_API_KEY="sk-ant-xxx"$/m);
    assert.match(env, /^ANTHROPIC_MODEL="claude-sonnet-4-6"$/m);
  });

  test("writes .env for deepseek with API key", () => {
    writeEnvFromWizard({ provider: "deepseek", apiKey: "sk-ds-xxx" });
    const env = readFileSync(ENV_PATH, "utf8");
    assert.match(env, /^AI_PROVIDER="deepseek"$/m);
    assert.match(env, /^DEEPSEEK_API_KEY="sk-ds-xxx"$/m);
  });

  test("writes .env for gemini with API key and port", () => {
    writeEnvFromWizard({ provider: "gemini", apiKey: "gm-xxx", port: 3456 });
    const env = readFileSync(ENV_PATH, "utf8");
    assert.match(env, /^AI_PROVIDER="gemini"$/m);
    assert.match(env, /^GEMINI_API_KEY="gm-xxx"$/m);
    assert.match(env, /^PORT="3456"$/m);
  });

  // ── The holy grail: an existing .env is never overwritten ───────────────────

  test("never overwrites an existing .env — leaves it byte-for-byte untouched", () => {
    // A code user's hand-edited .env. Re-running setup (e.g. after
    // var/bootstrap.lock was lost) must not touch it at all.
    const original = [
      'AI_PROVIDER="anthropic"',
      'ANTHROPIC_API_KEY="sk-real-user-key"',
      'OLLAMA_MODEL="old-model"',
      'ROUNDTABLE_AGENTS="3"',
      'APERIO_DOCGRAPH="on"',
      "",
    ].join("\n");
    writeFileSync(ENV_PATH, original, "utf8");

    // Even with otherwise-valid wizard input, the existing .env wins.
    const result = writeEnvFromWizard({ provider: "ollama", model: "llama3.1" });

    assert.equal(result, ENV_PATH);
    assert.equal(readFileSync(ENV_PATH, "utf8"), original);
  });

  after(() => {
    if (existsSync(ENV_PATH)) unlinkSync(ENV_PATH);
  });
});
