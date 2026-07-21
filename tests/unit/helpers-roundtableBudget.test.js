import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { estimateLlamaCppFootprintGB, shouldEnableRoundtable } from "../../lib/helpers/roundtableBudget.js";

describe("estimateLlamaCppFootprintGB", () => {
  test("estimates a non-zero footprint for local llama.cpp models", () => {
    const n = estimateLlamaCppFootprintGB("qwen3.5:9b", 30146, {
      LLAMACPP_SERVE_CTX: "30146",
    });
    assert.ok(n > 0);
  });
});

describe("shouldEnableRoundtable", () => {
  test("allows cloud or mixed roundtable setups", () => {
    const r = shouldEnableRoundtable({
      totalRamGB: 16,
      mainProvider: { name: "anthropic", model: "claude-haiku-4-5-20251001" },
      primaryConfig: { name: "llamacpp", model: "qwen3.5:9b" },
      verifierConfig: { name: "anthropic", model: "claude-haiku-4-5-20251001" },
      env: { LLAMACPP_SERVE_CTX: "30146" },
    });
    assert.equal(r.enabled, true);
  });

  test("dedupes repeated local models — same model everywhere stays enabled", () => {
    const r = shouldEnableRoundtable({
      totalRamGB: 16,
      mainProvider: { name: "llamacpp", model: "qwen3.5:9b" },
      primaryConfig: { name: "llamacpp", model: "qwen3.5:9b" },
      verifierConfig: { name: "llamacpp", model: "qwen3.5:9b" },
      env: { LLAMACPP_SERVE_CTX: "30146" },
    });
    assert.equal(r.enabled, true);
  });

  test("skips the RAM check when llama-server runs on a remote host", () => {
    const r = shouldEnableRoundtable({
      totalRamGB: 8,
      mainProvider: { name: "llamacpp", model: "qwen3.5:9b" },
      primaryConfig: { name: "llamacpp", model: "phi4-mini:3.8b" },
      verifierConfig: { name: "llamacpp", model: "qwen3.5:4b" },
      env: { LLAMACPP_SERVE_CTX: "30146", LLAMACPP_BASE_URL: "http://192.168.1.100:8080" },
    });
    assert.equal(r.enabled, true);
  });

  test("modest two-model setups fit within the softened reserve", () => {
    // Two of the smallest curated models at a modest window: a remote main plus
    // two small local agents must still fit the softened 16 GB reserve.
    const r = shouldEnableRoundtable({
      totalRamGB: 16,
      mainProvider: { name: "anthropic", model: "claude-haiku-4-5-20251001" },
      primaryConfig: { name: "llamacpp", model: "gemma4:e4b-qat" },
      verifierConfig: { name: "llamacpp", model: "qwen3.5:9b" },
      env: { LLAMACPP_SERVE_CTX: "2048" },
    });
    assert.equal(r.enabled, true);
  });

  test("disables local roundtable when the estimated footprint exceeds budget", () => {
    const r = shouldEnableRoundtable({
      totalRamGB: 16,
      mainProvider: { name: "llamacpp", model: "qwen3.5:9b" },
      primaryConfig: { name: "llamacpp", model: "phi4-mini:3.8b" },
      verifierConfig: { name: "llamacpp", model: "qwen3.5:4b" },
      env: { LLAMACPP_SERVE_CTX: "30146" },
    });
    assert.equal(r.enabled, false);
    assert.match(r.reason, /exceeds budget/);
  });
});
