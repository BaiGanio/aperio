// tests/lib/agent/tool-hooks.test.js
//
// Tests for the final-answer hallucination guard (verifyFileClaims). The guard
// catches the model claiming a downloadable file was produced when it is not in
// the scratch workspace, in either word order:
//   "generated output.pdf"            (verb → file)
//   "output.pdf has been generated"   (file → verb)
// Reverse order requires a passive auxiliary so an unrelated file the model
// merely read ("read input.pdf and produced X") is not flagged.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";

import { createToolHooks } from "../../../lib/agent/tool-hooks.js";

const noop = () => {};
const silentLogger = { info: noop, warn: noop, error: noop };

// Build a turn's hooks with an injected scratch directory whose contents are
// `onDisk`. Returns verifyFileClaims plus the list of emitter events.
function makeHooks({ scratch = "/scratch", onDisk = [] } = {}) {
  const events = [];
  const emitter = { send: (e) => events.push(e) };
  const factory = createToolHooks({
    callTool: noop,
    summarizeArgs: noop,
    summarizeResult: noop,
    getActiveScratchDir: () => scratch,
    resolveScratchPath: (p) => p,
    validateWrittenFile: noop,
    logger: silentLogger,
    WRITE_TOOLS: new Set(),
    CONFIRM_TOOLS: new Set(),
    // Mirror the workspace: an absolute path "exists" iff its basename is onDisk.
    // verifyFileClaims uses existsSync directly to verify cited scratch paths.
    existsSync: (p) => onDisk.includes(basename(p)),
    statSync: () => ({ size: 1, isFile: () => true }),
    readdirSync: () => onDisk,
    copyFileSync: noop,
    basename,
    join,
  });
  const hooks = factory(emitter, Date.now());
  return {
    verifyFileClaims: hooks.verifyFileClaims,
    surfaceArtifact: hooks.surfaceArtifact,
    flushDownloadCards: hooks.flushDownloadCards,
    events,
  };
}

// Download cards queued for a set of paths, after flushing to the emitter.
function cardsFor(paths) {
  const { surfaceArtifact, flushDownloadCards, events } = makeHooks();
  for (const p of paths) surfaceArtifact(p);
  flushDownloadCards();
  return events.filter((e) => e.type === "generated_file");
}

// Did the guard emit a "not actually in the workspace" correction?
function warned(events) {
  return events.some(
    (e) => e.type === "token" && /not actually in the workspace/.test(e.text || ""),
  );
}

describe("verifyFileClaims() — hallucination guard", () => {
  test("flags a reverse-order claim (file → verb) for a missing file", () => {
    const { verifyFileClaims, events } = makeHooks({ onDisk: [] });
    verifyFileClaims("The PDF file `output.pdf` has been generated successfully in your scratch workspace!");
    assert.equal(warned(events), true);
  });

  test("flags a forward-order claim (verb → file) for a missing file", () => {
    const { verifyFileClaims, events } = makeHooks({ onDisk: [] });
    verifyFileClaims("I generated output.pdf for you.");
    assert.equal(warned(events), true);
  });

  test("does NOT flag a claim when the file is actually on disk", () => {
    const { verifyFileClaims, events } = makeHooks({ onDisk: ["output.pdf"] });
    verifyFileClaims("The PDF file `output.pdf` has been generated successfully!");
    assert.equal(warned(events), false);
  });

  test("does NOT flag a file the model merely read (no passive auxiliary)", () => {
    const { verifyFileClaims, events } = makeHooks({ onDisk: ["summary.docx"] });
    // input.pdf is read, summary.docx is produced (and is on disk) — neither warns.
    verifyFileClaims("I read input.pdf and then produced summary.docx.");
    assert.equal(warned(events), false);
  });

  test("does NOT flag prose that mentions no produced file", () => {
    const { verifyFileClaims, events } = makeHooks({ onDisk: [] });
    verifyFileClaims("Note: input.pdf is large, so I summarized it.");
    assert.equal(warned(events), false);
  });

  // Regression: a weak model announced "is ready at <path>" for a file that was
  // never produced. "ready" is not a creation verb, and the filename sat on a
  // different line from the verb, so the verb-based matcher missed it entirely.
  // The cited absolute scratch path must be verified regardless of the verb.
  test("flags a missing file cited as a path ('ready at <scratch path>')", () => {
    const { verifyFileClaims, events } = makeHooks({ scratch: "/scratch", onDisk: [] });
    verifyFileClaims("Your test PDF is ready at:\n`/scratch/test-docgraph.pdf`\nTry it with doc_search.");
    assert.equal(warned(events), true);
  });

  test("does NOT flag a cited scratch path when the file is on disk", () => {
    const { verifyFileClaims, events } = makeHooks({ scratch: "/scratch", onDisk: ["test-docgraph.pdf"] });
    verifyFileClaims("Your test PDF is ready at:\n`/scratch/test-docgraph.pdf`");
    assert.equal(warned(events), false);
  });

  test("flags an availability claim ('the report is available') for a missing file", () => {
    const { verifyFileClaims, events } = makeHooks({ onDisk: [] });
    verifyFileClaims("Done — the report.xlsx is available in your workspace.");
    assert.equal(warned(events), true);
  });
});

