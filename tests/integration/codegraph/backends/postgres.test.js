// tests/integration/codegraph/backends/postgres.test.js
//
// Postgres side of the codegraph backend contract (issue #283). Until now only
// the SQLite backend had a test, so the graph-intelligence read/write API could
// drift on the Postgres side without CI noticing — the same silent-drift class
// the migration lockstep guards at the schema level.
//
// Two layers:
//   1. Contract parity — both backends must export the same function surface,
//      and the behaviours a caller depends on (repo resolution errors, stale
//      analysis rejection, unresolved-edge exclusion) must match. The SQLite
//      side runs against a REAL migrated in-memory store; the Postgres side
//      runs against a mock pool, following the docgraph backend convention.
//   2. Postgres specifics — SQL shape, parameter binding, transaction and
//      client-release lifecycle for persistAnalysis.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

let pg, lite, store;
let oldPath, oldDims;

// ── Mock pool ───────────────────────────────────────────────────────────────
// `rowsFn(sql, params)` decides the rows for each query. Every statement is
// recorded so tests can assert transaction order and client lifecycle.

function makeStore(rowsFn = () => []) {
  const calls = [];
  const released = [];
  const run = async (sql, params) => {
    calls.push({ sql, params });
    const rows = (await rowsFn(sql, params)) ?? [];
    return { rows, rowCount: rows.length };
  };
  const pool = {
    query: run,
    connect: async () => ({
      query: run,
      release: () => released.push(Date.now()),
    }),
  };
  return { pool, _calls: calls, _released: released, _sql: () => calls.map(c => c.sql).join(" ") };
}

const sqlOf = (store, re) => store._calls.filter(c => re.test(c.sql));

before(async () => {
  pg = await import("../../../../lib/codegraph/backends/postgres.js");
  lite = await import("../../../../lib/codegraph/backends/sqlite.js");

  oldPath = process.env.SQLITE_PATH;
  oldDims = process.env.EMBEDDING_DIMS;
  process.env.SQLITE_PATH = ":memory:";
  process.env.EMBEDDING_DIMS = "1024";
  const { SqliteStore } = await import("../../../../db/sqlite.js");
  store = await SqliteStore.init();

  // Two files in one repo: util.js is imported by a.js, and a.js has one
  // resolved call edge plus one unresolved (dst NULL) extractor edge.
  const db = store.db;
  db.exec(`
    INSERT INTO cg_repos (id, root_path) VALUES (1, '/tmp/parity-repo');
    INSERT INTO cg_repos (id, root_path) VALUES (2, '/tmp/other-repo');
    INSERT INTO cg_files (id, repo_id, path, language, sha256, mtime)
      VALUES (1, 1, 'a.js', 'js', 'sha-a', '2026-07-24T00:00:00Z'),
             (2, 1, 'util.js', 'js', 'sha-u', '2026-07-24T00:00:00Z');
    INSERT INTO cg_symbols (id, file_id, kind, name, qualified, start_line, end_line)
      VALUES (1, 1, 'function', 'foo', 'a.js::foo', 1, 3),
             (2, 2, 'function', 'helper', 'util.js::helper', 1, 2),
             (3, 1, 'file', 'a.js', 'a.js', 1, 1);
    INSERT INTO cg_edges (src_symbol_id, dst_symbol_id, kind, confidence, confidence_score)
      VALUES (1, 2, 'calls', 'INFERRED', 0.8),
             (1, NULL, 'calls', 'EXTRACTED', 1.0);
  `);
});

after(async () => {
  await store?.close?.().catch(() => {});
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  if (oldDims) process.env.EMBEDDING_DIMS = oldDims; else delete process.env.EMBEDDING_DIMS;
});

// =============================================================================
// 1. Contract parity
// =============================================================================

