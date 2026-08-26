// tests/unit/public/markdown-link-escape.test.js
//
// #466 — renderMarkdown() builds anchors as a template string that is later fed
// to innerHTML. The href used to be interpolated raw, so a `"` inside the URL
// closed the attribute and everything after it became attributes on the anchor
// (an inline event handler being the obvious payload). Chat markdown is written
// by the model and by tool output, so that string is not trusted input.
//
// markdown.js is a plain browser script with no exports and one top-level
// window.addEventListener, so it is evaluated in a vm context with a stub
// window rather than imported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../../public/scripts/markdown.js"), "utf8");

const sandbox = {
  window: { addEventListener() {}, Prism: null, mermaid: null },
  document: { addEventListener() {}, querySelectorAll: () => [] },
  console,
  queueMicrotask,
  setTimeout,
};
const ctx = createContext(sandbox);
runInContext(source, ctx);
const renderMarkdown = ctx.renderMarkdown;

test("a quote in a link URL cannot break out of the href attribute", () => {
  const html = renderMarkdown('[click](https://example.com/" onmouseover="alert(1))');
  // The handler text survives as inert characters — what must not survive is a
  // real, unencoded `"` that would end the href and start a new attribute.
  assert.ok(!/onmouseover="/.test(html), `event handler leaked into markup: ${html}`);
  assert.ok(html.includes("&quot;"), `quote was not encoded: ${html}`);
  // One opening and one closing quote around the href, and nothing between the
  // href value and the next real attribute but whitespace.
  assert.match(html, /<a href="[^"]*&quot;[^"]*" target="_blank"/);
});

test("an ordinary link with a query string is not double-escaped", () => {
  const html = renderMarkdown("[search](https://example.com/?a=1&b=2)");
  // `&` is escaped once, by the shared entity pass — not twice.
  assert.ok(html.includes("href=\"https://example.com/?a=1&amp;b=2\""), html);
  assert.ok(!html.includes("&amp;amp;"), `href was double-encoded: ${html}`);
});

test("plain links still render with the safe target/rel pair", () => {
  const html = renderMarkdown("[home](https://example.com)");
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">home<\/a>/);
});
