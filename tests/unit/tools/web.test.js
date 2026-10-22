// tests/tools/web.test.js
// Tests for the fetch_url tool handler.
// Imports directly from mcp/tools/web.js — no inline copies.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fetchUrlHandler, webSearchHandler, parseDdgResults } from "../../../mcp/tools/web.js";

// ─── fetch mock ───────────────────────────────────────────────────────────────
// Node 18+ has global fetch. We replace it per-test and restore after.
//
// fetchUrlHandler goes through safeFetch (SSRF guard + DNS pinning), which for a
// resolvable host bypasses globalThis.fetch entirely and issues a REAL request
// via https.request — so these tests were silently hitting the live network
// (regression from the DNS-pinning change in 0422378). Setting
// APERIO_ALLOW_INTERNAL_FETCH=1 makes safeFetch pass through to the mocked
// global fetch. The guard's own logic is covered by tests/lib/helpers/
// ssrfGuard.test.js; the one guard-behavior test here opts back in via
// { guard: true }.

function withMockFetch(mockFn, testFn, { guard = false } = {}) {
  const original  = globalThis.fetch;
  const prevGuard = process.env.APERIO_ALLOW_INTERNAL_FETCH;
  globalThis.fetch = mockFn;
  if (!guard) process.env.APERIO_ALLOW_INTERNAL_FETCH = "1";
  return testFn().finally(() => {
    globalThis.fetch = original;
    if (prevGuard === undefined) delete process.env.APERIO_ALLOW_INTERNAL_FETCH;
    else process.env.APERIO_ALLOW_INTERNAL_FETCH = prevGuard;
  });
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

  test("offset pages past truncated content", () =>
    withMockFetch(makeFetchResponse({ body: "A".repeat(15_000) + "MARKER" + "B".repeat(100) }), async () => {
      const result = await fetchUrlHandler({ url: "https://example.com", offset: 15_000 });
      const text = result.content[0].text;
      assert.ok(text.includes("MARKER"));
      assert.ok(!text.includes("AAAA"));
      assert.ok(!text.includes("Truncated"));
    })
  );

  test("truncation notice names the next offset", () =>
    withMockFetch(makeFetchResponse({ body: "C".repeat(20_000) }), async () => {
      const result = await fetchUrlHandler({ url: "https://example.com" });
      assert.ok(result.content[0].text.includes("offset: 15000"));
    })
  );

  test("returns error message on network failure", () =>
    withMockFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
      const result = await fetchUrlHandler({ url: "https://unreachable.example.com" });
      assert.ok(result.content[0].text.includes("❌ Fetch failed"));
      assert.ok(result.content[0].text.includes("ECONNREFUSED"));
    })
  );

  test("SSRF guard blocks internal URLs before fetching", () =>
    withMockFetch(async () => { throw new Error("fetch should not be called"); }, async () => {
      const result = await fetchUrlHandler({ url: "http://169.254.169.254/latest/meta-data/" });
      assert.ok(result.content[0].text.includes("SSRF guard"));
    }, { guard: true })
  );
});

// ─── web_search (DuckDuckGo) ─────────────────────────────────────────────────────

// A trimmed but structurally faithful slice of DDG's html endpoint output:
// real result links are wrapped in //duckduckgo.com/l/?uddg=<encoded>, titles
// and snippets carry nested tags/entities, and ad blocks use result--ad.
const DDG_HTML = `
<div class="result results_links_deep result--ad">
  <a class="result__a" href="//duckduckgo.com/y.js?ad=1">Buy World Cups</a>
  <a class="result__snippet">An advert.</a>
</div>
<div class="result results_links_deep web-result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2F2022_FIFA_World_Cup&rut=abc">2022 <b>FIFA World Cup</b></a>
  <a class="result__snippet">Argentina won the 2022 FIFA World Cup, beating France on penalties.</a>
</div>
<div class="result results_links_deep web-result">
  <a class="result__a" href="https://www.fifa.com/worldcup">FIFA.com &mdash; Official site</a>
  <a class="result__snippet">The home of the World Cup &amp; more.</a>
</div>`;

function makeHtmlResponse({ status = 200, body = DDG_HTML } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: () => "text/html" },
    text: async () => body,
  });
}

describe("parseDdgResults", () => {
  test("unwraps redirect links, strips tags/entities, skips ads", () => {
    const results = parseDdgResults(DDG_HTML, 10);
    assert.equal(results.length, 2); // ad block excluded
    assert.equal(results[0].url, "https://en.wikipedia.org/wiki/2022_FIFA_World_Cup");
    assert.equal(results[0].title, "2022 FIFA World Cup"); // <b> stripped
    assert.ok(results[0].snippet.includes("Argentina won"));
    assert.equal(results[1].url, "https://www.fifa.com/worldcup"); // direct href
    assert.ok(results[1].title.includes("—")); // &mdash; decoded
  });

  test("respects the max cap", () => {
    assert.equal(parseDdgResults(DDG_HTML, 1).length, 1);
  });

  test("returns [] for a CAPTCHA/empty page", () => {
    assert.deepEqual(parseDdgResults("<html><body>no results here</body></html>", 5), []);
  });
});

describe("webSearchHandler", () => {
  test("returns formatted results with title, url and snippet", () =>
    withMockFetch(makeHtmlResponse(), async () => {
      const result = await webSearchHandler({ query: "world cup winner" });
      const text = result.content[0].text;
      assert.ok(text.includes("1. 2022 FIFA World Cup"));
      assert.ok(text.includes("https://en.wikipedia.org/wiki/2022_FIFA_World_Cup"));
      assert.ok(text.includes("Argentina won"));
      assert.ok(text.includes("2. FIFA.com"));
    })
  );

  test("caps results at max_results", () =>
    withMockFetch(makeHtmlResponse(), async () => {
      const result = await webSearchHandler({ query: "q", max_results: 1 });
      const text = result.content[0].text;
      assert.ok(text.includes("1. 2022 FIFA World Cup"));
      assert.ok(!text.includes("2. "));
    })
  );

  test("rejects an empty query without fetching", () =>
    withMockFetch(async () => { throw new Error("fetch should not be called"); }, async () => {
      const result = await webSearchHandler({ query: "   " });
      assert.ok(result.content[0].text.includes("empty query"));
    })
  );

  test("reports a rate-limit/no-results page", () =>
    withMockFetch(makeHtmlResponse({ body: "<html>captcha</html>" }), async () => {
      const result = await webSearchHandler({ query: "anything" });
      assert.ok(result.content[0].text.includes("No results"));
    })
  );

  test("reports HTTP errors from DuckDuckGo", () =>
    withMockFetch(makeHtmlResponse({ status: 503 }), async () => {
      const result = await webSearchHandler({ query: "q" });
      assert.ok(result.content[0].text.includes("HTTP 503"));
    })
  );

  test("returns error message on network failure", () =>
    withMockFetch(async () => { throw new Error("ECONNREFUSED"); }, async () => {
      const result = await webSearchHandler({ query: "q" });
      assert.ok(result.content[0].text.includes("❌ web_search failed"));
      assert.ok(result.content[0].text.includes("ECONNREFUSED"));
    })
  );
});