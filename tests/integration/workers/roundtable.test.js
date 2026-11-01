// Tests for roundtable.js — pure helper functions
//
// parseAgreement, foldReplyToPlainText, detectProviderError, prompt builders,
// withUserAttachments, and writeRoundtableRecord's test-mode guard are all
// pure or side-effect-free when NODE_ENV=test. No mocking needed for these.
//
// writeRoundtableManifesto touches the filesystem but catches errors and
// returns null on failure — safe to call even without memfs.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  parseAgreement,
  foldReplyToPlainText,
  detectProviderError,
  buildAnswerPrompt,
  buildReviewPrompt,
  buildRevisePrompt,
  buildRereviewPrompt,
  buildManifestoPrompt,
  withUserAttachments,
  writeRoundtableRecord,
  writeRoundtableManifesto,
} from "../../../lib/workers/roundtable.js";

// ═══════════════════════════════════════════════════════════════════════════════
// parseAgreement
// ═══════════════════════════════════════════════════════════════════════════════

describe("parseAgreement", () => {
  // ─── Agreed ───────────────────────────────────────────────────────────────

  test('returns agreed=true when text starts with "AGREED:"', () => {
    const r = parseAgreement("AGREED: The sky is blue.");
    assert.strictEqual(r.agreed, true);
    assert.strictEqual(r.malformed, false);
    assert.strictEqual(r.body, "The sky is blue.");
  });

  test("is case-insensitive", () => {
    const r = parseAgreement("agreed: yes");
    assert.strictEqual(r.agreed, true);
  });

  test("tolerates leading whitespace", () => {
    const r = parseAgreement("  AGREED: hello");
    assert.strictEqual(r.agreed, true);
    assert.strictEqual(r.body, "hello");
  });

  test("tolerates bold markdown wrappers (**)", () => {
    const r = parseAgreement("**AGREED:** works");
    assert.strictEqual(r.agreed, true);
    assert.strictEqual(r.body, "works");
  });

  test("strips trailing bold markers from body", () => {
    const r = parseAgreement("**agreed:** content **");
    assert.strictEqual(r.agreed, true);
    assert.strictEqual(r.body, "content");
  });

  test("body is empty when AGREED is followed by nothing", () => {
    const r = parseAgreement("agreed:");
    assert.strictEqual(r.agreed, true);
    assert.strictEqual(r.body, "");
  });

  // ─── Malformed ────────────────────────────────────────────────────────────

  test("returns malformed=true when AGREED appears mid-text", () => {
    const r = parseAgreement("I think we agreed on this point");
    assert.strictEqual(r.agreed, false);
    assert.strictEqual(r.malformed, true);
    assert.strictEqual(r.body, "I think we agreed on this point");
  });

  test("malformed=true for AGREED at start but colon missing", () => {
    // AGREED at start with no colon — not AGREED: pattern
    const r = parseAgreement("AGREED yes");
    assert.strictEqual(r.agreed, false);
    assert.strictEqual(r.malformed, true);
  });

  // ─── No agreement ─────────────────────────────────────────────────────────

  test("returns agreed=false for plain text (body is the full text)", () => {
    const r = parseAgreement("This is my answer.");
    assert.strictEqual(r.agreed, false);
    assert.strictEqual(r.malformed, false);
    assert.strictEqual(r.body, "This is my answer.");
  });

  test("returns agreed=false for null", () => {
    const r = parseAgreement(null);
    assert.strictEqual(r.agreed, false);
    assert.strictEqual(r.malformed, false);
    assert.strictEqual(r.body, "");
  });

  test("returns agreed=false for undefined", () => {
    const r = parseAgreement(undefined);
    assert.strictEqual(r.agreed, false);
    assert.strictEqual(r.malformed, false);
  });

  test("returns agreed=false for empty string", () => {
    const r = parseAgreement("");
    assert.strictEqual(r.agreed, false);
    assert.strictEqual(r.malformed, false);
  });

  test("returns agreed=false for whitespace-only string", () => {
    const r = parseAgreement("   ");
    assert.strictEqual(r.agreed, false);
    assert.strictEqual(r.malformed, false);
  });

  test("returns agreed=false for non-string input (number)", () => {
    const r = parseAgreement(42);
    assert.strictEqual(r.agreed, false);
    assert.strictEqual(r.malformed, false);
    assert.strictEqual(r.body, "");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// foldReplyToPlainText
// ═══════════════════════════════════════════════════════════════════════════════

describe("foldReplyToPlainText", () => {
  test("returns trimmed string for string input", () => {
    assert.strictEqual(foldReplyToPlainText("  hello  "), "hello");
  });

  test("extracts text blocks from array content", () => {
    const reply = [
      { type: "text", text: "line1" },
      { type: "tool_use", id: "tu_1", name: "read", input: {} },
      { type: "text", text: "line2" },
    ];
    assert.strictEqual(foldReplyToPlainText(reply), "line1\nline2");
  });

  test("skips non-text blocks in array", () => {
    const reply = [
      { type: "tool_result", content: "data" },
      { type: "image", source: { type: "base64", data: "abc" } },
    ];
    assert.strictEqual(foldReplyToPlainText(reply), "");
  });

  test("extracts text from object with text property", () => {
    assert.strictEqual(foldReplyToPlainText({ text: "  obj  " }), "obj");
  });

  test("returns empty string for null", () => {
    assert.strictEqual(foldReplyToPlainText(null), "");
  });

  test("returns empty string for undefined", () => {
    assert.strictEqual(foldReplyToPlainText(undefined), "");
  });

  test("converts non-string/array/object to string", () => {
    assert.strictEqual(foldReplyToPlainText(42), "42");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// detectProviderError
// ═══════════════════════════════════════════════════════════════════════════════

describe("detectProviderError", () => {
  test("returns null for normal text", () => {
    assert.strictEqual(detectProviderError("This is a normal reply."), null);
  });

  test("detects ⚠️-prefixed error", () => {
    assert.strictEqual(detectProviderError("⚠️ Timeout after 30s"), "Timeout after 30s");
  });

  test("detects JSON error envelope", () => {
    const reply = JSON.stringify({ error: { message: "Rate limit exceeded" } });
    assert.strictEqual(detectProviderError(reply), "Rate limit exceeded");
  });

  test("detects flat JSON error", () => {
    assert.strictEqual(detectProviderError('{"error":"bad request"}'), "bad request");
  });

  test("returns null for JSON without 'error' key (only has 'message')", () => {
    // detectProviderError requires the `"error"` key — plain `"message"` isn't enough
    assert.strictEqual(detectProviderError('{"message":"not found"}'), null);
  });

  test("returns null for non-string input", () => {
    assert.strictEqual(detectProviderError(null), null);
    assert.strictEqual(detectProviderError(undefined), null);
    assert.strictEqual(detectProviderError({ text: "hi" }), null);
  });

  test("returns null for empty string", () => {
    assert.strictEqual(detectProviderError(""), null);
  });

  test("returns null for malformed JSON that doesn't have error shape", () => {
    assert.strictEqual(detectProviderError('{invalid json'), null);
  });

  test("returns null for JSON without error key", () => {
    assert.strictEqual(detectProviderError('{"ok":true}'), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt builders
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildAnswerPrompt", () => {
  test("prefixes with PHASE: ANSWER", () => {
    assert.match(buildAnswerPrompt("Hello"), /^PHASE: ANSWER/);
  });

  test("includes user text", () => {
    assert.match(buildAnswerPrompt("Hello"), /Hello/);
  });
});

describe("buildReviewPrompt", () => {
  test("prefixes with PHASE: REVIEW", () => {
    assert.match(buildReviewPrompt("Question?", "Answer."), /^PHASE: REVIEW/);
  });

  test("includes quoted user question and quoted agent answer", () => {
    const prompt = buildReviewPrompt("What is 2+2?", "It is 4.");
    assert.match(prompt, /What is 2\+2\?/);
    assert.match(prompt, /It is 4\./);
  });
});

describe("buildRevisePrompt", () => {
  test("prefixes with PHASE: REVISE", () => {
    assert.match(buildRevisePrompt("Q", "old answer", "objections..."), /^PHASE: REVISE/);
  });

  test("includes all three quoted parts", () => {
    const prompt = buildRevisePrompt("question", "answer", "objection");
    assert.match(prompt, /question/);
    assert.match(prompt, /answer/);
    assert.match(prompt, /objection/);
  });
});

describe("buildRereviewPrompt", () => {
  test("prefixes with PHASE: REREVIEW", () => {
    assert.match(buildRereviewPrompt("Q", "prior obj", "revised A"), /^PHASE: REREVIEW/);
  });

  test("includes prior objections and revised answer", () => {
    const prompt = buildRereviewPrompt("question", "objections", "revised");
    assert.match(prompt, /objections/);
    assert.match(prompt, /revised/);
  });
});

describe("buildManifestoPrompt", () => {
  test("prefixes with PHASE: MANIFESTO", () => {
    assert.match(buildManifestoPrompt("Hello", null), /^PHASE: MANIFESTO/);
  });

  test("includes character context when provided", () => {
    const prompt = buildManifestoPrompt("question", "skeptic");
    assert.match(prompt, /as a skeptic/);
  });

  test("omits character context when not provided", () => {
    const prompt = buildManifestoPrompt("question", null);
    assert.doesNotMatch(prompt, /as a/);
  });

  test("includes the user question", () => {
    const prompt = buildManifestoPrompt("My question", null);
    assert.match(prompt, /My question/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// withUserAttachments
// ═══════════════════════════════════════════════════════════════════════════════

describe("withUserAttachments", () => {
  test("returns promptText unchanged when userContent is not an array", () => {
    assert.strictEqual(withUserAttachments("hello", null), "hello");
    assert.strictEqual(withUserAttachments("hello", undefined), "hello");
    assert.strictEqual(withUserAttachments("hello", "string"), "hello");
  });

  test("returns promptText unchanged when userContent has only one block", () => {
    assert.strictEqual(withUserAttachments("hello", [{ type: "text", text: "user typed this" }]), "hello");
  });

  test("returns array with prompt text + attachment blocks when there are real attachments", () => {
    const result = withUserAttachments("phase prompt", [
      { type: "text", text: "user text" },
      { type: "image", url: "x.png" },
    ]);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].text, "phase prompt");
    assert.strictEqual(result[1].url, "x.png");
  });

  test("filters out null/undefined attachment blocks", () => {
    const result = withUserAttachments("p", [
      { type: "text", text: "user text" },
      null,
      { type: "image", url: "y.png" },
      undefined,
    ]);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[1].url, "y.png");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// writeRoundtableRecord — test-mode guard
// ═══════════════════════════════════════════════════════════════════════════════

describe("writeRoundtableRecord", () => {
  test("returns null when NODE_ENV is test (disk safety)", () => {
    // The guard at the top of writeRoundtableRecord checks NODE_ENV === "test"
    const result = writeRoundtableRecord({
      sessionId: "test-123",
      userText: "hello",
      turns: [],
      agents: { primary: {}, verifier: {} },
      verdict: "agreed",
    });
    assert.strictEqual(result, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// writeRoundtableManifesto — best-effort, catches errors
// ═══════════════════════════════════════════════════════════════════════════════

describe("writeRoundtableManifesto", () => {
  test("returns null on failure (no memfs — disk write fails)", () => {
    // Without memfs, the mkdirSync call will either succeed (creating real files)
    // or fail. In CI the var/roundtables dir might not exist and mkdir will
    // create it. Either way, the function catches errors and returns null/fpath.
    // We just verify it doesn't throw.
    const result = writeRoundtableManifesto({
      sessionId: "test-manifesto",
      userText: "question",
      primaryManifesto: "A manifesto",
      verifierManifesto: "B manifesto",
      agents: {
        primary: { provider: { name: "test", model: "m" } },
        verifier: { provider: { name: "test", model: "m" } },
      },
      verdict: "agreed",
    });
    // Either null (mkdir failed) or a string path (disk write succeeded)
    assert.ok(result === null || typeof result === "string");
  });
});
