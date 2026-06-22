// tests/lib/agent/toolActivity.test.js
//
// Tests for summarizeArgs and summarizeResult — pure functions that produce
// short, safe summaries of tool calls for the UI activity cards.

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";

// ─── Dynamic import ───────────────────────────────────────────────────────

let ta;

before(async () => {
  ta = await import("../../../lib/agent/toolActivity.js");
});

// =============================================================================
// summarizeArgs
// =============================================================================
describe("summarizeArgs()", () => {
  test("returns empty string for null args", () => {
    assert.equal(ta.summarizeArgs("tool", null), "");
  });

  test("returns empty string for non-object args", () => {
    assert.equal(ta.summarizeArgs("tool", "string"), "");
    assert.equal(ta.summarizeArgs("tool", 42), "");
  });

  test("returns empty string for empty object", () => {
    assert.equal(ta.summarizeArgs("tool", {}), "");
  });

  // ── URL ──────────────────────────────────────────────────────────────────

  test("returns truncated URL", () => {
    const result = ta.summarizeArgs("fetch", { url: "https://example.com/long/path/to/resource" });
    assert.ok(result.length <= 82); // truncMid with n=80
    assert.ok(result.includes("example.com"), "should include domain");
  });

  test("returns middle-ellipsis for very long URLs", () => {
    const longUrl = "https://very-long-domain-name.example.com/this/is/a/very/long/path/that/should/definitely/be/truncated/now";
    const result = ta.summarizeArgs("fetch", { url: longUrl });
    assert.ok(result.includes("…"), "should have middle ellipsis");
    assert.ok(result.length <= 82); // truncMid with n=80
  });

  // ── Command (shell) ────────────────────────────────────────────────────────

  test("returns the shell command nearly in full", () => {
    const cmd = 'npm test 2>&1 | grep -A 15 "init creates a store with a pool" | head -20';
    const result = ta.summarizeArgs("run_shell", { command: cmd });
    assert.equal(result, cmd); // under the 160 cap → shown verbatim
  });

  test("truncates a very long command to 160 chars", () => {
    const result = ta.summarizeArgs("run_shell", { command: "x".repeat(300) });
    assert.ok(result.length <= 160); // trunc with n=160 → 159 + …
    assert.ok(result.endsWith("…"));
  });

  test("prefers command over a generic path field", () => {
    const result = ta.summarizeArgs("run_shell", { command: "ls -la", path: "/tmp/x" });
    assert.equal(result, "ls -la");
  });

  test("prefers URL over query when both present", () => {
    const result = ta.summarizeArgs("fetch", { url: "https://example.com", query: "test" });
    assert.ok(result.includes("example.com"), "URL wins over query");
  });

  // ── Query ────────────────────────────────────────────────────────────────

  test("returns quoted query string", () => {
    const result = ta.summarizeArgs("search", { query: "how to write tests" });
    assert.equal(result, '"how to write tests"');
  });

  test("returns quoted q (alias) string", () => {
    const result = ta.summarizeArgs("search", { q: "hello world" });
    assert.equal(result, '"hello world"');
  });

  test("truncates long query to 60 chars", () => {
    const result = ta.summarizeArgs("search", { query: "a".repeat(100) });
    assert.ok(result.length <= 63); // " + 60 + " = 62 + …
  });

  test("ignores empty query string", () => {
    const result = ta.summarizeArgs("search", { url: "https://example.com" });
    assert.ok(result.includes("example.com"), "falls through to URL");
  });

  // ── Path ─────────────────────────────────────────────────────────────────

  test("returns truncated path from 'path' key", () => {
    const result = ta.summarizeArgs("read", { path: "src/lib/helpers/utils.js" });
    assert.equal(result, "src/lib/helpers/utils.js");
  });

  test("returns truncated path from 'file' key", () => {
    const result = ta.summarizeArgs("write", { file: "/tmp/test.txt" });
    assert.equal(result, "/tmp/test.txt");
  });

  test("returns truncated path from 'title' key", () => {
    const result = ta.summarizeArgs("wiki", { title: "Hello World" });
    assert.equal(result, "Hello World");
  });

  test("truncates path longer than 120 chars", () => {
    const longPath = "a".repeat(150);
    const result = ta.summarizeArgs("read", { path: longPath });
    assert.ok(result.includes("…"), "should have middle ellipsis");
    assert.ok(result.length <= 122); // truncMid with n=120
  });

  test("th checks URL before path", () => {
    const result = ta.summarizeArgs("tool", { url: "https://api.example.com/data", path: "local/file.txt" });
    assert.ok(result.includes("api.example.com"), "URL wins over path");
  });

  // ── Limit ────────────────────────────────────────────────────────────────

  test("returns limit when numeric", () => {
    const result = ta.summarizeArgs("list", { limit: 10 });
    assert.equal(result, "limit: 10");
  });

  test("returns limit: 0", () => {
    const result = ta.summarizeArgs("list", { limit: 0 });
    assert.equal(result, "limit: 0");
  });

  // ── First string value ───────────────────────────────────────────────────

  test("returns first string value as fallback", () => {
    const result = ta.summarizeArgs("tool", { slug: "my-article", mode: "auto" });
    assert.equal(result, "my-article");
  });

  test("truncates first string fallback to 160 chars", () => {
    const result = ta.summarizeArgs("tool", { slug: "x".repeat(200) });
    assert.ok(result.length <= 161); // 160 + …
  });

  test("ignores empty strings in first string fallback", () => {
    const result = ta.summarizeArgs("tool", { a: "", b: "valid", c: "" });
    assert.equal(result, "valid");
  });

  test("prefers non-empty string over empty", () => {
    const result = ta.summarizeArgs("tool", { empty: "", slug: "found" });
    assert.equal(result, "found");
  });
});

