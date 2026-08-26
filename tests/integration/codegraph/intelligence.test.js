// tests/integration/codegraph/intelligence.test.js
//
// Step 2 (issue #283) contract against a REAL SqliteStore — this applies
// db/migrations-sqlite/010_codegraph_intelligence.sql, so it also validates the
// migration DDL end to end: synthetic file symbols, persisted import edges,
// confidence policy, graph revisioning, and schema-version rebuild.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { installMemfs } from "../../helpers/memfs.js";

// lib/codegraph/indexer.js's walk() yields repo-relative paths in the HOST's
// separator (path.relative), and the import resolver does path.join math on
// them — so on Windows the whole graph is keyed "pkg\\a.js", self-consistently.
// Fixtures and assertions here stay POSIX: nat() spells a POSIX fixture the way
// the walker would on this platform, pos() folds a stored key back for
// comparison. Two helpers at the boundary, no platform branch at any assertion.
const nat = (p) => p.split("/").join(sep);
const pos = (p) => p.replaceAll("\\", "/");

const mem = installMemfs({ root: "/mem/cg" });
let backend, extractTs;
let repoDir, oldPath, oldDims, store;

async function* filesOf(root, rels) {
  for (const rel of rels) {
    yield { abs: join(root, rel), rel: nat(rel), ext: { fn: extractTs, lang: "js" } };
  }
}

const REL = ["pkg/a.js", "pkg/b.js", "pkg/util.js"];

function seedFixture() {
  mem.mkdirp(join(repoDir, "pkg"));
  mem.writeFile(join(repoDir, "pkg/a.js"), [
    "import { bar } from './b.js';",
    "import express from 'express';",
    "export function foo() { return bar(); }",
  ].join("\n"));
  mem.writeFile(join(repoDir, "pkg/b.js"), [
    "import { helper } from './util.js';",
    "export function bar() { return helper(); }",
  ].join("\n"));
  mem.writeFile(join(repoDir, "pkg/util.js"), [
    "export function helper() { return 1; }",
  ].join("\n"));
}

let handlers, analysisService;

before(async () => {
  backend = await import("../../../lib/codegraph/backends/sqlite.js");
  ({ extract: extractTs } = await import("../../../lib/codegraph/extract-ts.js"));
  handlers = await import("../../../lib/handlers/codegraph/codegraphHandlers.js");
  analysisService = await import("../../../lib/codegraph/analysisService.js");

  oldPath = process.env.SQLITE_PATH;
  oldDims = process.env.EMBEDDING_DIMS;
  process.env.SQLITE_PATH = ":memory:";
  process.env.EMBEDDING_DIMS = "1024";

  repoDir = join(mem.root, "repo");
  seedFixture();

  const { SqliteStore } = await import("../../../db/sqlite.js");
  store = await SqliteStore.init();
});

after(async () => {
  await store?.close?.().catch(() => {});
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  if (oldDims) process.env.EMBEDDING_DIMS = oldDims; else delete process.env.EMBEDDING_DIMS;
  mem.restore();
});

const idxOnce = () => backend.indexRepoFiles(store, repoDir, filesOf(repoDir, REL), { generateEmbedding: async () => null });

describe("codegraph intelligence — file nodes, confidence, revision", () => {
  test("indexing creates one synthetic file symbol per file", async () => {
    await idxOnce();
    const files = store.db.prepare(
      `SELECT qualified, name, kind FROM cg_symbols WHERE kind = 'file' ORDER BY qualified`
    ).all();
    assert.deepEqual(files.map(f => pos(f.qualified)), ["pkg/a.js", "pkg/b.js", "pkg/util.js"]);
    assert.deepEqual(files.map(f => f.name), ["a.js", "b.js", "util.js"]);
  });

  test("relative imports persist as directed edges between file symbols", async () => {
    // a.js → b.js
    const edge = store.db.prepare(`
      SELECT dst.qualified AS dst, e.confidence, e.provenance
        FROM cg_edges e
        JOIN cg_symbols src ON src.id = e.src_symbol_id
        JOIN cg_symbols dst ON dst.id = e.dst_symbol_id
       WHERE e.kind = 'imports' AND src.qualified = ? AND dst.kind = 'file'
    `).all(nat("pkg/a.js"));
    assert.ok(edge.some(r => pos(r.dst) === "pkg/b.js"), "a.js should import b.js");
    const ab = edge.find(r => pos(r.dst) === "pkg/b.js");
    assert.equal(ab.confidence, "INFERRED");
    assert.equal(ab.provenance, "import-resolver");
  });

  test("a bare/package import stays unresolved and EXTRACTED (no fabrication)", async () => {
    const row = store.db.prepare(`
      SELECT e.dst_symbol_id, e.dst_unresolved, e.confidence, e.confidence_score
        FROM cg_edges e
        JOIN cg_symbols src ON src.id = e.src_symbol_id
       WHERE e.kind = 'imports' AND src.qualified = ? AND e.dst_unresolved = 'express'
    `).get(nat("pkg/a.js"));
    assert.ok(row, "express import edge exists");
    assert.equal(row.dst_symbol_id, null);
    assert.equal(row.confidence, "EXTRACTED");
    assert.equal(row.confidence_score, 1.0);
  });

  test("a name-resolved call edge is INFERRED / 0.8", async () => {
    const row = store.db.prepare(`
      SELECT e.confidence, e.confidence_score, e.provenance
        FROM cg_edges e
        JOIN cg_symbols src ON src.id = e.src_symbol_id
        JOIN cg_symbols dst ON dst.id = e.dst_symbol_id
       WHERE e.kind = 'calls' AND src.name = 'foo' AND dst.name = 'bar'
    `).get();
    assert.ok(row, "foo → bar call edge resolved");
    assert.equal(row.confidence, "INFERRED");
    assert.equal(row.confidence_score, 0.8);
    assert.equal(row.provenance, "name-resolver");
  });

  test("graph_revision increments once per graph-changing index; no-op does not", async () => {
    const rev1 = store.db.prepare(`SELECT graph_revision AS r, index_schema_version AS v FROM cg_repos WHERE root_path = ?`).get(repoDir);
    assert.equal(rev1.r, 1);
    assert.equal(rev1.v, 1); // INDEX_SCHEMA_VERSION

    const noop = await idxOnce();
    assert.equal(noop.changed, 0, "unchanged reindex is a no-op");
    const rev2 = store.db.prepare(`SELECT graph_revision AS r FROM cg_repos WHERE root_path = ?`).get(repoDir);
    assert.equal(rev2.r, 1, "no-op reindex does not bump revision");
  });

  test("a schema-version bump forces a full rebuild of unchanged files", async () => {
    // Simulate an old repo: reset the stored version below INDEX_SCHEMA_VERSION.
    store.db.prepare(`UPDATE cg_repos SET index_schema_version = 0 WHERE root_path = ?`).run(repoDir);
    const rebuilt = await idxOnce();
    assert.ok(rebuilt.changed > 0, "unchanged hashes still rebuild after a version bump");
    const v = store.db.prepare(`SELECT index_schema_version AS v FROM cg_repos WHERE root_path = ?`).get(repoDir).v;
    assert.equal(v, 1, "rebuild restores the current schema version");
  });
});