describe("backend contract parity", () => {
  test("both backends export the same function surface", () => {
    const fns = (mod) => Object.keys(mod).filter(k => typeof mod[k] === "function").sort();
    assert.deepEqual(fns(pg), fns(lite), "codegraph backend exports drifted between SQLite and Postgres");
  });

  test("shared functions accept the same required arguments", () => {
    const drift = Object.keys(pg)
      .filter(k => typeof pg[k] === "function" && typeof lite[k] === "function")
      .filter(k => pg[k].length !== lite[k].length)
      .map(k => `${k}: pg=${pg[k].length} sqlite=${lite[k].length}`);
    assert.deepEqual(drift, [], `arity drift between backends: ${drift.join(", ")}`);
  });

  test("the graph-intelligence API added by #283 exists on both backends", () => {
    for (const fn of [
      "loadGraph", "readRevisions", "persistAnalysis", "readCommunities",
      "readHotspots", "readBridges", "readMetricsMap", "analysisSummary",
      "resolveRepoId", "findReposForSymbol",
    ]) {
      assert.equal(typeof pg[fn], "function", `postgres backend is missing ${fn}`);
      assert.equal(typeof lite[fn], "function", `sqlite backend is missing ${fn}`);
    }
  });
});

describe("repo resolution parity", () => {
  test("a null repo resolves to null on both backends without querying", async () => {
    const mock = makeStore();
    assert.equal(await pg.resolveRepoId(mock, null), null);
    assert.equal(await lite.resolveRepoId(store, null), null);
    assert.equal(mock._calls.length, 0, "no query should be issued for an absent repo filter");
  });

  test("an unmatched repo raises the same userFacing error on both backends", async () => {
    const mock = makeStore(() => []);
    const fromPg = await pg.resolveRepoId(mock, "nope").catch(e => e);
    const fromLite = await lite.resolveRepoId(store, "nope").catch(e => e);
    assert.equal(fromPg.message, fromLite.message);
    assert.equal(fromPg.message, "No indexed repo matches 'nope'.");
    assert.ok(fromPg.userFacing && fromLite.userFacing, "both must be userFacing");
  });

  test("an ambiguous repo raises the same userFacing error on both backends", async () => {
    // Postgres: exact match misses, then the ILIKE scan returns both repos.
    const mock = makeStore((sql) =>
      /root_path = /.test(sql) ? [] : [{ id: 1, root_path: "/tmp/parity-repo" }, { id: 2, root_path: "/tmp/other-repo" }]
    );
    const fromPg = await pg.resolveRepoId(mock, "repo").catch(e => e);
    const fromLite = await lite.resolveRepoId(store, "repo").catch(e => e);

    // Neither backend orders the candidate list, so compare the message
    // template and the matched set rather than the row order.
    const parse = (msg) => {
      const m = msg.match(/^Ambiguous repo '(.+)' — matches: (.+)$/);
      assert.ok(m, `unexpected ambiguity message: ${msg}`);
      return { repo: m[1], matches: m[2].split(", ").sort() };
    };
    assert.deepEqual(parse(fromPg.message), parse(fromLite.message));
    assert.deepEqual(parse(fromPg.message), { repo: "repo", matches: ["/tmp/other-repo", "/tmp/parity-repo"] });
    assert.ok(fromPg.userFacing && fromLite.userFacing, "both must be userFacing");
  });

  test("an exact root_path wins over a substring sibling on both backends", async () => {
    const mock = makeStore((sql) => /root_path = /.test(sql) ? [{ id: 1, root_path: "/tmp/parity-repo" }] : []);
    assert.equal(await pg.resolveRepoId(mock, "/tmp/parity-repo"), 1);
    assert.equal(await lite.resolveRepoId(store, "/tmp/parity-repo"), 1);
  });
});

describe("loadGraph parity", () => {
  test("SQLite returns resolved edges only, with the repo basename attached", async () => {
    const graph = await lite.loadGraph(store, 1);
    assert.equal(graph.nodes.length, 3);
    assert.ok(graph.nodes.every(n => n.repo === "parity-repo"), "every node carries the repo basename");
    assert.equal(graph.edges.length, 1, "the dst NULL edge must not reach traversal or analysis");
    assert.deepEqual(
      { src: graph.edges[0].src, dst: graph.edges[0].dst, kind: graph.edges[0].kind },
      { src: 1, dst: 2, kind: "calls" }
    );
    assert.equal(graph.edges[0].confidence, "INFERRED");
    assert.equal(graph.edges[0].confidence_score, 0.8);
  });

  test("Postgres shapes the same result and excludes unresolved edges in SQL", async () => {
    const mock = makeStore((sql) => /FROM cg_symbols s/.test(sql) && /root_path/.test(sql)
      ? [{ id: 1, qualified: "a.js::foo", kind: "function", name: "foo", path: "a.js", root_path: "/tmp/parity-repo" }]
      : [{ src: 1, dst: 2, kind: "calls", confidence: "INFERRED", confidence_score: 0.8, relation_context: null }]
    );
    const graph = await pg.loadGraph(mock, 1);
    assert.equal(graph.nodes[0].repo, "parity-repo", "postgres must derive the same repo basename");
    assert.equal(graph.edges[0].confidence, "INFERRED");

    const edgeQuery = sqlOf(mock, /FROM cg_edges/)[0];
    assert.ok(edgeQuery, "an edge query was issued");
    assert.match(edgeQuery.sql, /dst_symbol_id IS NOT NULL/, "unresolved edges must be excluded in SQL");
    assert.match(edgeQuery.sql, /e\.confidence/, "confidence must be selected for the traversal layer");
    assert.deepEqual(edgeQuery.params, [1], "the repo id is bound, not interpolated");
  });
});

