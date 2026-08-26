// tests/unit/public/markdown-image-escape.test.js
//
// renderMarkdown() builds the inline-image tag as a template string fed to
// innerHTML. The `src` attribute used to be built with a full escapeHtml()
// pass, but by that point the shared entity pass earlier in the same chain
// had already turned `&` into `&amp;` — so escapeHtml() re-encoded it to
// `&amp;amp;` and any image URL with a query string rendered with a broken
// `src`. The anchor rule beside it already avoided this by escaping only the
// `"` after the shared entity pass; this brings the image rule in line.
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

test("an https image URL with a query string is not double-escaped", () => {
  const html = renderMarkdown("![pic](https://example.com/image.png?w=100&h=100)");
  assert.ok(
    html.includes('src="https://example.com/image.png?w=100&amp;h=100"'),
    `src was not escaped exactly once: ${html}`
  );
  assert.ok(!html.includes("&amp;amp;"), `src was double-encoded: ${html}`);
});

test("a /scratch image URL with a query string is not double-escaped", () => {
  const html = renderMarkdown("![pic](/scratch/out.png?w=100&h=100)");
  assert.ok(
    html.includes('src="/scratch/out.png?w=100&amp;h=100"'),
    `src was not escaped exactly once: ${html}`
  );
  assert.ok(!html.includes("&amp;amp;"), `src was double-encoded: ${html}`);
});

test("a /uploads image URL with a query string is not double-escaped", () => {
  const html = renderMarkdown("![pic](/uploads/out.png?w=100&h=100)");
  assert.ok(
    html.includes('src="/uploads/out.png?w=100&amp;h=100"'),
    `src was not escaped exactly once: ${html}`
  );
  assert.ok(!html.includes("&amp;amp;"), `src was double-encoded: ${html}`);
});

test("a quote in an image URL cannot break out of the src attribute", () => {
  // No space in the payload: the image URL charset excludes whitespace, so a
  // space would just fail to match as an image at all (a separate, unrelated
  // behavior) rather than exercise the quote-escaping this test targets.
  const html = renderMarkdown('![pic](https://example.com/"onerror="x)');
  assert.ok(!/onerror="x/.test(html), `event handler leaked into markup: ${html}`);
  assert.ok(html.includes("&quot;"), `quote was not encoded: ${html}`);
  assert.match(html, /<img class="chat-image" src="[^"]*&quot;[^"]*" alt="/);
});

test("unsupported schemes are not rendered as images", () => {
  const html = renderMarkdown("![pic](javascript:alert(1))");
  assert.ok(!html.includes('<img'), `unsafe scheme was rendered as an image: ${html}`);
  const html2 = renderMarkdown("![pic](data:text/html,<script>alert(1)</script>)");
  assert.ok(!html2.includes('<img'), `unsafe scheme was rendered as an image: ${html2}`);
});

test("alt text with quotes stays safely escaped", () => {
  const html = renderMarkdown(`![Bob's "great" pic](https://example.com/image.png)`);
  assert.ok(
    html.includes('alt="Bob&#39;s &quot;great&quot; pic"'),
    `alt text was not escaped correctly: ${html}`
  );
});