describe("codegraph traversal handlers (neighbors, path)", () => {
  const ctx = () => ({ store, vectorEnabled: () => false, generateEmbedding: async () => null });
  const json = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text); };

  test("neighbors of a file node span imports in both directions", async () => {
    const r = json(await handlers.neighborsHandler(ctx(), { qualified: nat("pkg/b.js"), direction: "both", depth: 1 }));
    const quals = r.nodes.map(n => pos(n.qualified)).sort();
    assert.deepEqual(quals, ["pkg/a.js", "pkg/util.js"]); // a.js imports b.js; b.js imports util.js
    assert.equal(pos(r.seed.qualified), "pkg/b.js");
  });

  test("directed import path follows importer → imported", async () => {
    const r = json(await handlers.pathHandler(ctx(), { from: nat("pkg/a.js"), to: nat("pkg/util.js"), directed: true, kinds: ["imports"] }));
    assert.equal(r.found, true);
    assert.equal(r.hop_count, 2);
    assert.deepEqual(r.nodes.map(n => pos(n.qualified)), ["pkg/a.js", "pkg/b.js", "pkg/util.js"]);
  });

  test("directed path has no reverse route; undirected does", async () => {
    const directed = json(await handlers.pathHandler(ctx(), { from: nat("pkg/util.js"), to: nat("pkg/a.js"), directed: true }));
    assert.deepEqual(directed, { found: false });
    const undirected = json(await handlers.pathHandler(ctx(), { from: nat("pkg/util.js"), to: nat("pkg/a.js"), directed: false }));
    assert.equal(undirected.found, true);
    assert.equal(undirected.hop_count, 2);
  });

  test("unknown symbol surfaces a resolution error, not found:false", async () => {
    const r = await handlers.neighborsHandler(ctx(), { qualified: nat("pkg/nope.js") + "::ghost" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /No indexed symbol/);
  });
});

describe("codegraph insights — lazy analysis & invalidation", () => {
  const ctx = () => ({ store, vectorEnabled: () => false, generateEmbedding: async () => null });
  const json = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text); };

  test("first insights request analyzes; warm request reuses the snapshot", async () => {
    analysisService._resetComputeCount();
    const s1 = json(await handlers.insightsHandler(ctx(), { repo: repoDir, view: "summary" }));
    assert.equal(analysisService.analysisComputeCount(), 1, "first request computes");
    assert.ok(s1.summary.symbols > 0);
    assert.equal(typeof s1.analyzed_revision, "number");

    json(await handlers.insightsHandler(ctx(), { repo: repoDir, view: "communities" }));
    json(await handlers.insightsHandler(ctx(), { repo: repoDir, view: "hotspots" }));
    assert.equal(analysisService.analysisComputeCount(), 1, "warm reads reuse — no recomputation");
  });

  test("a graph-changing mutation invalidates the snapshot and forces recompute", async () => {
    const before = analysisService.analysisComputeCount();
    mem.writeFile(join(repoDir, "pkg/util.js"), "export function helper() { return 2; }\nexport function extra() { return helper(); }");
    const counts = await idxOnce();
    assert.ok(counts.changed > 0, "the mutated file reindexes");

    json(await handlers.insightsHandler(ctx(), { repo: repoDir, view: "summary" }));
    assert.equal(analysisService.analysisComputeCount(), before + 1, "stale snapshot recomputes exactly once");
  });

  test("unknown view is rejected before any work", async () => {
    const r = await handlers.insightsHandler(ctx(), { repo: repoDir, view: "nonsense" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Unknown view/);
  });

  test("graph payload is bounded and reports totals + truncation", async () => {
    const g = json(await handlers.graphHandler(ctx(), { repo: repoDir, limit: 2 }));
    assert.equal(g.returned_nodes, 2);
    assert.ok(g.total_nodes > 2);
    assert.equal(g.truncated, true);
    // No dangling edges: every edge endpoint is a returned node.
    const ids = new Set(g.nodes.map(n => n.id));
    for (const e of g.edges) { assert.ok(ids.has(e.src) && ids.has(e.dst)); }
  });
});