// =============================================================================
// summarizeResult — array
// =============================================================================
describe("summarizeResult() — array input", () => {
  test("returns image summary for arrays", () => {
    const result = ta.summarizeResult("tool", [{ data: "base64" }]);
    assert.deepEqual(result, { ok: true, summary: "image" });
  });

  test("returns image summary for empty array", () => {
    const result = ta.summarizeResult("tool", []);
    assert.deepEqual(result, { ok: true, summary: "image" });
  });
});

// =============================================================================
// summarizeResult — error prefix
// =============================================================================
describe("summarizeResult() — error prefix", () => {
  test("returns ok:false for ❌ prefixed text", () => {
    const result = ta.summarizeResult("tool", "❌ Something went wrong");
    assert.equal(result.ok, false);
    assert.equal(result.summary, "Something went wrong");
  });

  test("strips leading whitespace after ❌", () => {
    const result = ta.summarizeResult("tool", "❌   file not found");
    assert.equal(result.summary, "file not found");
  });

  test("truncates long error message to 80 chars", () => {
    const longMsg = "❌ " + "x".repeat(100);
    const result = ta.summarizeResult("tool", longMsg);
    assert.ok(result.summary.length <= 81);
  });

  test("uses first line of multi-line error", () => {
    const result = ta.summarizeResult("tool", "❌ First error line\nSecond line\nThird line");
    assert.equal(result.summary, "First error line");
  });
});

// =============================================================================
// summarizeResult — recall
// =============================================================================
describe("summarizeResult() — recall", () => {
  test("returns no memories when text indicates none", () => {
    const result = ta.summarizeResult("recall", "No memories found.");
    assert.deepEqual(result, { ok: true, summary: "no memories" });
  });

  test("counts memories by '---' separators", () => {
    const text = "Memory 1\n---\nMemory 2\n---\nMemory 3";
    const result = ta.summarizeResult("recall", text);
    assert.deepEqual(result, { ok: true, summary: "3 memories" });
  });

  test("counts 2 memories from two --- separated blocks", () => {
    const text = "Memory 1\n---\nMemory 2";
    const result = ta.summarizeResult("recall", text);
    assert.deepEqual(result, { ok: true, summary: "2 memories" });
  });

  test("returns 1 memory for single block without separator", () => {
    const result = ta.summarizeResult("recall", "Just one memory here");
    assert.deepEqual(result, { ok: true, summary: "1 memory" });
  });
});

// =============================================================================
// summarizeResult — fetch_url
// =============================================================================
describe("summarizeResult() — fetch_url", () => {
  test("returns byte size for fetch_url result", () => {
    const text = "x".repeat(5000);
    const result = ta.summarizeResult("fetch_url", text);
    assert.equal(result.ok, true);
    assert.equal(result.summary, "4.9 KB");
  });

  test("reports bytes for small response", () => {
    const text = "hello";
    const result = ta.summarizeResult("fetch_url", text);
    assert.equal(result.summary, "5 B");
  });

  test("reports MB for large response", () => {
    const text = "x".repeat(2_000_000);
    const result = ta.summarizeResult("fetch_url", text);
    assert.ok(result.summary.includes("MB"));
  });
});

