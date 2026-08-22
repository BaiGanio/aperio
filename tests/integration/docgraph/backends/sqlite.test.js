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

  test("deferEmbedding returns pending chunks and skips inline embedding", async () => {
    const deferDir = join(mem.root, "deferred");
    mem.mkdirp(deferDir);
    mem.writeFile(join(deferDir, "later.md"), "# Later\nThis content is embedded by the queue, not inline.");

    const counts = await backend.indexRepoFiles(store, deferDir, filesOf(deferDir, ["later.md"]), {
      generateEmbedding: fakeEmbed,
      deferEmbedding: true,
    });
    assert.equal(counts.changed, 1);
    assert.ok(Array.isArray(counts.pending) && counts.pending.length >= 1, "returns pending chunks");

    // No vectors written inline — the chunk rows exist with no vec0 sidecar row yet.
    const id = counts.pending[0].id;
    const before = store.db.prepare(`SELECT COUNT(*) AS n FROM vec_docgraph_chunks WHERE rowid = ?`).get(BigInt(id)).n;
    assert.equal(before, 0, "chunk is not embedded inline");

    // Backfilling via the queue target writes the vector.
    await backend.setChunkEmbedding(store, id, await fakeEmbed("later content"));
    const after = store.db.prepare(`SELECT COUNT(*) AS n FROM vec_docgraph_chunks WHERE rowid = ?`).get(BigInt(id)).n;
    assert.equal(after, 1, "setChunkEmbedding backfills the vector");
  });

  test("listChunksWithoutEmbeddings finds a still-unembedded chunk after a clear (Gap 1 P1 backfill)", async () => {
    const stillPendingDir = join(mem.root, "still-pending");
    mem.mkdirp(stillPendingDir);
    mem.writeFile(join(stillPendingDir, "stale.md"), "# Stale\nThis chunk stays unembedded on purpose.");

    const counts = await backend.indexRepoFiles(store, stillPendingDir, filesOf(stillPendingDir, ["stale.md"]), {
      generateEmbedding: fakeEmbed,
      deferEmbedding: true,
    });
    const id = counts.pending[0].id;

    // Simulates exactly the scenario the review flagged: a provider change
    // clears vec_docgraph_chunks, and this chunk's file never changes again,
    // so re-indexing would never revisit it — only a direct scan finds it.
    const pending = await backend.listChunksWithoutEmbeddings(store, stillPendingDir);
    assert.ok(pending.some(p => p.id === id), "unembedded chunk must be found by the direct scan");

    await backend.setChunkEmbedding(store, id, await fakeEmbed("stale content"));
    const afterEmbed = await backend.listChunksWithoutEmbeddings(store, stillPendingDir);
    assert.ok(!afterEmbed.some(p => p.id === id), "once embedded, the chunk must drop out of the pending list");

    // Regression: a second watched root's own pending chunk must not leak
    // into stillPendingDir's scan (the bug the review flagged).
    const otherDir = join(mem.root, "other-root");
    mem.mkdirp(otherDir);
    mem.writeFile(join(otherDir, "other.md"), "# Other\nBelongs to a different watched root.");
    const otherCounts = await backend.indexRepoFiles(store, otherDir, filesOf(otherDir, ["other.md"]), {
      generateEmbedding: fakeEmbed,
      deferEmbedding: true,
    });
    const otherId = otherCounts.pending[0].id;
    const scoped = await backend.listChunksWithoutEmbeddings(store, stillPendingDir);
    assert.ok(!scoped.some(p => p.id === otherId), "must not include another watched root's pending chunk");
    const otherScoped = await backend.listChunksWithoutEmbeddings(store, otherDir);
    assert.ok(otherScoped.some(p => p.id === otherId), "the other root's own scan must still find its chunk");
  });

  test("doc_repos reports counts and a by-mime breakdown", async () => {
    const { repos } = await backend.repos(store);
    const r = repos.find((x) => x.root_path === docsDir);
    assert.ok(r, "folder is listed");
    assert.equal(r.docs, 2);
    assert.ok(r.chunks >= 2);
    assert.equal(r.by_mime["text/markdown"], 2);
  });

  test("doc_manifest discovers and bounds candidates before content reads", async () => {
    const manifest = await backend.manifest(store, { query: "marketing budget", folder: docsDir, limit: 1 });
    assert.equal(manifest.found, 2);
    assert.equal(manifest.selected, 1);
    assert.equal(manifest.truncated, true);
    assert.equal(manifest.candidates[0].rel_path, "budget.md");
    assert.ok(manifest.candidates[0].selection_reason.includes("matched"));
    // Regression: the manifest query must never GROUP_CONCAT full section
    // bodies (that's the point of manifest-first — bounded metadata before
    // any content read). Scoring off headings alone is still enough to match
    // "marketing" (a subheading in budget.md, not in its title/rel_path).
    assert.ok(!("content" in manifest.candidates[0]), "manifest candidates must not carry full document body text");
  });

  test("doc_batch reassembles sections in document order (s.ord), not row-insertion order", async () => {
    // Regression: GROUP_CONCAT without an explicit ORDER BY can rearrange
    // sections depending on the query planner. Seed sections in reverse
    // insertion order relative to their `ord` value — if the fix regresses,
    // the reassembled text comes back "Third / Second / First" instead.
    const repoId = store.db.prepare(
      `INSERT INTO docgraph_repos (root_path, last_indexed_at) VALUES (?, ?)`
    ).run("/fictional/ordering-test", new Date().toISOString()).lastInsertRowid;
    const docId = store.db.prepare(
      `INSERT INTO docgraph_documents (repo_id, rel_path, mime, size, sha256, title)
       VALUES (?, 'ordering.md', 'text/markdown', 10, 'ordering-sha', 'Ordering Test')`
    ).run(repoId).lastInsertRowid;
    const insertSection = store.db.prepare(
      `INSERT INTO docgraph_sections (document_id, ord, level, heading, text) VALUES (?, ?, 1, ?, ?)`
    );
    // Inserted out of `ord` order on purpose.
    insertSection.run(docId, 2, "Third", "Third section text.");
    insertSection.run(docId, 0, "First", "First section text.");
    insertSection.run(docId, 1, "Second", "Second section text.");

    const result = await backend.batch(store, {
      candidates: [{ id: Number(docId), rel_path: "ordering.md", size: 10 }],
    });
    assert.equal(result.documents[0].status, "read");
    const lines = result.documents[0].text.split("\n\n");
    assert.deepEqual(lines, ["First section text.", "Second section text.", "Third section text."]);
  });

  test("doc_batch never trusts a model-supplied sha256 for dedup identity — it is always overwritten with the value actually stored for the candidate's id (P1 fix)", async () => {
    // Two distinct real documents, A and B, each with its own real sha256.
    const repoId = store.db.prepare(
      `INSERT INTO docgraph_repos (root_path, last_indexed_at) VALUES (?, ?)`
    ).run("/fictional/sha256-trust-test", new Date().toISOString()).lastInsertRowid;
    const docAId = store.db.prepare(
      `INSERT INTO docgraph_documents (repo_id, rel_path, mime, size, sha256, title)
       VALUES (?, 'doc-a.md', 'text/markdown', 10, 'real-sha-a', 'Doc A')`
    ).run(repoId).lastInsertRowid;
    const docBId = store.db.prepare(
      `INSERT INTO docgraph_documents (repo_id, rel_path, mime, size, sha256, title)
       VALUES (?, 'doc-b.md', 'text/markdown', 10, 'real-sha-b', 'Doc B')`
    ).run(repoId).lastInsertRowid;
    store.db.prepare(`INSERT INTO docgraph_sections (document_id, ord, level, heading, text) VALUES (?, 0, 1, NULL, ?)`)
      .run(docAId, "Document A's real content.");
    store.db.prepare(`INSERT INTO docgraph_sections (document_id, ord, level, heading, text) VALUES (?, 0, 1, NULL, ?)`)
      .run(docBId, "Document B's real content.");

    const sessionId = "sha256-trust-session";
    // Read A for real, priming the session's dedup cache under A's REAL sha256.
    const firstA = await backend.batch(store, {
      candidates: [{ id: Number(docAId), rel_path: "doc-a.md", size: 10, sha256: "real-sha-a" }],
      sessionId,
    });
    assert.equal(firstA.documents[0].text, "Document A's real content.");

    // Now request B, but with a MODEL-SUPPLIED sha256 that is stale/copied
    // from A — as if the model echoed an old manifest row by mistake, or a
    // hand-crafted tool call. Before the fix, the dedup-hit branch trusted
    // this value directly and would have returned A's cached text/facts
    // under B's id and rel_path — silently corrupting aggregation. After the
    // fix, the true DB row for B's id is looked up first, overwriting the
    // untrustworthy candidate.sha256 before dedup ever runs.
    const requestForB = await backend.batch(store, {
      candidates: [{ id: Number(docBId), rel_path: "doc-b.md", size: 10, sha256: "real-sha-a" }],
      sessionId,
    });
    const docB = requestForB.documents[0];
    assert.equal(docB.rel_path, "doc-b.md");
    assert.equal(
      docB.text, "Document B's real content.",
      "B's own real content must be returned — a stale/mismatched sha256 in the request must never dedup B against A's cache entry",
    );
    assert.ok(!docB.dedup, "B was never actually read in this session before — it must not be reported as a dedup hit");
  });

  test("doc_batch falls back to sha256: null (never dedup) for a candidate id no longer in the index", async () => {
    const result = await backend.batch(store, {
      candidates: [{ id: 999999, rel_path: "gone.md", size: 10, sha256: "whatever-the-caller-supplied" }],
      sessionId: "sha256-trust-session-2",
    });
    // Not found by readBatch's own id-based query either — reported as
    // skipped, not silently coerced into a dedup hit against unrelated state.
    assert.equal(result.documents[0].status, "skipped");
  });

  test("two indexed documents sharing a sha256 never misattribute identity — the second twin's dedup hit carries ITS OWN id/path/title (round 8, P1)", async () => {
    const repoId = store.db.prepare(
      `INSERT INTO docgraph_repos (root_path, last_indexed_at) VALUES (?, ?)`
    ).run("/fictional/twin-test", new Date().toISOString()).lastInsertRowid;
    const twinAId = store.db.prepare(
      `INSERT INTO docgraph_documents (repo_id, rel_path, mime, size, sha256, title)
       VALUES (?, 'a/invoice.md', 'text/markdown', 10, 'shared-twin-sha', 'Twin A')`
    ).run(repoId).lastInsertRowid;
    const twinBId = store.db.prepare(
      `INSERT INTO docgraph_documents (repo_id, rel_path, mime, size, sha256, title)
       VALUES (?, 'b/invoice.md', 'text/markdown', 10, 'shared-twin-sha', 'Twin B')`
    ).run(repoId).lastInsertRowid;
    const sharedText = "Invoice with Amount Due: 99.00 BGN on 15.06.2026.";
    store.db.prepare(`INSERT INTO docgraph_sections (document_id, ord, level, heading, text) VALUES (?, 0, 1, NULL, ?)`)
      .run(twinAId, sharedText);
    store.db.prepare(`INSERT INTO docgraph_sections (document_id, ord, level, heading, text) VALUES (?, 0, 1, NULL, ?)`)
      .run(twinBId, sharedText);

    const sessionId = "twin-session";
    // Read twin A for real — primes the dedup cache under the shared sha256
    // with A's identity.
    await backend.batch(store, {
      candidates: [{ id: Number(twinAId), rel_path: "a/invoice.md", size: 10, sha256: "shared-twin-sha" }],
      sessionId,
    });

    // Now request twin B: same content, DIFFERENT document. Its dedup hit
    // must carry B's OWN identity — before the fix, the cached A identity
    // (id/rel_path/title) was spread back over B's result, attaching B's
    // facts to A's stable path downstream (aggregation/auto-memory).
    const twinB = await backend.batch(store, {
      candidates: [{ id: Number(twinBId), rel_path: "b/invoice.md", size: 10, sha256: "shared-twin-sha" }],
      sessionId,
    });
    const doc = twinB.documents[0];
    assert.equal(doc.dedup, true, "sanity: identical content dedups within the session");
    assert.equal(doc.id, Number(twinBId), "identity follows the requested document");
    assert.equal(doc.rel_path, "b/invoice.md");
    assert.equal(doc.title, "Twin B");
    assert.match(doc.text, /Amount Due: 99.00 BGN/, "content facts still come from the cache");
  });

  test("a renamed-but-unchanged document returns its CURRENT DB identity on a dedup hit, not the original read's (round 8, P1)", async () => {
    const repoId = store.db.prepare(
      `INSERT INTO docgraph_repos (root_path, last_indexed_at) VALUES (?, ?)`
    ).run("/fictional/rename-test", new Date().toISOString()).lastInsertRowid;
    const docId = store.db.prepare(
      `INSERT INTO docgraph_documents (repo_id, rel_path, mime, size, sha256, title)
       VALUES (?, 'old-name.md', 'text/markdown', 10, 'rename-stable-sha', 'Rename Doc')`
    ).run(repoId).lastInsertRowid;
    store.db.prepare(`INSERT INTO docgraph_sections (document_id, ord, level, heading, text) VALUES (?, 0, 1, NULL, ?)`)
      .run(docId, "Content that never changes, Amount Due: 12.00 BGN on 01.07.2026.");

    const sessionId = "rename-session";
    await backend.batch(store, {
      candidates: [{ id: Number(docId), rel_path: "old-name.md", size: 10, sha256: "rename-stable-sha" }],
      sessionId,
    });

    // The file is renamed on disk and re-indexed — the row keeps its id and
    // sha256; only rel_path changes. The model's next doc_batch call still
    // carries the OLD manifest row (stale rel_path).
    store.db.prepare(`UPDATE docgraph_documents SET rel_path = 'new-name.md' WHERE id = ?`).run(docId);

    const renamed = await backend.batch(store, {
      candidates: [{ id: Number(docId), rel_path: "old-name.md", size: 10, sha256: "rename-stable-sha" }],
      sessionId,
    });
    const doc = renamed.documents[0];
    assert.equal(doc.dedup, true, "same id + same content still dedups");
    assert.equal(doc.rel_path, "new-name.md",
      "the trust lookup refreshes identity from the CURRENT row — a dedup hit never returns the original read's stale path");
  });

  test("doc_batch reads a manifest in one bounded call with coverage", async () => {
    const manifest = await backend.manifest(store, { query: "budget invoices" });
    const result = await backend.batch(store, { candidates: manifest.candidates, batch_size: 6 });
    assert.equal(result.coverage.found, manifest.candidates.length);
    assert.equal(result.coverage.read, manifest.candidates.length);
    assert.equal(result.coverage.skipped, 0);
    assert.equal(result.coverage.complete, true);
    assert.ok(result.documents.every(d => d.status === "read" && d.text.length > 0));
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

  test("partial-word (prefix) search matches whole words (the 'introduc' → 'introduction' case)", async () => {
    // A typed-ahead prefix of a word must still hit it — the bug where "introduc"
    // returned only unrelated vector noise. "marke" is a prefix of "marketing".
    const { matches } = await backend.search(
      store, { query: "marke" }, { generateEmbedding: fakeEmbed, vectorEnabled: () => false }
    );
    assert.ok(matches.length > 0, "prefix 'marke' should match the 'Marketing' chunk");
    assert.equal(matches[0].document.rel_path, "budget.md");
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

  test("hybrid is lexical-authoritative — no vector-only noise when text matches", async () => {
    // fakeEmbed is a hash, so the vector NN for "marketing" is essentially
    // arbitrary. "marketing" only appears in budget.md, so EVERY hit must come
    // from budget.md — a vector-only chunk from notes.md must not leak in.
    const { matches, mode } = await backend.search(
      store, { query: "marketing" }, { generateEmbedding: fakeEmbed, vectorEnabled: () => true }
    );
    assert.equal(mode, "hybrid");
    assert.ok(matches.length > 0, "hybrid returned hits");
    assert.ok(matches.every((m) => m.document.rel_path === "budget.md"),
      "only lexical hits are returned, no vector noise from other docs");
    assert.match(matches[0].snippet, /marketing/i, "top snippet shows the matched term");
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
