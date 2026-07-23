// tests/unit/memory/compact.test.js — WS1 group G1 (memory-compaction EPIC #286)
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  maskProtectedSpans,
  unmaskProtectedSpans,
  compactDeterministic,
  compactWithLLM,
} from "../../../lib/memory/compact.js";
import {
  TIER_1_FILLER,
  TIER_2_CONTEXT,
  TIER_3_STRUCTURAL,
} from "../../../lib/memory/compaction-rules/en.js";
import examFixture from "../../../.github/capability-exam/exam.memories.json" with { type: "json" };

describe("maskProtectedSpans / unmaskProtectedSpans", () => {
  test("round-trips every protected-span category byte-exact with no rules applied", () => {
    const samples = [
      "See the ```const x = 1;\nconsole.log(x);``` snippet Maya wrote for Nimbus.",
      "Run `npm test` before you tell Beacon it's fixed, Priya.",
      "Docs are at https://vendor.example.com/inv for the Acme contract.",
      'Maya said "the queue backed up again" right before lunch.',
      "The fix lives in pricing/ruleloader.go and Sana reviewed it.",
      "Shipped on 2026-07-23 with a 3.14% error-rate drop, per Devon.",
      "",
      "no protected spans at all, just Kai talking about the roadmap",
      "https://vendor.example.com/inv",
      "path pricing/ruleloader.go:2026-07-23 has a colon between two spans",
    ];
    for (const text of samples) {
      const { masked, spans } = maskProtectedSpans(text);
      const roundTripped = unmaskProtectedSpans(masked, spans);
      assert.equal(roundTripped, text, `round-trip mismatch for: ${JSON.stringify(text)}`);
    }
  });

  test("zero-span string is a no-op", () => {
    const text = "Kai and Priya reviewed the roadmap together yesterday.";
    const { masked, spans } = maskProtectedSpans(text);
    assert.equal(masked, text);
    assert.deepEqual(spans, []);
  });

  test("adjacent spans separated only by punctuation stay distinct, no merge", () => {
    const text = "pricing/ruleloader.go:2026-07-23 broke";
    const { masked, spans } = maskProtectedSpans(text);
    assert.equal(spans.length, 2);
    assert.equal(spans[0], "pricing/ruleloader.go");
    assert.equal(spans[1], "2026-07-23");
    assert.equal(unmaskProtectedSpans(masked, spans), text);
  });

  test("a string that is entirely one protected span round-trips", () => {
    const text = "https://vendor.example.com/inv";
    const { masked, spans } = maskProtectedSpans(text);
    assert.equal(spans.length, 1);
    assert.equal(unmaskProtectedSpans(masked, spans), text);
  });
});

