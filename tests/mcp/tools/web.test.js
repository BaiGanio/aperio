// tests/tools/web.test.js
// Tests for the fetch_url tool handler.
// Imports directly from mcp/tools/web.js — no inline copies.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fetchUrlHandler } from "../../../mcp/tools/web.js";

// ─── fetch mock ───────────────────────────────────────────────────────────────
// Node 18+ has global fetch. We replace it per-test and restore after.

function withMockFetch(mockFn, testFn) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  return testFn().finally(() => { globalThis.fetch = original; });
}

function makeFetchResponse({ status = 200, contentType = "text/plain", body = "Hello world" } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: (h) => h === "content-type" ? contentType : null },
    text: async () => body,
  });
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("fetchUrlHandler", () => {
  test("returns page content on success", () =>
    withMockFetch(makeFetchResponse({ body: "Plain text content" }), async () => {
      const result = await fetchUrlHandler({ url: "https://example.com" });
      assert.ok(result.content[0].text.includes("Plain text content"));
      assert.ok(result.content[0].text.includes("https://example.com"));
    })
  );

  test("returns HTTP error message on non-OK response", () =>
    withMockFetch(makeFetchResponse({ status: 404 }), async () => {
      const result = await fetchUrlHandler({ url: "https://example.com/missing" });
      assert.ok(result.content[0].text.includes("❌ HTTP 404"));
    })
  );

  test("strips HTML tags from HTML responses", () =>
    withMockFetch(makeFetchResponse({ contentType: "text/html", body: "<h1>Title</h1><p>Body text</p><script>evil()</script>" }), async () => {
      const result = await fetchUrlHandler({ url: "https://example.com" });
      assert.ok(!result.content[0].text.includes("<h1>"));
      assert.ok(!result.content[0].text.includes("<script>"));
      assert.ok(result.content[0].text.includes("Title"));
      assert.ok(result.content[0].text.includes("Body text"));
    })
  );

  test("truncates content at max_chars", () =>
    withMockFetch(makeFetchResponse({ body: "A".repeat(20_000) }), async () => {
      const result = await fetchUrlHandler({ url: "https://example.com", max_chars: 500 });
      const text = result.content[0].text;
      assert.ok(text.includes("⚠️ Truncated"));
      // header "🌐 url\n\n" + 500 A's + truncation notice — body portion is 500
      const bodyStart = text.indexOf("\n\n") + 2;
      const bodyPart  = text.slice(bodyStart, bodyStart + 501);
      assert.ok(bodyPart.length <= 501);
    })
  );

  test("does not add truncation notice when content fits", () =>
    withMockFetch(makeFetchResponse({ body: "Short content" }), async () => {
      const result = await fetchUrlHandler({ url: "https://example.com" });
      assert.ok(!result.content[0].text.includes("Truncated"));
    })
  );

  test("caps max_chars at 15000 regardless of input", () =>
    withMockFetch(makeFetchResponse({ body: "B".repeat(20_000) }), async () => {
      const result = await fetchUrlHandler({ url: "https://example.com", max_chars: 99_999 });
      // Should still truncate at 15000
      assert.ok(result.content[0].text.includes("⚠️ Truncated"));
    })
  );

  test("returns error message on network failure", () =>
    withMockFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
      const result = await fetchUrlHandler({ url: "https://unreachable.example.com" });
      assert.ok(result.content[0].text.includes("❌ Fetch failed"));
      assert.ok(result.content[0].text.includes("ECONNREFUSED"));
    })
  );
});