// tests/unit/public/deliverable-stripping.test.js
//
// A long fenced block is saved to the workspace and surfaced as a download
// card. It used to be removed from the bubble as well — for markdown that left
// an EMPTY bubble beside a lone card whenever the model's whole answer was the
// document, which is exactly what "show me the plan" asks for. Markdown now
// stays visible; HTML/SVG source still hides behind its card.
//
// deliverables.js is a classic browser script sharing globals with markdown.js,
// so both are evaluated in one vm context rather than imported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const sandbox = {
  window: { addEventListener() {}, Prism: null, mermaid: null },
  document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => null },
  console,
  queueMicrotask,
  setTimeout,
};
const ctx = createContext(sandbox);
for (const f of ["public/scripts/markdown.js", "public/scripts/streaming/deliverables.js"]) {
  runInContext(readFileSync(resolve(root, f), "utf8"), ctx);
}

const F = "```";
const longMd = [
  "# Email Notification Service",
  "",
  "## Route",
  `${F}mermaid`,
  "flowchart LR",
  'A["Trigger"] --> B["Queue"]',
  F,
  "",
  "## Frontier",
  ...Array.from({ length: 20 }, (_, i) => `- [ticket-${i}](tickets/ticket-${i}.md)`),
].join("\n");
const longHtml = "<!DOCTYPE html>\n<html><head><title>Dash</title></head>\n" +
  Array.from({ length: 30 }, (_, i) => `<div>row ${i}</div>`).join("\n") + "\n</html>";

test("a long markdown document is saved AND stays in the bubble", () => {
  const { text, files } = ctx._stripDeliverables(`${F}markdown\n${longMd}\n${F}`);
  assert.equal(files.length, 1, "the file is still saved and carded");
  assert.equal(files[0].name, "document.md");
  assert.ok(files[0].content.includes("flowchart LR"), files[0].content);
  // The bubble is not left empty — the whole document is still there to read.
  assert.ok(text.includes("# Email Notification Service"), text);
  assert.ok(text.includes("- [ticket-19](tickets/ticket-19.md)"), text);
  // And it renders as one document with its diagram drawn — not a box of marks.
  const html = ctx.renderMarkdown(text);
  assert.equal((html.match(/class="code-block"/g) || []).length, 0, html);
  assert.match(html, /<h1>Email Notification Service<\/h1>/);
  assert.match(html, /class="mermaid" data-mermaid-source="flowchart LR/);
});

test("a long HTML build is still hidden behind its card", () => {
  const { text, files } = ctx._stripDeliverables(`Here you go:\n${F}html\n${longHtml}\n${F}`);
  assert.equal(files.length, 1);
  assert.match(files[0].name, /\.html$/);
  assert.ok(!text.includes("<!DOCTYPE html>"), `HTML source leaked into the bubble: ${text}`);
  assert.ok(text.includes("Here you go:"), text);
});

test("a short markdown block is neither saved nor moved", () => {
  const short = `${F}markdown\n# Title\n\n- one\n- two\n${F}`;
  const { text, files } = ctx._stripDeliverables(short);
  assert.equal(files.length, 0);
  assert.equal(text.trim(), short.trim());
});

test("markdown is exempt from the saved-file duplicate sweep", () => {
  // The sweep removes an inline block whose text is part of a saved file. That
  // would undo the rule above the moment the card arrives, so it skips md.
  const badges = readFileSync(resolve(root, "public/scripts/streaming/badges.js"), "utf8");
  assert.match(badges, /if \(lang === "md" \|\| lang === "markdown"\) return false;/);
  // The size guard that protects short blocks must survive alongside it.
  assert.match(badges, /text\.split\("\\n"\)\.length >= 5 \|\| text\.length >= 200/);
});

// While a ```markdown document is still arriving, the split between "finished"
// and "still typing" was decided by counting ``` marks and cutting at the last
// one. With a finished ```mermaid pair nested inside the open document that put
// the cut in the wrong place, and the chat showed a closed "markdown" box plus
// a second "code · streaming…" box for one and the same document.
test("a streaming markdown document is one open block, not two boxes", () => {
  const frames = [
    `${F}markdown\n# Plan\n`,
    `${F}markdown\n# Plan\n\n## Route\n${F}mermaid\nflowchart LR\nA --> B\n`,
    `${F}markdown\n# Plan\n\n## Route\n${F}mermaid\nflowchart LR\nA --> B\n${F}\n`,
    `${F}markdown\n# Plan\n\n## Route\n${F}mermaid\nflowchart LR\nA --> B\n${F}\n\n## Phases\n- one\n`,
  ];
  for (const text of frames) {
    const parts = ctx.scanFences(text);
    assert.equal(parts.length, 1, `frame split into ${parts.length} parts: ${text}`);
    assert.equal(parts[0].fence, true);
    assert.equal(parts[0].closed, false, "the document is still open");
    assert.equal(parts[0].lang, "markdown");
  }
  // Once the closing fence lands, the block is closed and rendered for real.
  const done = frames[3] + `${F}`;
  const parts = ctx.scanFences(done);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].closed, true);
  assert.ok(parts[0].code.includes("## Phases"), parts[0].code);
});

test("a closed block followed by prose is not mistaken for an open one", () => {
  const parts = ctx.scanFences(`${F}js\nconst a = 1;\n${F}\nand that is it`);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].closed, true);
  assert.equal(parts[1].fence, false);
});
