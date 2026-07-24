// tests/unit/memory/tokenCount.test.js — WS0 group G0-1 (memory-compaction EPIC #286)
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "gpt-tokenizer";
import { countTokens } from "../../../lib/memory/tokenCount.js";

describe("countTokens", () => {
  test("matches gpt-tokenizer's encode() length exactly", () => {
    const samples = [
      "",
      "hello",
      "Nimbus is the team's real-time pricing service. It computes quote prices on demand " +
        "for the storefront, must answer under 50ms p99, and is the highest-traffic service " +
        "the platform team owns.",
      "Прочетох архитектурния документ за Nimbus снощи.", // Cyrillic (BG corpus concern, #245)
      "The batched loader lives in pricing/ruleloader.go — see https://vendor.example.com/inv",
    ];
    for (const text of samples) {
      assert.equal(countTokens(text), encode(text).length, `mismatch for: ${JSON.stringify(text)}`);
    }
  });

  test("does not throw on null/undefined and counts as empty", () => {
    assert.equal(countTokens(undefined), encode("").length);
    assert.equal(countTokens(null), encode("").length);
  });
});
