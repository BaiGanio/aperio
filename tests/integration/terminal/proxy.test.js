// Tests for proxy.js — proxyModelVar
//
// The extracted function proxyModelVar maps AI_PROVIDER names to the
// corresponding model env-var. Pure function — no mocking needed.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { proxyModelVar } from "../../../lib/terminal/proxy.js";

describe("proxyModelVar", () => {
  // ─── Known providers ──────────────────────────────────────────────────────

  test('maps "llamacpp" to LLAMACPP_MODEL', () => {
    assert.strictEqual(proxyModelVar("llamacpp"), "LLAMACPP_MODEL");
  });

  test('maps "LLAMACPP" (uppercase) to LLAMACPP_MODEL (case-insensitive)', () => {
    assert.strictEqual(proxyModelVar("LLAMACPP"), "LLAMACPP_MODEL");
  });

  test('maps "deepseek" to DEEPSEEK_MODEL', () => {
    assert.strictEqual(proxyModelVar("deepseek"), "DEEPSEEK_MODEL");
  });

  test('maps "gemini" to GEMINI_MODEL', () => {
    assert.strictEqual(proxyModelVar("gemini"), "GEMINI_MODEL");
  });

  test('maps "codex" to CODEX_MODEL', () => {
    assert.strictEqual(proxyModelVar("codex"), "CODEX_MODEL");
  });

  // ─── Fallback ─────────────────────────────────────────────────────────────

  test('maps "anthropic" to ANTHROPIC_MODEL (fallback)', () => {
    assert.strictEqual(proxyModelVar("anthropic"), "ANTHROPIC_MODEL");
  });

  test("maps unknown provider to ANTHROPIC_MODEL (fallback)", () => {
    assert.strictEqual(proxyModelVar("unknown-provider"), "ANTHROPIC_MODEL");
  });

  test("maps empty string to ANTHROPIC_MODEL (fallback)", () => {
    assert.strictEqual(proxyModelVar(""), "ANTHROPIC_MODEL");
  });

  test("maps undefined to ANTHROPIC_MODEL (fallback)", () => {
    assert.strictEqual(proxyModelVar(undefined), "ANTHROPIC_MODEL");
  });

  test("maps null to ANTHROPIC_MODEL (fallback)", () => {
    assert.strictEqual(proxyModelVar(null), "ANTHROPIC_MODEL");
  });
});