// =============================================================================
// 2. Postgres analysis persistence
// =============================================================================

describe("postgres readRevisions", () => {
  test("returns the revision pointer row", async () => {
    const mock = makeStore(() => [{ graph_revision: 7, analyzed_revision: 5, analyzed_at: "2026-07-24T00:00:00Z" }]);
    assert.deepEqual(await pg.readRevisions(mock, 1), {
      graph_revision: 7, analyzed_revision: 5, analyzed_at: "2026-07-24T00:00:00Z",
    });
    assert.deepEqual(mock._calls[0].params, [1]);
  });

  test("returns null for an unknown repo rather than undefined", async () => {
    assert.equal(await pg.readRevisions(makeStore(() => []), 99), null);
  });
});

describe("postgres persistAnalysis", () => {
  const snapshot = {
    communities: [{ community_id: 0, label: "core", size: 2, cohesion: 0.5 }],
    metrics: [{ symbol_id: 1, community_id: 0, degree: 3, hotspot_score: 3, bridge_score: 0 }],
  };

  test("commits when the graph revision still matches", async () => {
    const mock = makeStore((sql) => /graph_revision AS r/.test(sql) ? [{ r: 7 }] : []);
    assert.equal(await pg.persistAnalysis(mock, 1, 7, snapshot), true);

    const sql = mock._sql();
    assert.match(sql, /BEGIN/);
    assert.match(sql, /FOR UPDATE/, "the revision check must lock the row against a concurrent writer");
    assert.match(sql, /DELETE FROM cg_communities/);
    assert.match(sql, /DELETE FROM cg_symbol_metrics/);
    assert.match(sql, /INSERT INTO cg_communities/);
    assert.match(sql, /INSERT INTO cg_symbol_metrics/);
    assert.match(sql, /UPDATE cg_repos SET analyzed_revision/);
    assert.match(sql, /COMMIT/);
    assert.equal(mock._released.length, 1, "the pooled client must be released");
  });

  test("rejects and rolls back when a newer revision won the race", async () => {
    const mock = makeStore((sql) => /graph_revision AS r/.test(sql) ? [{ r: 9 }] : []);
    assert.equal(await pg.persistAnalysis(mock, 1, 7, snapshot), false);

    const sql = mock._sql();
    assert.match(sql, /ROLLBACK/);
    assert.ok(!/DELETE FROM cg_communities/.test(sql), "a stale snapshot must not wipe the current one");
    assert.ok(!/INSERT INTO/.test(sql), "a stale snapshot must not be written");
    assert.equal(mock._released.length, 1, "the pooled client must be released on the reject path too");
  });

  test("rejects when the repo disappeared mid-analysis", async () => {
    const mock = makeStore(() => []);
    assert.equal(await pg.persistAnalysis(mock, 1, 7, snapshot), false);
    assert.match(mock._sql(), /ROLLBACK/);
    assert.equal(mock._released.length, 1);
  });

  test("rolls back, rethrows, and still releases the client on a write error", async () => {
    const mock = makeStore((sql) => {
      if (/graph_revision AS r/.test(sql)) return [{ r: 7 }];
      if (/INSERT INTO cg_communities/.test(sql)) throw new Error("constraint violation");
      return [];
    });
    await assert.rejects(() => pg.persistAnalysis(mock, 1, 7, snapshot), /constraint violation/);
    assert.match(mock._sql(), /ROLLBACK/);
    assert.equal(mock._released.length, 1, "a thrown write must not leak the pooled client");
  });

  test("SQLite rejects a stale revision the same way, without writing", async () => {
    // Real store: graph_revision is 0 for the seeded repo, so revision 7 is stale.
    assert.equal(await lite.persistAnalysis(store, 1, 7, snapshot), false);
    const written = store.db.prepare(`SELECT COUNT(*) AS n FROM cg_communities WHERE repo_id = 1`).get().n;
    assert.equal(written, 0, "a stale snapshot must not be persisted on SQLite either");
  });

  test("SQLite commits on a matching revision and stamps the analysis pointer", async () => {
    const current = store.db.prepare(`SELECT graph_revision AS r FROM cg_repos WHERE id = 1`).get().r;
    assert.equal(await lite.persistAnalysis(store, 1, current, snapshot), true);
    const row = store.db.prepare(`SELECT analyzed_revision, analyzed_at FROM cg_repos WHERE id = 1`).get();
    assert.equal(row.analyzed_revision, current);
    assert.ok(row.analyzed_at, "analyzed_at must be stamped so warm reads can trust the snapshot");
  });
});

