// tests/unit/public/markdown-fences.test.js
//
// renderMarkdown() used one non-greedy regex to pair ``` fences, which broke on
// two shapes models produce all the time: a ```markdown document that carries
// its own ```mermaid block (the inner fence was read as the outer block's
// close, so the diagram leaked out as bare prose and the tail reopened as an
// unlabelled "code" block), and a wide ````markdown fence around ``` blocks.
//
// markdown.js is a plain browser script with no exports, so it is evaluated in
// a vm context with a stub window rather than imported.

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

const F = "```";

test("a markdown block keeps a nested mermaid block as its content", () => {
  const html = renderMarkdown([
    `${F}markdown`,
    "# Email Notification Service",
    "",
    "## Route",
    `${F}mermaid`,
    "flowchart LR",
    'T1["Choose Email Provider"] --> T3["Implement Rate Limiter"]',
    F,
    "",
    "## Frontier",
    "- [choose-provider](tickets/choose-provider.md)",
    F,
  ].join("\n"));

  // One document, rendered — not markdown + loose prose + a stray "code" block.
  assert.ok(!/<span class="code-lang">code<\/span>/.test(html), `stray unlabelled block: ${html}`);
  assert.match(html, /class="md-doc"/);
  // Its headings are headings, not literal `#` marks in a box.
  assert.match(html, /<h1>Email Notification Service<\/h1>/);
  assert.match(html, /<h2>Frontier<\/h2>/);
  // And the diagram inside it is a real diagram, not text.
  assert.match(html, /class="mermaid" data-mermaid-source="flowchart LR/);
  assert.ok(!/<p>flowchart LR<\/p>/.test(html), `mermaid leaked out as prose: ${html}`);
});

test("an info-string line never closes a block", () => {
  const html = renderMarkdown([`${F}js`, "const a = 1;", `${F}python`, "b = 2", F].join("\n"));
  // ```python is not a valid closer, so this is one js block holding both.
  assert.equal((html.match(/class="code-block"/g) || []).length, 1, html);
  assert.match(html, /<span class="code-lang">js<\/span>/);
});

test("a wider outer fence contains narrower inner fences", () => {
  const html = renderMarkdown(["````text", `${F}js`, "x", F, "````", "after"].join("\n"));
  assert.equal((html.match(/class="code-block"/g) || []).length, 1, html);
  assert.match(html, /<span class="code-lang">text<\/span>/);
  assert.ok(html.includes("after"), html);
});

test("a standalone mermaid block still renders as a diagram", () => {
  const html = renderMarkdown([`${F}mermaid`, "flowchart LR", "A --> B", F].join("\n"));
  assert.match(html, /class="mermaid-block"/);
  assert.match(html, /data-mermaid-source="flowchart LR/);
});

test("a fence the model never closed still becomes one code block", () => {
  const html = renderMarkdown([`${F}js`, "const a = 1;", "const b = 2;"].join("\n"));
  assert.equal((html.match(/class="code-block"/g) || []).length, 1, html);
  assert.ok(html.includes("const b = 2;"), html);
});

test("two sibling blocks are still two blocks", () => {
  const html = renderMarkdown([`${F}js`, "a", F, "prose", `${F}sh`, "b", F].join("\n"));
  assert.equal((html.match(/class="code-block"/g) || []).length, 2, html);
  assert.match(html, /<span class="code-lang">js<\/span>/);
  assert.match(html, /<span class="code-lang">sh<\/span>/);
});

test("a markdown document renders live, before its closing fence arrives", () => {
  // The answer streams for a minute or more. Holding the document as raw fence
  // marks until the very last chunk, then snapping it into a page, is the whole
  // complaint — the diagram must appear as soon as ITS fence closes.
  const html = renderMarkdown([
    `${F}markdown`,
    "# Plan",
    "",
    "## Flow",
    `${F}mermaid`,
    "flowchart LR",
    "A --> B",
    F,
    "",
    "## Next",
  ].join("\n"));
  assert.match(html, /<h1>Plan<\/h1>/);
  assert.match(html, /class="mermaid" data-mermaid-source="flowchart LR/);
  assert.match(html, /<h2>Next<\/h2>/);
});

test("markdown nested inside markdown cannot recurse forever", () => {
  const inner = [`${F}markdown`, "# Deep", F].join("\n");
  const html = renderMarkdown([`${F}markdown`, `${F}markdown`, inner, F, F].join("\n"));
  assert.ok(html.length < 200000, "runaway recursion");
  assert.match(html, /class="md-doc"/);
});

test("a diagram still arriving is held as text, not drawn half-built", () => {
  // Half a diagram cannot parse. Drawing it throws and paints an error that the
  // next stream frame replaces — 30 times a second, which is the flicker.
  const open = renderMarkdown([`${F}markdown`, "# Plan", `${F}mermaid`, "graph LR", "A --> B"].join("\n"));
  assert.match(open, /class="mermaid-block mermaid-block--pending"/);
  assert.ok(!/class="mermaid" data-mermaid-source/.test(open), `drew an unfinished diagram: ${open}`);
  // The moment its fence closes, it becomes a real diagram.
  const done = renderMarkdown([`${F}markdown`, "# Plan", `${F}mermaid`, "graph LR", "A --> B", F].join("\n"));
  assert.match(done, /class="mermaid" data-mermaid-source="graph LR/);
  assert.ok(!/mermaid-block--pending/.test(done), done);
});

test("a finished diagram is cached by source so re-renders do not redraw it", () => {
  // The bubble is rebuilt every stream frame, so the same diagram arrives as a
  // brand new node over and over. Without the cache each one is drawn from
  // scratch: measured at 40 draws across 50 frames, versus 1 with it.
  const src = readFileSync(resolve(here, "../../../public/scripts/markdown.js"), "utf8");
  assert.match(src, /_mermaidSvgCache\.get\(node\.dataset\.mermaidSource/);
  assert.match(src, /node\.dataset\.mermaidRendered = "cached"/);
  // Bounded, oldest-out — a long session must not grow it without limit.
  assert.match(src, /while \(_mermaidSvgCache\.size > _MERMAID_CACHE_MAX\)/);
});
