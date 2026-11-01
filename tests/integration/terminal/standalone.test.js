// Tests for standalone.js — buildHistoryText, normalizeMessages, SUMMARIZE_INTENT_RE
//
// These pure helper functions were extracted from the runStandalone closure so
// they can be tested in isolation. No filesystem access, no session data,
// no agent — just messages in, text out.
//
// The module-level `require(resolve(ROOT, "package.json"))` reads the project's
// own package.json at import time; this is unavoidable without deeper
// refactoring and is a constant project metadata read, not test-data IO.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildHistoryText,
  normalizeMessages,
} from "../../../lib/terminal/standalone.js";

// The SUMMARIZE_INTENT_RE is a module-level const, not exported. We replicate
// its pattern here for regex-matching tests.
const SUMMARIZE_RE = /\b(summarize|summarise|summarization|summary|recap)\b.*\b(our|this|the)?\s*(conversation|chat|discussion|session|history|we('ve| have) (discussed|talked|covered))\b|\bsummarize\s+(it|this|everything|all)\b|\b(tl;?dr|tldr)\b/i;

// ═══════════════════════════════════════════════════════════════════════════════
// buildHistoryText
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildHistoryText", () => {
  test("filters out tool role messages", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "tool", content: "some result" },
      { role: "assistant", content: "hi there" },
    ];
    const result = buildHistoryText(msgs);
    assert.strictEqual(result, "User: hello\n\nAssistant: hi there");
  });

  test("filters out messages with tool_result content type", () => {
    const msgs = [
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "tool_result", text: "42" }] },
      { role: "assistant", content: "the answer is 42" },
    ];
    const result = buildHistoryText(msgs);
    // The tool_result message should be filtered; the plain-text assistant
    // message should appear.
    assert.strictEqual(result, "User: question\n\nAssistant: the answer is 42");
  });

  test("maps user role to 'User:' prefix", () => {
    const msgs = [{ role: "user", content: "hi" }];
    assert.match(buildHistoryText(msgs), /^User: hi$/);
  });

  test("maps assistant role to 'Assistant:' prefix", () => {
    const msgs = [{ role: "assistant", content: "hello" }];
    assert.match(buildHistoryText(msgs), /^Assistant: hello$/);
  });

  test("handles array content with text blocks", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "part a" }, { type: "text", text: "part b" }] }];
    const result = buildHistoryText(msgs);
    assert.match(result, /part a/);
    assert.match(result, /part b/);
  });

  test("skips non-text blocks in array content", () => {
    const msgs = [{ role: "user", content: [{ type: "image", url: "x.png" }, { type: "text", text: "only text" }] }];
    const result = buildHistoryText(msgs);
    assert.strictEqual(result, "User: only text");
  });

  test("handles plain string content", () => {
    const msgs = [{ role: "user", content: "plain string" }];
    assert.strictEqual(buildHistoryText(msgs), "User: plain string");
  });

  test("returns empty string for empty message array", () => {
    assert.strictEqual(buildHistoryText([]), "");
  });

  test("returns empty string when all messages filtered out", () => {
    const msgs = [
      { role: "tool", content: "data" },
    ];
    assert.strictEqual(buildHistoryText(msgs), "");
  });

  test("skips messages with empty/null content", () => {
    const msgs = [
      { role: "user", content: "" },
      { role: "user", content: null },
      { role: "user", content: "valid" },
    ];
    assert.strictEqual(buildHistoryText(msgs), "User: valid");
  });

  test("joins consecutive messages with double newline", () => {
    const msgs = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ];
    assert.strictEqual(buildHistoryText(msgs), "User: q1\n\nAssistant: a1\n\nUser: q2");
  });

  test("preserves multi-word content", () => {
    const msgs = [{ role: "user", content: "   lots   of   spaces   " }];
    // The function trims the text
    assert.strictEqual(buildHistoryText(msgs), "User: lots   of   spaces");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizeMessages
// ═══════════════════════════════════════════════════════════════════════════════

describe("normalizeMessages", () => {
  test("replaces array content with plain text string", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello world" }] },
    ];
    normalizeMessages(msgs);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].content, "hello world");
  });

  test("removes messages whose array content produces empty text", () => {
    const msgs = [
      { role: "user", content: "keep me" },
      { role: "user", content: [{ type: "image", url: "x.png" }] },
    ];
    normalizeMessages(msgs);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].content, "keep me");
  });

  test("preserves messages with plain string content (no change)", () => {
    const msgs = [
      { role: "user", content: "plain" },
      { role: "assistant", content: "response" },
    ];
    const original = msgs.map(m => ({ ...m }));
    normalizeMessages(msgs);
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].content, "plain");
    assert.strictEqual(msgs[1].content, "response");
  });

  test("joins multiple text blocks with newline", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] },
    ];
    normalizeMessages(msgs);
    assert.strictEqual(msgs[0].content, "line1\nline2");
  });

  test("handles mixed array and string content", () => {
    const msgs = [
      { role: "user", content: "string" },
      { role: "user", content: [{ type: "text", text: "array" }, { type: "image", url: "i.png" }] },
      { role: "user", content: [{ type: "image", url: "j.png" }] },
    ];
    normalizeMessages(msgs);
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].content, "string");
    assert.strictEqual(msgs[1].content, "array");
  });

  test("does nothing for empty array", () => {
    const msgs = [];
    normalizeMessages(msgs);
    assert.deepStrictEqual(msgs, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARIZE_INTENT_RE
// ═══════════════════════════════════════════════════════════════════════════════

describe("SUMMARIZE_INTENT_RE", () => {
  // ─── Should match ──────────────────────────────────────────────────────────

  test("matches 'summarize this conversation'", () => {
    assert.ok(SUMMARIZE_RE.test("summarize this conversation"));
  });

  test("matches 'summarize our chat'", () => {
    assert.ok(SUMMARIZE_RE.test("summarize our chat"));
  });

  test("matches 'summarize what we have discussed'", () => {
    assert.ok(SUMMARIZE_RE.test("summarize what we have discussed"));
  });

  test("matches 'summarize what we've talked about'", () => {
    assert.ok(SUMMARIZE_RE.test("summarize what we've talked about"));
  });

  test("matches 'summarize everything'", () => {
    assert.ok(SUMMARIZE_RE.test("summarize everything"));
  });

  test("matches 'summarize all'", () => {
    assert.ok(SUMMARIZE_RE.test("summarize all"));
  });

  test("matches 'tl;dr'", () => {
    assert.ok(SUMMARIZE_RE.test("tl;dr"));
  });

  test("matches 'tldr'", () => {
    assert.ok(SUMMARIZE_RE.test("tldr"));
  });

  test("matches 'TL;DR' (case insensitive)", () => {
    assert.ok(SUMMARIZE_RE.test("TL;DR"));
  });

  test("matches 'give me a summary of this session'", () => {
    assert.ok(SUMMARIZE_RE.test("give me a summary of this session"));
  });

  test("matches 'can you summarise our discussion' (British spelling)", () => {
    assert.ok(SUMMARIZE_RE.test("can you summarise our discussion"));
  });

  test("matches 'recap what we have covered'", () => {
    assert.ok(SUMMARIZE_RE.test("recap what we have covered"));
  });

  test("matches 'summarization of the conversation'", () => {
    assert.ok(SUMMARIZE_RE.test("summarization of the conversation"));
  });

  test("matches 'summarize' in the middle of a sentence", () => {
    assert.ok(SUMMARIZE_RE.test("please summarize everything we've talked about"));
  });

  // ─── Should NOT match ──────────────────────────────────────────────────────

  test("does not match plain text without summarize keywords", () => {
    assert.strictEqual(SUMMARIZE_RE.test("hello how are you"), false);
  });

  test("does not match document summary reference", () => {
    assert.strictEqual(SUMMARIZE_RE.test("the summary of the document is..."), false);
  });

  test("does not match 'summary' alone without conversation context", () => {
    assert.strictEqual(SUMMARIZE_RE.test("summary"), false);
  });

  test("does not match 'recap' alone", () => {
    assert.strictEqual(SUMMARIZE_RE.test("recap"), false);
  });
});
