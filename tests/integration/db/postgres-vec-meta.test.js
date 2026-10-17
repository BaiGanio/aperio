// tests/integration/db/postgres-vec-meta.test.js
//
// Postgres half of issue #287 WS1. tests/integration/embeddings/reindex.test.js
// covers the state machine and driver in depth, but only against SQLite — and
// the two backends implement vec_meta, per-store clearing, and the reindex
// scans in completely separate SQL. Backend drift here is silent: a Postgres
// deployment would keep serving vector search over stale vectors while every
// SQLite test stayed green.
//
// Runs only when APERIO_E2E_POSTGRES_URL is set (CI's pgvector service sets
// it). Provisions its own throwaway database, like postgres-vector-dims.test.js
// and for the same reason: clearing embeddings is destructive and the shared
// contract database is written by parallel workers.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const PG_URL = process.env.APERIO_E2E_POSTGRES_URL;
const PROBE_DB = `aperio_vecmeta_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

function fakeVector(dims = 1024) {
  return Array.from({ length: dims }, (_, i) => (i % 7) / 10);
}

describe("PostgresStore vec_meta + reindex (live pgvector)", { skip: PG_URL ? false : "APERIO_E2E_POSTGRES_URL not set" }, () => {
  let admin;
  let pool;
  let store;
  let oldUrl;
  let oldProvider;
  let vecMeta;
  let reindex;
  let embeddings;

  before(async () => {
    admin = new pg.Pool({ connectionString: PG_URL });
    await admin.query(`CREATE DATABASE ${PROBE_DB}`);

    const probeUrl = new URL(PG_URL);
    probeUrl.pathname = `/${PROBE_DB}`;
    pool = new pg.Pool({ connectionString: probeUrl.toString() });

    oldUrl = process.env.DATABASE_URL;
    oldProvider = process.env.EMBEDDING_PROVIDER;
    process.env.DATABASE_URL = probeUrl.toString();
    process.env.EMBEDDING_PROVIDER = "transformers";

    const { PostgresStore } = await import("../../../db/postgres.js");
    store = await PostgresStore.init();

    vecMeta = await import("../../../lib/helpers/vecMeta.js");
    reindex = await import("../../../lib/embeddings/reindex.js");
    embeddings = await import("../../../lib/helpers/embeddings.js");
  });

  after(async () => {
    await store?.pool?.end?.();
    await pool?.end?.();
    if (oldUrl) process.env.DATABASE_URL = oldUrl; else delete process.env.DATABASE_URL;
    if (oldProvider) process.env.EMBEDDING_PROVIDER = oldProvider; else delete process.env.EMBEDDING_PROVIDER;

    if (admin) {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [PROBE_DB]
      );
      await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
      await admin.end();
    }
  });

  test("migration 013 creates vec_meta with the status constraint enforced", async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'vec_meta' ORDER BY column_name`
    );
    assert.deepEqual(rows.map(r => r.column_name),
      ["dims", "reindex_expires_at", "reindex_owner", "signature", "status", "store_name", "updated_at", "vectors_cleared"]);

    await pool.query(
      `INSERT INTO vec_meta (store_name, signature, dims) VALUES ('tmp_probe', 'sig', 1024)`
    );
    // The CHECK is what stops a typo from parking a store in a status nothing
    // recognizes — which would read as "not current" and disable search forever.
    await assert.rejects(
      () => pool.query(`UPDATE vec_meta SET status = 'bogus' WHERE store_name = 'tmp_probe'`),
      /violates check constraint/
    );
    await pool.query(`DELETE FROM vec_meta WHERE store_name = 'tmp_probe'`);
  });

  test("seeding creates one row per store and is idempotent", async () => {
    const sig = vecMeta.signatureString(embeddings.getEmbeddingSignature());
    await vecMeta.ensureVecMeta(store, { signature: sig, dims: 1024 });
    let rows = await store.listVecMeta();
    assert.deepEqual(rows.map(r => r.store_name).sort(), [...vecMeta.VECTOR_STORES].sort());

    await store.updateVecMeta("memories", { status: vecMeta.VEC_STATUS.REINDEXING });
    await vecMeta.ensureVecMeta(store, { signature: "other:sig:1024", dims: 1024 });
    rows = await store.listVecMeta();
    assert.equal(rows.length, 5, "re-seeding must not duplicate rows");
    assert.equal((await store.getVecMeta("memories")).status, vecMeta.VEC_STATUS.REINDEXING);

    await store.updateVecMeta("memories", { status: vecMeta.VEC_STATUS.CURRENT });
  });

  test("updateVecMeta writes only the keys it is given", async () => {
    const before = await store.getVecMeta("wiki");
    await store.updateVecMeta("wiki", { status: vecMeta.VEC_STATUS.STALE });
    const after = await store.getVecMeta("wiki");
    assert.equal(after.status, vecMeta.VEC_STATUS.STALE);
    assert.equal(after.signature, before.signature, "signature must survive a status-only update");
    assert.equal(after.dims, before.dims);
    await store.updateVecMeta("wiki", { status: vecMeta.VEC_STATUS.CURRENT });
  });

  test("clearStoreEmbeddings is scoped to one store", async () => {
    const mem = await store.insert({ type: "fact", title: "pg probe", content: "body" }, fakeVector());
    await store.pool.query(`UPDATE wiki_articles SET embedding = $1 WHERE embedding IS NULL`, [`[${fakeVector().join(",")}]`]);

    const wikiEmbedded = async () =>
      (await pool.query(`SELECT COUNT(*)::int AS n FROM wiki_articles WHERE embedding IS NOT NULL`)).rows[0].n;
    const before = await wikiEmbedded();
    assert.ok(before > 0, "seeded wiki rows should have embeddings for this test to mean anything");

    await store.clearStoreEmbeddings("memories");

    assert.equal(
      (await pool.query(`SELECT embedding FROM memories WHERE id = $1`, [mem.id])).rows[0].embedding,
      null
    );
    assert.equal(await wikiEmbedded(), before, "clearing memories must not touch wiki");

    await assert.rejects(() => store.clearStoreEmbeddings("nope"), /unknown store/);
  });

  test("a provider change marks every store stale without deleting vectors", async () => {
    const mem = await store.insert({ type: "fact", title: "kept", content: "body" }, fakeVector());
    await embeddings.checkEmbeddingProvider(store);
    for (const r of await store.listVecMeta()) {
      assert.equal(r.status, vecMeta.VEC_STATUS.CURRENT, `${r.store_name} should start current`);
    }

    process.env.EMBEDDING_PROVIDER = "voyage";
    try {
      await embeddings.checkEmbeddingProvider(store);

      for (const r of await store.listVecMeta()) {
        assert.equal(r.status, vecMeta.VEC_STATUS.STALE, `${r.store_name} should be stale`);
        assert.equal(r.signature, "voyage:voyage-3:1024");
      }
      assert.equal(await vecMeta.isVectorSearchable(store, "memories"), false);

      // Mark stale, not delete.
      const { rows } = await pool.query(`SELECT embedding IS NOT NULL AS has FROM memories WHERE id = $1`, [mem.id]);
      assert.equal(rows[0].has, true, "detection must not destroy vectors");
    } finally {
      process.env.EMBEDDING_PROVIDER = "transformers";
    }
  });

  test("the reindex driver clears, re-embeds and restores vector search", async () => {
    // Everything is stale from the previous test; drive memories back to current.
    await embeddings.checkEmbeddingProvider(store);

    let calls = 0;
    const embedder = async () => { calls++; return fakeVector(); };

    const sig = vecMeta.signatureString(embeddings.getEmbeddingSignature());
    const { results } = await reindex.runReindex(store, {
      generateEmbedding: embedder,
      signature: sig,
      dims: 1024,
      stores: ["memories"],
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].completed, true, "memories should have completed");
    assert.ok(calls > 0, "rows should actually have been embedded");
    assert.equal((await store.getVecMeta("memories")).status, vecMeta.VEC_STATUS.CURRENT);
    assert.equal(await vecMeta.isVectorSearchable(store, "memories"), true);

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM memories WHERE embedding IS NULL`);
    assert.equal(rows[0].n, 0, "every memory should carry a vector again");
  });

  test("an interrupted reindex resumes without re-embedding finished rows", async () => {
    // The claim binds to the caller's own signature argument (issue #287
    // review follow-up), so the row must already carry the target this test
    // reindexes toward — exactly what checkEmbeddingProvider() does for every
    // real caller via markStaleWhereChanged() before invoking runReindex().
    await store.updateVecMeta("memories", { status: vecMeta.VEC_STATUS.STALE, signature: "x" });

    const total = (await store.listWithoutEmbeddings()).length
      + (await pool.query(`SELECT COUNT(*)::int AS n FROM memories WHERE embedding IS NOT NULL`)).rows[0].n;

    const controller = new AbortController();
    let first = 0;
    await reindex.runReindex(store, {
      generateEmbedding: async () => { first++; if (first >= 2) controller.abort(); return fakeVector(); },
      signature: "x", dims: 1024, stores: ["memories"], signal: controller.signal,
    });
    assert.equal((await store.getVecMeta("memories")).status, vecMeta.VEC_STATUS.REINDEXING);

    let second = 0;
    await reindex.runReindex(store, {
      generateEmbedding: async () => { second++; return fakeVector(); },
      signature: "x", dims: 1024, stores: ["memories"],
    });

    assert.equal(first + second, total, "each row must be embedded exactly once across the interruption");
    assert.equal((await store.getVecMeta("memories")).status, vecMeta.VEC_STATUS.CURRENT);
  });

  test("claiming a store is atomic — only one runner wins", async () => {
    await store.updateVecMeta("memories", { status: vecMeta.VEC_STATUS.STALE });

    const first = await store.claimVecMetaReindex("memories", "runner-a", 60000);
    assert.equal(first.claimed, true);
    assert.equal(first.previousStatus, vecMeta.VEC_STATUS.STALE, "the claim must report the pre-claim status");

    const second = await store.claimVecMetaReindex("memories", "runner-b", 60000);
    assert.equal(second.claimed, false, "a live lease must block a second runner");

    // Same runner re-entering (a resumed run) is allowed.
    assert.equal((await store.claimVecMetaReindex("memories", "runner-a", 60000)).claimed, true);
  });

  test("concurrent claims resolve to exactly one winner", async () => {
    await store.updateVecMeta("memories", {
      status: vecMeta.VEC_STATUS.STALE, reindex_owner: null, reindex_expires_at: null,
    });
    // Fired together against the same row — the FOR UPDATE lock is what stops
    // both from seeing an unclaimed row and proceeding.
    const claims = await Promise.all(
      ["a", "b", "c", "d"].map(n => store.claimVecMetaReindex("memories", n, 60000))
    );
    assert.equal(claims.filter(c => c.claimed).length, 1, "exactly one runner may win the race");
  });

  test("an expired lease is reclaimable", async () => {
    await store.updateVecMeta("memories", {
      status: vecMeta.VEC_STATUS.STALE, reindex_owner: null, reindex_expires_at: null,
    });
    assert.equal((await store.claimVecMetaReindex("memories", "dead", -1000)).claimed, true);
    const taken = await store.claimVecMetaReindex("memories", "live", 60000);
    assert.equal(taken.claimed, true, "a crashed runner must not hold a store forever");
  });

  test("a current store cannot be claimed, and renew/release respect ownership", async () => {
    await store.updateVecMeta("memories", {
      status: vecMeta.VEC_STATUS.CURRENT, reindex_owner: null, reindex_expires_at: null,
    });
    assert.equal((await store.claimVecMetaReindex("memories", "x", 60000)).claimed, false);

    await store.updateVecMeta("memories", { status: vecMeta.VEC_STATUS.STALE });
    await store.claimVecMetaReindex("memories", "owner-1", 60000);
    assert.equal(await store.renewVecMetaLease("memories", "someone-else", 60000), false);
    assert.equal(await store.renewVecMetaLease("memories", "owner-1", 60000), true);
    assert.equal(await store.releaseVecMetaReindex("memories", "someone-else"), false);
    assert.equal(await store.releaseVecMetaReindex("memories", "owner-1"), true);
    assert.equal((await store.getVecMeta("memories")).reindex_owner, null);
  });

  test("a completed reindex leaves the store current and unclaimed", async () => {
    // See the note above: the claim binds to `signature`, so the row must
    // already be marked toward "sig" for this call to be able to claim it.
    await store.updateVecMeta("memories", { status: vecMeta.VEC_STATUS.STALE, signature: "sig" });
    await reindex.runReindex(store, {
      generateEmbedding: async () => fakeVector(),
      signature: "sig", dims: 1024, stores: ["memories"], owner: "finisher",
    });
    const row = await store.getVecMeta("memories");
    assert.equal(row.status, vecMeta.VEC_STATUS.CURRENT);
    assert.equal(row.reindex_owner, null);
  });
});
