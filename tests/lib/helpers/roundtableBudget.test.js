import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { estimateOllamaFootprintGB, shouldEnableRoundtable } from "../../../lib/helpers/roundtableBudget.js";

describe("estimateOllamaFootprintGB", () => {
  test("estimates a non-zero footprint for local Ollama models", () => {
    const n = estimateOllamaFootprintGB("qwen3.5:9b", 30146, {
      OLLAMA_CONTEXT_LENGTH: "30146",
    });
    assert.ok(n > 0);
  });
});

describe("shouldEnableRoundtable", () => {
  test("allows cloud or mixed roundtable setups", () => {
    const r = shouldEnableRoundtable({
      totalRamGB: 16,
      mainProvider: { name: "anthropic", model: "claude-haiku-4-5-20251001" },
      primaryConfig: { name: "ollama", model: "qwen3.5:9b" },
      verifierConfig: { name: "anthropic", model: "claude-haiku-4-5-20251001" },
      env: { OLLAMA_CONTEXT_LENGTH: "30146" },
    });
    assert.equal(r.enabled, true);
  });

  test("dedupes repeated local models — same model everywhere stays enabled", () => {
    const r = shouldEnableRoundtable({
      totalRamGB: 16,
      mainProvider: { name: "ollama", model: "qwen3.5:9b" },
      primaryConfig: { name: "ollama", model: "qwen3.5:9b" },
      verifierConfig: { name: "ollama", model: "qwen3.5:9b" },
      env: { OLLAMA_CONTEXT_LENGTH: "30146" },
    });
    assert.equal(r.enabled, true);
  });

  test("skips the RAM check when Ollama runs on a remote host", () => {
    const r = shouldEnableRoundtable({
      totalRamGB: 8,
      mainProvider: { name: "ollama", model: "qwen3.5:9b" },
      primaryConfig: { name: "ollama", model: "phi4-mini:3.8b" },
      verifierConfig: { name: "ollama", model: "qwen3.5:4b" },
      env: { OLLAMA_CONTEXT_LENGTH: "30146", OLLAMA_BASE_URL: "http://192.168.1.100:11434" },
    });
    assert.equal(r.enabled, true);
  });

  test("modest two-model setups fit within the softened reserve", () => {
    const r = shouldEnableRoundtable({
      totalRamGB: 16,
      mainProvider: { name: "anthropic", model: "claude-haiku-4-5-20251001" },
      primaryConfig: { name: "ollama", model: "qwen2.5:3b" },
      verifierConfig: { name: "ollama", model: "qwen3.5:4b" },
      env: { OLLAMA_CONTEXT_LENGTH: "8192" },
    });
    assert.equal(r.enabled, true);
  });

  test("disables local roundtable when the estimated footprint exceeds budget", () => {
    const r = shouldEnableRoundtable({
      totalRamGB: 16,
      mainProvider: { name: "ollama", model: "qwen3.5:9b" },
      primaryConfig: { name: "ollama", model: "phi4-mini:3.8b" },
      verifierConfig: { name: "ollama", model: "qwen3.5:4b" },
      env: { OLLAMA_CONTEXT_LENGTH: "30146" },
    });
    assert.equal(r.enabled, false);
    assert.match(r.reason, /exceeds budget/);
  });
});