describe("postgres analysis reads", () => {
  test("communities are ordered by size and bounded by limit", async () => {
    const mock = makeStore(() => [{ community_id: 0, label: "core", size: 9, cohesion: 0.4 }]);
    const rows = await pg.readCommunities(mock, 1, 5);
    assert.equal(rows.length, 1);
    assert.match(mock._calls[0].sql, /ORDER BY size DESC, community_id ASC/);
    assert.deepEqual(mock._calls[0].params, [1, 5], "limit must be bound, not interpolated");
  });

  test("hotspots skip unscored rows and tie-break deterministically", async () => {
    const mock = makeStore(() => [{ qualified: "a.js::foo", name: "foo", kind: "function", path: "a.js", degree: 4, hotspot_score: 4, community_id: 0 }]);
    await pg.readHotspots(mock, 1, 10);
    assert.match(mock._calls[0].sql, /hotspot_score IS NOT NULL/);
    assert.match(mock._calls[0].sql, /ORDER BY m\.hotspot_score DESC, s\.qualified ASC/);
    assert.deepEqual(mock._calls[0].params, [1, 10]);
  });

  test("bridges exclude non-bridging symbols", async () => {
    const mock = makeStore(() => []);
    await pg.readBridges(mock, 1, 10);
    assert.match(mock._calls[0].sql, /bridge_score > 0/);
    assert.match(mock._calls[0].sql, /ORDER BY m\.bridge_score DESC, s\.qualified ASC/);
  });

  test("readMetricsMap keys by symbol_id for the /graph overlay", async () => {
    const mock = makeStore(() => [
      { symbol_id: 1, community_id: 0, degree: 3, hotspot_score: 3, bridge_score: 0 },
      { symbol_id: 2, community_id: 1, degree: 1, hotspot_score: 1, bridge_score: 0 },
    ]);
    const map = await pg.readMetricsMap(mock, 1);
    assert.ok(map instanceof Map);
    assert.equal(map.size, 2);
    assert.equal(map.get(1).community_id, 0);
    assert.equal(map.get(2).degree, 1);
  });

  test("analysisSummary counts symbols, resolved edges, and communities", async () => {
    const counts = { cg_symbols: 12, cg_edges: 20, cg_communities: 3 };
    const mock = makeStore((sql) => {
      if (/FROM cg_edges/.test(sql)) return [{ n: counts.cg_edges }];
      if (/FROM cg_communities/.test(sql)) return [{ n: counts.cg_communities }];
      return [{ n: counts.cg_symbols }];
    });
    assert.deepEqual(await pg.analysisSummary(mock, 1), { symbols: 12, edges: 20, communities: 3 });
    assert.match(sqlOf(mock, /FROM cg_edges/)[0].sql, /dst_symbol_id IS NOT NULL/, "summary counts resolved edges only");
  });
});

describe("findReposForSymbol parity", () => {
  test("SQLite returns the distinct repo ids holding a qualified symbol", async () => {
    assert.deepEqual(await lite.findReposForSymbol(store, "a.js::foo"), [1]);
    assert.deepEqual(await lite.findReposForSymbol(store, "nothing::here"), []);
  });

  test("Postgres returns the same shape — a plain array of ids", async () => {
    const mock = makeStore(() => [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(await pg.findReposForSymbol(mock, "a.js::foo"), [1, 2]);
    assert.deepEqual(mock._calls[0].params, ["a.js::foo"]);
  });
});