// =============================================================================
// summarizeResult — web_search
// =============================================================================
describe("summarizeResult() — web_search", () => {
  const text =
    `🔎 Results for "world cup"\n\n` +
    `1. 2022 FIFA World Cup\n   https://en.wikipedia.org/wiki/2022_FIFA_World_Cup\n   Argentina won.\n\n` +
    `2. FIFA.com\n   https://www.fifa.com/worldcup\n\n` +
    `Pick the most relevant result and call fetch_url on its URL to read the page.`;

  test("counts results and parses them into details", () => {
    const result = ta.summarizeResult("web_search", text);
    assert.equal(result.ok, true);
    assert.equal(result.summary, "2 results");
    assert.equal(result.details.length, 2);
    assert.deepEqual(result.details[0], {
      title: "2022 FIFA World Cup",
      url: "https://en.wikipedia.org/wiki/2022_FIFA_World_Cup",
      snippet: "Argentina won.",
    });
    assert.equal(result.details[1].url, "https://www.fifa.com/worldcup");
    assert.equal(result.details[1].snippet, ""); // snippet optional
  });

  test("singular wording for one result", () => {
    const one = `🔎 Results for "x"\n\n1. Only\n   https://example.com\n\nPick...`;
    const result = ta.summarizeResult("web_search", one);
    assert.equal(result.summary, "1 result");
    assert.equal(result.details.length, 1);
  });

  test("no-results page yields empty details", () => {
    const result = ta.summarizeResult("web_search", `🔎 No results for "zzz".`);
    assert.equal(result.summary, "no results");
    assert.deepEqual(result.details, []);
  });
});

// =============================================================================
// summarizeResult — generic
// =============================================================================
describe("summarizeResult() — generic", () => {
  test("returns short result as its own summary", () => {
    const result = ta.summarizeResult("tool", "OK");
    assert.deepEqual(result, { ok: true, summary: "OK" });
  });

  test("trims leading/trailing whitespace from short result", () => {
    const result = ta.summarizeResult("tool", "  hello  ");
    assert.equal(result.summary, "hello");
  });

  test("returns first line of multi-line short result", () => {
    const result = ta.summarizeResult("tool", "First line\nSecond line");
    assert.equal(result.summary, "First line");
  });

  test("handles empty string result", () => {
    const result = ta.summarizeResult("tool", "");
    // Empty string length 0 ≤ 80, firstLine returns "" which is falsy
    // So it falls through to formatBytes
    assert.equal(result.ok, true);
    assert.equal(result.summary, "0 B");
  });

  test("handles whitespace-only result", () => {
    const result = ta.summarizeResult("tool", "  \n  \n  ");
    // firstLine returns "  " (has content), trim gives ""
    // Actually firstLine splits on \n and finds l.trim()
    // "  " trimmed is "  ".trim() is "" which is falsy.
    // So find() returns undefined, and firstLine returns ""

    // Then text.length = 7 <= 80, but fl is "" which is falsy
    // So it goes to formatBytes
    assert.equal(result.ok, true);
  });

  test("returns size for result longer than 80 chars", () => {
    const text = "x".repeat(100);
    const result = ta.summarizeResult("tool", text);
    // text.length = 100 > 80, first line is all 100 chars
    // So goes to formatBytes
    assert.equal(result.ok, true);
    assert.equal(result.summary, "100 B");
  });

  test("returns byte size when result > 80 chars even if first line is short", () => {
    // The source code checks text.length <= 80, not first-line length.
    // A multi-line result whose total length exceeds 80 goes to formatBytes.
    const text = "Short first line\n" + "x".repeat(100);
    const result = ta.summarizeResult("tool", text);
    assert.equal(result.ok, true);
    assert.ok(result.summary.includes("B"), "should report byte size");
  });

  test("handles number result", () => {
    const result = ta.summarizeResult("tool", 42);
    assert.equal(result.ok, true);
    assert.equal(result.summary, "42");
  });

  test("handles object result with short toString", () => {
    const result = ta.summarizeResult("tool", { ok: true });
    assert.equal(result.ok, true);
    assert.equal(result.summary, "[object Object]");
  });

  test("handles null result as empty (null ?? '' is '')", () => {
    const result = ta.summarizeResult("tool", null);
    assert.equal(result.ok, true);
    // The source does `String(result ?? "")` so null → "" → empty → formatBytes
    assert.equal(result.summary, "0 B");
  });

  test("handles undefined result as empty (undefined ?? '' is '')", () => {
    const result = ta.summarizeResult("tool", undefined);
    assert.equal(result.ok, true);
    // The source does `String(result ?? "")` so undefined → "" → empty → formatBytes
    assert.equal(result.summary, "0 B");
  });
});
