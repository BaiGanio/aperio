// tests/lib/docgraph/backends/sqlite.test.js
//
// Integration test for the docgraph SQLite backend against a REAL SqliteStore
// (loads sqlite-vec and applies db/migrations-sqlite/004_docgraph.sql), so this
// also validates the migration DDL: FTS5 external-content table, vec0 sidecar,
// and the cleanup triggers.
//
// Embeddings use a deterministic fake (1024-dim) so the vec0 + hybrid-RRF path
// is exercised without loading the heavy local transformer model.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { installMemfs } from "../../../helpers/memfs.js";

// In-memory fs + ':memory:' DB → zero real disk access. Install BEFORE importing
// the backend (whose `fs/promises` named imports must bind to the patched
// module); backend/extract are imported dynamically in before() for that reason.
const mem = installMemfs({ root: "/mem/docg" });
let backend, extractMd;

let docsDir, oldPath, oldDims, store;

// Deterministic, non-zero 1024-dim vector seeded from the text. Same text →
// same vector, so a chunk is its own nearest neighbour. Async to match the real
// generateEmbedding contract (the backend calls .catch on its return value).
async function fakeEmbed(text) {
  const dims = 1024;
  const v = new Array(dims);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  for (let i = 0; i < dims; i++) { h = Math.imul(h ^ (h >>> 13), 16777619); v[i] = ((h >>> 0) % 1000) / 1000 + 0.001; }
  return v;
}

// Build the fileIterator that indexRepoFiles consumes (normally produced by the
// walker). Points at the real temp files so readFile/stat work.
async function* filesOf(root, rels) {
  for (const rel of rels) {
    yield { abs: join(root, rel), rel, mime: "text/markdown", extract: extractMd };
  }
}

before(async () => {
  backend = await import("../../../../lib/docgraph/backends/sqlite.js");
  ({ extract: extractMd } = await import("../../../../lib/docgraph/extract-md.js"));

  oldPath = process.env.SQLITE_PATH;
  oldDims = process.env.EMBEDDING_DIMS;
  process.env.SQLITE_PATH = ":memory:";
  process.env.EMBEDDING_DIMS = "1024"; // must match vec_docgraph_chunks FLOAT[1024]

  docsDir = join(mem.root, "docs");
  mem.mkdirp(docsDir);
  mem.writeFile(join(docsDir, "budget.md"), [
    "# Q3 Budget",
    "",
    "Overview of the quarter.",
    "",
    "## Marketing",
    "We will increase marketing spend on paid search and events.",
    "",
    "## Engineering",
    "Hiring two backend engineers.",
  ].join("\n"));
  mem.writeFile(join(docsDir, "notes.md"), [
    "# Research Notes",
    "",
    "## Embeddings",
    "Notes about vector embeddings and semantic search recall.",
    "",
    "## Invoices",
    "Paid INV-204871 to the events vendor; details at https://vendor.example.com/inv.",
  ].join("\n"));

  const { SqliteStore } = await import("../../../../db/sqlite.js");
  store = await SqliteStore.init();
});

after(async () => {
  await store?.close?.().catch(() => {});
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  if (oldDims) process.env.EMBEDDING_DIMS = oldDims; else delete process.env.EMBEDDING_DIMS;
  mem.restore();
});

describe("docgraph sqlite backend", () => {
  test("indexes a folder of markdown into documents/sections/chunks", async () => {
    const counts = await backend.indexRepoFiles(store, docsDir, filesOf(docsDir, ["budget.md", "notes.md"]), {
      generateEmbedding: fakeEmbed,
    });
    assert.equal(counts.docs, 2);
    assert.equal(counts.changed, 2);
    assert.ok(counts.sections >= 5, `expected sections, got ${counts.sections}`);
    assert.ok(counts.chunks >= 2, `expected chunks, got ${counts.chunks}`);
  });

  test("re-indexing unchanged files is a no-op (sha256 short-circuit)", async () => {
    const counts = await backend.indexRepoFiles(store, docsDir, filesOf(docsDir, ["budget.md", "notes.md"]), {
      generateEmbedding: fakeEmbed,
    });
    assert.equal(counts.docs, 2);
    assert.equal(counts.changed, 0);
  });

  test("doc_repos reports counts and a by-mime breakdown", async () => {
    const { repos } = await backend.repos(store);
    const r = repos.find((x) => x.root_path === docsDir);
    assert.ok(r, "folder is listed");
    assert.equal(r.docs, 2);
    assert.ok(r.chunks >= 2);
    assert.equal(r.by_mime["text/markdown"], 2);
  });

  test("FTS-only search finds the right section", async () => {
    const { matches, mode } = await backend.search(
      store, { query: "marketing spend" }, { generateEmbedding: fakeEmbed, vectorEnabled: () => false }
    );
    assert.equal(mode, "fulltext");
    assert.ok(matches.length > 0, "got hits");
    assert.equal(matches[0].document.rel_path, "budget.md");
    assert.equal(matches[0].section.heading, "Marketing");
    assert.match(matches[0].snippet, /marketing/i);
  });

  test("hybrid search runs the vec0 + RRF path and returns results", async () => {
    const { matches, mode } = await backend.search(
      store, { query: "vector embeddings" }, { generateEmbedding: fakeEmbed, vectorEnabled: () => true }
    );
    assert.equal(mode, "hybrid");
    assert.ok(matches.length > 0, "hybrid returned hits");
    assert.ok(typeof matches[0].score === "number");
  });

  test("doc_outline returns the section tree in order", async () => {
    const outline = await backend.outline(store, { path: "budget.md" });
    assert.equal(outline.title, "Q3 Budget");
    const headings = outline.sections.map((s) => s.heading);
    assert.ok(headings.includes("Marketing"));
    assert.ok(headings.includes("Engineering"));
    // ord is monotonic
    const ords = outline.sections.map((s) => s.ord);
    assert.deepEqual(ords, [...ords].sort((a, b) => a - b));
  });

  test("doc_context returns stored section text", async () => {
    const outline = await backend.outline(store, { path: "budget.md" });
    const marketing = outline.sections.find((s) => s.heading === "Marketing");
    const ref = await backend.context(store, { path: "budget.md", section_id: marketing.id });
    assert.equal(ref.mode, "section");
    assert.equal(ref.rel_path, "budget.md");
    assert.match(ref.text, /marketing spend/i);
  });

  test("mime filter narrows search", async () => {
    const { matches } = await backend.search(
      store, { query: "engineers", mime: "text/plain" }, { generateEmbedding: fakeEmbed, vectorEnabled: () => false }
    );
    assert.equal(matches.length, 0, "no text/plain docs indexed");
  });

  test("doc_refs finds documents mentioning an extracted ID", async () => {
    const { matches } = await backend.refs(store, { ref: "INV-204871" });
    assert.ok(matches.length > 0, "found the invoice ref");
    assert.equal(matches[0].document.rel_path, "notes.md");
    assert.equal(matches[0].kind, "id");
    assert.equal(matches[0].section.heading, "Invoices");
  });

  test("doc_refs matches a URL reference", async () => {
    const { matches } = await backend.refs(store, { ref: "https://vendor.example.com/inv" });
    assert.ok(matches.some((m) => m.kind === "url" && m.document.rel_path === "notes.md"));
  });
});