describe("compactDeterministic — rule tiers", () => {
  const combined =
    "In order to ship this, note the fix. Please note that Devon reviewed it. " +
    "Very quickly, Priya really liked it, and rather than delay, Kai basically shipped it. " +
    "Additionally, Sana signed off. To summarize, Maya is happy with Nimbus.";

  test("maxTier: 1 rewrites only tier-1 filler phrases, tier-2/3 phrases survive verbatim", () => {
    const { text } = compactDeterministic(combined, "english", { maxTier: 1 });
    assert.ok(!/\bin order to\b/i.test(text), "tier-1 phrase should be rewritten");
    assert.ok(!/\bplease note that\b/i.test(text), "tier-1 phrase should be removed");
    assert.ok(/\bVery quickly\b/.test(text), "tier-2 phrase must survive at maxTier:1");
    assert.ok(/\brather than delay\b/.test(text), "tier-2 'rather than' must never be stripped (guarded)");
    assert.ok(/\bAdditionally,/.test(text), "tier-2 transition must survive at maxTier:1");
    assert.ok(/\bTo summarize,/.test(text), "tier-3 phrase must survive at maxTier:1");
  });

  test("maxTier: 2 also rewrites tier-2 hedges/transitions but not tier-3", () => {
    const { text } = compactDeterministic(combined, "english", { maxTier: 2 });
    assert.ok(!/\bVery quickly\b/.test(text));
    assert.ok(!/\breally\s+liked\b/i.test(text));
    assert.ok(/\brather than delay\b/.test(text), "'rather than' guard still applies at tier 2");
    assert.ok(!/\bAdditionally,/.test(text));
    assert.ok(/\bTo summarize,/.test(text), "tier-3 phrase must survive at maxTier:2");
  });

  test("maxTier: 3 (default) rewrites all three tiers", () => {
    const { text } = compactDeterministic(combined, "english", { maxTier: 3 });
    assert.ok(!/\bin order to\b/i.test(text));
    assert.ok(!/\bVery quickly\b/.test(text));
    assert.ok(!/\bTo summarize,\b/.test(text));
  });

  test("proper nouns adjacent to every matched phrase survive byte-exact at every tier", () => {
    const names = ["Devon", "Priya", "Kai", "Sana", "Maya", "Nimbus"];
    for (const maxTier of [1, 2, 3]) {
      const { text } = compactDeterministic(combined, "english", { maxTier });
      for (const name of names) {
        assert.ok(text.includes(name), `${name} lost at maxTier:${maxTier}`);
      }
    }
  });

  test("a phrase substring inside a longer proper noun is not falsely matched (word boundaries)", () => {
    const text = "Actuallytics is the name of Devon's new internal dashboard tool.";
    const { text: out } = compactDeterministic(text, "english", { maxTier: 3 });
    assert.equal(out, text, "word-boundary rules must not touch 'Actuallytics'");
  });

  test("every tier-1 rule fires as documented", () => {
    const fixture =
      "In order to launch, due to the fact that load is high, at this point in time we scaled up. " +
      "For the purpose of clarity: in the event that traffic spikes, in spite of the fact that costs " +
      "rise, a large number of replicas will start. Please note that this is automatic. " +
      "It is important to note that alerts fire either way. Keep in mind that on-call gets paged. " +
      "It should be noted that Devon owns the runbook.";
    const { text } = compactDeterministic(fixture, "english", { maxTier: 1 });
    for (const phrase of [
      "in order to", "due to the fact that", "at this point in time", "for the purpose of",
      "in the event that", "in spite of the fact that", "a large number of", "please note that",
      "it is important to note that", "keep in mind that", "it should be noted that",
    ]) {
      assert.ok(!new RegExp(`\\b${phrase}\\b`, "i").test(text), `"${phrase}" should have been rewritten`);
    }
    assert.ok(text.includes("Devon"));
  });

  test("rule tier arrays are non-empty and exported", () => {
    assert.ok(TIER_1_FILLER.length > 0);
    assert.ok(TIER_2_CONTEXT.length > 0);
    assert.ok(TIER_3_STRUCTURAL.length > 0);
  });
});

describe("compactDeterministic — fail-open language gate + inflation guard", () => {
  const content = "In order to ship this, please note that Devon reviewed it carefully.";

  for (const lang of ["german", "french", "simple", undefined, null, "klingon"]) {
    test(`lang=${JSON.stringify(lang)} is fail-open — untouched, reason 'no-rule-pack'`, () => {
      const result = compactDeterministic(content, lang);
      assert.equal(result.text, content);
      assert.equal(result.applied, false);
      assert.equal(result.reason, "no-rule-pack");
    });
  }

  test("english content that doesn't shrink returns the original verbatim, reason 'no-reduction'", () => {
    // No tier-1/2/3 phrases at all, and masking protects the only "content" —
    // nothing for any rule to touch, so the pipeline is a guaranteed no-op.
    const noOp = "Kai and Priya own the Beacon service together.";
    const result = compactDeterministic(noOp, "english");
    assert.equal(result.text, noOp);
    assert.equal(result.applied, false);
    assert.equal(result.reason, "no-reduction");
  });
});

describe("compactDeterministic — idempotency", () => {
  test("compacting the compacted output is a no-op fixed point, across the real exam corpus", () => {
    const contents = examFixture.memories.map(m => m.content);
    const extra =
      "In order to ship this, note the fix. Please note that Devon reviewed it. " +
      "Very quickly, Priya really liked it, and rather than delay, Kai basically shipped it. " +
      "Additionally, Sana signed off. To summarize, Maya is happy with Nimbus.";
    for (const original of [...contents, extra]) {
      const once = compactDeterministic(original, "english");
      const twice = compactDeterministic(once.text, "english");
      assert.equal(twice.text, once.text, `not idempotent for: ${JSON.stringify(original).slice(0, 80)}`);
      assert.equal(twice.applied, false, "second pass must never apply further rewriting");
    }
  });

  test("an already-minimal input (no rule matches) is trivially idempotent (control case)", () => {
    const text = "Kai owns Beacon.";
    const once = compactDeterministic(text, "english");
    const twice = compactDeterministic(once.text, "english");
    assert.equal(once.text, text);
    assert.equal(twice.text, text);
  });
});

