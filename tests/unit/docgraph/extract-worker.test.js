// tests/unit/docgraph/extract-worker.test.js
//
// Equivalence, against the real worker thread. Moving extraction off the main
// thread (issue S2.1) is only safe if the worker returns exactly what
// in-process extraction returns, and that is not free: a structured clone is
// not a function call.
//
// The bug this file exists for: every docgraph extractor is handed the file's
// bytes and calls `buf.toString('utf8')`. A Buffer does not survive structured
// clone as a Buffer — it arrives as a plain Uint8Array, whose `toString()`
// returns "104,101,108,..." instead of text. Indexing a whole corpus that way
// still *succeeds*; it quietly produces one garbage section per document. A
// measured run caught it only because the section count fell from 2670 to 189.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

import { extract as extractMd } from "../../../lib/docgraph/extract-md.js";
import { extract as extractHtml } from "../../../lib/docgraph/extract-html.js";

const WORKER_URL = new URL("../../../lib/docgraph/extract-worker.js", import.meta.url);

let worker;
let seq = 0;
const pending = new Map();

before(async () => {
  worker = new Worker(WORKER_URL);
  worker.on("message", (msg) => {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  await new Promise((resolve, reject) => {
    worker.once("online", resolve);
    worker.once("error", reject);
  });
});

after(async () => { await worker?.terminate(); });

function onWorker(key, source, relPath) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, key, source, relPath });
  });
}

const MARKDOWN = `---
title: Sample
---

Preamble text that belongs to no heading.

# First

Body of the first section, long enough to matter. See https://example.com/a.

## Nested

Deeper body text.

# Second

Another section with a [link](./other.md).
`;

const HTML = `<html><head><title>Doc title</title></head><body>
<h1>Heading one</h1><p>Some body text.</p>
<h2>Heading two</h2><p>More body text.</p>
</body></html>`;

describe("docgraph extract-worker", () => {
  test("markdown: a Buffer payload yields exactly the in-process result", async () => {
    const buf = Buffer.from(MARKDOWN, "utf8");
    const expected = await extractMd(buf, "sample.md");
    const got = await onWorker("md", buf, "sample.md");
    assert.equal(got.ok, true, `worker failed: ${JSON.stringify(got.error)}`);
    assert.deepEqual(got.result, expected);
  });

  test("markdown: the worker finds real sections, not one garbage blob", async () => {
    // Teeth for the Uint8Array bug specifically. Re-wrapping removed, the
    // extractor sees "45,45,45,10,..." — no headings, so exactly one section
    // and no refs. Assert the shape that only correct text can produce.
    const got = await onWorker("md", Buffer.from(MARKDOWN, "utf8"), "sample.md");
    assert.ok(got.result.sections.length >= 4,
      `expected the headings to be found, got ${got.result.sections.length} section(s)`);
    assert.equal(got.result.title, "Sample");
    assert.ok(
      got.result.sections.some((s) => s.heading === "First"),
      "a heading from the document must appear verbatim",
    );
    for (const s of got.result.sections) {
      assert.ok(!/^\d+(,\d+)+$/.test(s.text.trim()),
        "a section whose text is comma-joined byte values means the Buffer was not re-wrapped");
    }
  });

  test("html: a Buffer payload yields exactly the in-process result", async () => {
    const buf = Buffer.from(HTML, "utf8");
    const expected = await extractHtml(buf, "page.html");
    const got = await onWorker("html", buf, "page.html");
    assert.equal(got.ok, true, `worker failed: ${JSON.stringify(got.error)}`);
    assert.deepEqual(got.result, expected);
  });

  test("an unknown key is an error, not a crash", async () => {
    const got = await onWorker("not-a-format", Buffer.from("x"), "x.zzz");
    assert.equal(got.ok, false);
    assert.equal(got.error.code, "EXTRACT_NO_KEY");
    // The worker must still answer afterwards.
    const after = await onWorker("md", Buffer.from("# ok\n\nbody\n"), "ok.md");
    assert.equal(after.ok, true);
  });

  test("an extractor failure comes back as a message, not a dead worker", async () => {
    // A .docx extractor handed bytes that are not a zip container fails inside
    // the parser. The worker must report it and stay usable.
    const got = await onWorker("docx", Buffer.from("definitely not a docx"), "broken.docx");
    assert.equal(got.ok, false);
    assert.equal(typeof got.error.message, "string");
    const after = await onWorker("md", Buffer.from("# still here\n"), "ok.md");
    assert.equal(after.ok, true);
  });
});