describe("surfaceArtifact() — download-card filtering", () => {
  // Regression: generator scripts were surfaced as download cards (the user saw
  // "generate-test-pdf.js" offered for download instead of the PDF). Only
  // deliverables may become cards.
  test("does NOT surface generator scripts (.js/.cjs/.py)", () => {
    const cards = cardsFor([
      "/var/scratch/sess/generate-test-pdf.js",
      "/var/scratch/sess/generate-test-pdf.cjs",
      "/var/scratch/sess/build.py",
    ]);
    assert.equal(cards.length, 0);
  });

  test("surfaces deliverables (pdf/pptx/docx/xlsx/csv)", () => {
    const cards = cardsFor([
      "/var/scratch/sess/report.pdf",
      "/var/scratch/sess/deck.pptx",
      "/var/scratch/sess/data.csv",
    ]);
    assert.deepEqual(cards.map((c) => c.filename).sort(), ["data.csv", "deck.pptx", "report.pdf"]);
  });

  // A "build a landing page" deliverable is a static web file; it must surface
  // so the user gets a Preview/Download card instead of code dumped in chat.
  test("surfaces web deliverables (html/svg/md)", () => {
    const cards = cardsFor([
      "/var/scratch/sess/index.html",
      "/var/scratch/sess/logo.svg",
      "/var/scratch/sess/README.md",
    ]);
    assert.deepEqual(cards.map((c) => c.filename).sort(), ["README.md", "index.html", "logo.svg"]);
  });
});

describe("callToolHooked() — repeated-failure loop breaker", () => {
  function makeLoopHooks(toolResult) {
    const events = [];
    const factory = createToolHooks({
      callTool: async () => toolResult,
      summarizeArgs: () => "",
      summarizeResult: () => ({ ok: false, summary: "" }),
      getActiveScratchDir: () => "/scratch",
      resolveScratchPath: (p) => p,
      validateWrittenFile: noop,
      logger: silentLogger,
      WRITE_TOOLS: new Set(),
      CONFIRM_TOOLS: new Set(),
      existsSync: () => true,
      statSync: () => ({ size: 1, isFile: () => true }),
      readdirSync: () => [],
      copyFileSync: noop,
      basename, join,
    });
    const hooks = factory({ send: (e) => events.push(e) }, Date.now());
    return { callToolHooked: hooks.callToolHooked, events };
  }

  test("halts after 3 identical failing calls and redirects to inline output", async () => {
    const { callToolHooked, events } = makeLoopHooks("❌ Script not found: /scratch/x.js");
    const r1 = await callToolHooked("run_node_script", { script: "/scratch/x.js" });
    const r2 = await callToolHooked("run_node_script", { script: "/scratch/x.js" });
    const r3 = await callToolHooked("run_node_script", { script: "/scratch/x.js" });
    assert.match(r1, /Script not found/);
    assert.match(r2, /Script not found/);
    assert.match(r3, /STOP/);   // third identical failure trips the breaker
    assert.ok(events.some((e) => e.type === "tool_budget_exhausted"));
  });

  test("does not trip on distinct (non-identical) failing calls", async () => {
    const { callToolHooked } = makeLoopHooks("❌ Script not found");
    await callToolHooked("run_node_script", { script: "/scratch/a.js" });
    await callToolHooked("run_node_script", { script: "/scratch/b.js" });
    const r3 = await callToolHooked("run_node_script", { script: "/scratch/c.js" });
    assert.doesNotMatch(r3, /STOP/);
  });
});