describe("compactWithLLM — interface never throws, correct fallback", () => {
  // Includes a real protected span (the date) so placeholder-validation stubs
  // below have something meaningful to preserve/drop/duplicate.
  const content = "In order to ship this on 2026-07-23, please note that Devon reviewed it carefully.";

  // Stubs receive the full instructional prompt (buildLLMPrompt's output), not
  // just the masked text — mirrors what a real llmComplete call gets. Extract
  // the masked chunk the same way a real model would just respond to it.
  function maskedChunkFromPrompt(promptText) {
    return promptText.slice(promptText.lastIndexOf("\n\n") + 2);
  }

  // Placeholder tokens are PUA-wrapped digits (see compact.js); match via
  // explicit escape sequences here so this file stays free of invisible
  // raw Unicode codepoints that are indistinguishable from empty in a terminal.
  const PLACEHOLDER_TOKEN_RE = /\uE000\d+\uE001/g;

  test("accepting stub: placeholder-intact, smaller result resolves reason 'llm-ok'", async () => {
    const llmComplete = async messages => {
      const masked = maskedChunkFromPrompt(messages[0].content);
      return masked.replace(/please note that /gi, "").replace(/In order to/i, "To");
    };
    const result = await compactWithLLM(content, "english", { llmComplete });
    assert.equal(result.applied, true);
    assert.equal(result.reason, "llm-ok");
    assert.ok(result.text.includes("Devon"));
    assert.ok(result.text.includes("2026-07-23"), "protected date span must survive in the accepted result");
  });

  test("reordered-placeholder stub (each present once, but swapped) falls back to deterministic", async () => {
    // Two protected spans this time (a date and a number), so a swap is
    // actually observable rather than a no-op.
    const twoSpans = "In order to ship this on 2026-07-23 for 42.00, please note that Devon reviewed it.";
    // Match placeholder tokens generically via the actual masking/unmasking
    // module output shape rather than assuming specific code points here.
    const llmComplete = async messages => {
      const masked = maskedChunkFromPrompt(messages[0].content);
      const tokens = [...masked.matchAll(PLACEHOLDER_TOKEN_RE)].map(m => m[0]);
      if (tokens.length !== 2) throw new Error("test fixture expects exactly 2 protected spans");
      // Swap the two placeholder tokens' positions — count-only validation
      // would accept this (each still appears exactly once); order-aware
      // validation must reject it since it changes which value lands where.
      const [first, second] = tokens;
      const swapped = masked.replace(first, "\u0000SWAP\u0000").replace(second, first).replace("\u0000SWAP\u0000", second);
      return swapped.replace(/please note that /gi, "");
    };
    const det = compactDeterministic(twoSpans, "english");
    const result = await compactWithLLM(twoSpans, "english", { llmComplete });
    assert.equal(result.text, det.text, "a placeholder swap must be rejected, falling back to the deterministic result");
    assert.equal(result.reason, det.reason);
  });


  test("dropped-placeholder stub falls back to the deterministic result", async () => {
    const llmComplete = async () => "a rewrite that drops every placeholder token entirely";
    const det = compactDeterministic(content, "english");
    const result = await compactWithLLM(content, "english", { llmComplete });
    assert.equal(result.text, det.text);
    assert.equal(result.reason, det.reason);
  });

  test("throwing stub falls back to the deterministic result, never rejects", async () => {
    const llmComplete = async () => { throw new Error("boom"); };
    const det = compactDeterministic(content, "english");
    await assert.doesNotReject(async () => {
      const result = await compactWithLLM(content, "english", { llmComplete });
      assert.equal(result.text, det.text);
      assert.equal(result.reason, det.reason);
    });
  });

  test("inflating stub (placeholder-intact but larger than original) falls back to deterministic", async () => {
    const llmComplete = async messages => {
      const masked = maskedChunkFromPrompt(messages[0].content);
      return masked + " with a great deal of entirely unnecessary additional padding text appended";
    };
    const det = compactDeterministic(content, "english");
    const result = await compactWithLLM(content, "english", { llmComplete });
    assert.equal(result.text, det.text);
    assert.equal(result.reason, det.reason);
  });

  test("non-english lang is not gated at the LLM step — a valid stub still succeeds via 'llm-ok'", async () => {
    const llmComplete = async messages => {
      const masked = maskedChunkFromPrompt(messages[0].content);
      return masked.replace(/please note that /gi, "");
    };
    const result = await compactWithLLM(content, "german", { llmComplete });
    assert.equal(result.applied, true);
    assert.equal(result.reason, "llm-ok");
  });

  test("non-english lang whose LLM stub fails falls back to the fail-open deterministic result", async () => {
    const llmComplete = async () => { throw new Error("boom"); };
    const det = compactDeterministic(content, "german");
    const result = await compactWithLLM(content, "german", { llmComplete });
    assert.equal(result.text, content);
    assert.equal(result.text, det.text);
    assert.equal(result.reason, "no-rule-pack");
  });
});
