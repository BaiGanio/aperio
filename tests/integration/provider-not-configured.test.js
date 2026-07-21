// tests/lib/provider-not-configured.test.js
// Test group D of the .env→DB settings plan (#252): a fresh install boots the
// local llama.cpp provider, the setup wizard persists tier-1 choices to DB
// settings (never .env), and an empty/unknown AI_PROVIDER is loud — never a
// silent key-less anthropic boot.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { resolveProvider } from "../../lib/providers/index.js";
import logger from "../../lib/helpers/logger.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("provider not-configured (#252 group D)", () => {
  let saved;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  test("D3: empty AI_PROVIDER → not-configured sentinel, never anthropic; warns once per process", () => {
    process.env.AI_PROVIDER = "";
    const warns = [];
    const origWarn = logger.warn;
    logger.warn = (...args) => { warns.push(args.join(" ")); };
    try {
      const p1 = resolveProvider();
      const p2 = resolveProvider();   // second resolve must not re-warn
      assert.equal(p1.name, "not-configured");
      assert.equal(p1.notConfigured, true);
      assert.equal(p1.client, null, "no cloud client may be constructed");
      assert.equal(p2.notConfigured, true);
      const mentions = warns.filter((w) => w.includes("AI_PROVIDER"));
      assert.equal(mentions.length, 1, `expected exactly one boot warning, got ${mentions.length}`);
      assert.match(mentions[0], /Settings/i, "warning must name Settings as the fix");
    } finally {
      logger.warn = origWarn;
    }
  });

  test("D3 edge: unknown AI_PROVIDER value is not-configured too (typo ≠ anthropic)", () => {
    process.env.AI_PROVIDER = "anthropicc";
    const p = resolveProvider();
    assert.equal(p.notConfigured, true);
    assert.equal(p.client, null);
  });

  test("explicit anthropic still resolves with a client", () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY= "[redacted]"
    const p = resolveProvider();
    assert.equal(p.name, "anthropic");
    assert.ok(p.client, "anthropic client constructed when explicitly chosen");
  });

  test("D1: the shipped template boots llamacpp with a non-empty model, zero edits", () => {
    const parsed = dotenv.parse(readFileSync(resolve(ROOT, ".env.example"), "utf8"));
    assert.equal(parsed.AI_PROVIDER, "llamacpp", ".env.example must default to the local engine");

    for (const [k, v] of Object.entries(parsed)) process.env[k] = v;
    const p = resolveProvider();
    assert.equal(p.name, "llamacpp");
    assert.ok(p.model && p.model.length, "RAM-tier fallback model resolved");
  });
});
