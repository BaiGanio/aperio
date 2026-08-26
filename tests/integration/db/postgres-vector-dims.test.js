// tests/integration/db/postgres-vector-dims.test.js
//
// Live-Postgres verification of PostgresStore.getVectorDims() and
// resizeVectorStorage() (issue #287, WS0 Gap 4).
//
// Why this file exists: every other test for these two methods
// (tests/unit/db/postgres.test.js) mocks the pool, so it can only assert that
// the SQL *mentions* pg_attribute.atttypmod — never that atttypmod actually
// holds the raw vector dimension. That assumption came from pgvector's
// documented typmod handling and was carried unverified through four review
// passes. It is the kind of claim only a real server can settle: if pgvector
// encoded typmod the way varchar does (length + 4 header bytes),
// getVectorDims() would silently report 1028 for a vector(1024) column and
// checkEmbeddingProvider() would resize storage on every single boot.
//
// Runs only when APERIO_E2E_POSTGRES_URL is set — the same opt-in knob
// tests/integration/db/contract/backends.js uses, and which CI's
// pgvector/pgvector:pg16 service job sets. Unlike the contract suite, this
// file creates its OWN throwaway database on that server and drops it after:
// resizeVectorStorage() is destructive schema-wide DDL, and the contract
// suite's shared database is written concurrently by parallel test workers
// that would start failing mid-run if the embedding columns changed width
// underneath them.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const PG_URL = process.env.APERIO_E2E_POSTGRES_URL;

// Postgres identifiers can't be parameterized, so keep this to [a-z0-9_].
const PROBE_DB = `aperio_vecdims_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

const VECTOR_TABLES = [
  "cg_symbols",
  "docgraph_chunks",
  "memories",
  "self_memories",
  "wiki_articles",
];

const EMBEDDING_INDEXES = [
  "idx_cg_symbols_embedding",
  "idx_dc_embedding",
  "idx_memories_embedding",
  "idx_self_memories_embedding",
  "idx_wiki_embedding",
];

function vec(dims) {
  return `[${Array(dims).fill(0.01).join(",")}]`;
}

async function columnWidths(pool) {
  const { rows } = await pool.query(
    `SELECT c.relname, format_type(a.atttypid, a.atttypmod) AS formatted
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
      WHERE a.attname = 'embedding'
        AND NOT a.attisdropped
        AND c.relname = ANY($1)
      ORDER BY c.relname`,
    [VECTOR_TABLES]
  );
  return rows.map((r) => `${r.relname}=${r.formatted}`);
}

describe("PostgresStore vector dims (live pgvector)", { skip: PG_URL ? false : "APERIO_E2E_POSTGRES_URL not set" }, () => {
  let admin;
  let pool;
  let store;
  let oldUrl;

  before(async () => {
    // CREATE DATABASE can't run inside a transaction block, so it goes
    // through a plain connection to the server named by the opt-in URL.
    admin = new pg.Pool({ connectionString: PG_URL });
    await admin.query(`CREATE DATABASE ${PROBE_DB}`);

    const probeUrl = new URL(PG_URL);
    probeUrl.pathname = `/${PROBE_DB}`;

    pool = new pg.Pool({ connectionString: probeUrl.toString() });

    // Real migrations, not a hand-rolled fixture — the widths under test are
    // the ones the shipped schema actually declares.
    const { runMigrations } = await import("../../../db/migrate.js");
    await runMigrations(pool);

    oldUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = probeUrl.toString();
    const { PostgresStore } = await import("../../../db/postgres.js");
    store = await PostgresStore.init();
  });

  after(async () => {
    await store?.pool?.end?.();
    await pool?.end?.();
    if (oldUrl) process.env.DATABASE_URL = oldUrl;
    else delete process.env.DATABASE_URL;

    if (admin) {
      // Any lingering session blocks DROP DATABASE.
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [PROBE_DB]
      );
      await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
      await admin.end();
    }
  });

  test("atttypmod holds the raw vector dimension, not a varchar-style length+4", async () => {
    const { rows } = await pool.query(`
      SELECT a.atttypmod, format_type(a.atttypid, a.atttypmod) AS formatted
        FROM pg_attribute a
       WHERE a.attrelid = 'memories'::regclass
         AND a.attname = 'embedding'
         AND NOT a.attisdropped
    `);
    // The whole premise of getVectorDims(). 1028 here would mean pgvector
    // stuffs a header into typmod and every boot would trigger a resize.
    assert.equal(rows[0].atttypmod, 1024);
    assert.equal(rows[0].formatted, "vector(1024)");
  });

  test("getVectorDims() reports the migrated width on a fresh database", async () => {
    assert.equal(await store.getVectorDims(), 1024);
  });

  test("resizeVectorStorage() re-types all five embedding columns", async () => {
    await store.resizeVectorStorage(768);
    assert.equal(await store.getVectorDims(), 768);
    assert.deepEqual(
      await columnWidths(pool),
      VECTOR_TABLES.map((t) => `${t}=vector(768)`)
    );
  });

  test("the dependent view survives the ALTER it would otherwise block", async () => {
    // memories_without_embeddings reads memories.embedding; Postgres refuses
    // to ALTER a column a view depends on, so resizeVectorStorage() drops and
    // recreates it inside its transaction.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_views WHERE viewname = 'memories_without_embeddings'`
    );
    assert.equal(rows[0].n, 1);
    await assert.doesNotReject(() => pool.query(`SELECT * FROM memories_without_embeddings LIMIT 1`));
  });

  test("all five HNSW indexes are recreated after the resize", async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1) ORDER BY indexname`,
      [EMBEDDING_INDEXES]
    );
    assert.deepEqual(rows.map((r) => r.indexname), EMBEDDING_INDEXES);
  });

  test("storage is genuinely usable at the new width and rejects the old one", async () => {
    // The point of Gap 4: after a dims change, inserts must succeed at the
    // new width instead of crash-looping at the old one.
    await assert.doesNotReject(() =>
      pool.query(
        `INSERT INTO memories (id, title, content, type, embedding)
         VALUES (gen_random_uuid(), 'dims-probe', 'dims-probe', 'fact', $1::vector)`,
        [vec(768)]
      )
    );
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO memories (id, title, content, type, embedding)
         VALUES (gen_random_uuid(), 'dims-probe-old', 'dims-probe-old', 'fact', $1::vector)`,
        [vec(1024)]
      )
    );
  });

  test("resizing back up works — the path is not one-directional", async () => {
    await store.resizeVectorStorage(1024);
    assert.equal(await store.getVectorDims(), 1024);
  });

  test("PGVECTOR_HNSW_MAX_DIMS matches the server's real HNSW ceiling", async () => {
    // resizeVectorStorage() hardcodes 2000 as the limit and rejects anything
    // above it before running DDL. Pin that constant to what pgvector
    // actually enforces, so an upstream change can't leave us rejecting
    // widths the server would now accept (or vice versa).
    await store.resizeVectorStorage(2000);
    assert.equal(await store.getVectorDims(), 2000);

    await pool.query(`DROP INDEX IF EXISTS idx_memories_embedding`);
    await pool.query(`DROP VIEW IF EXISTS memories_without_embeddings`);
    await pool.query(`ALTER TABLE memories ALTER COLUMN embedding TYPE vector(2001) USING NULL`);
    await assert.rejects(
      () => pool.query(
        `CREATE INDEX idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops)`
      ),
      /2000 dimensions/
    );
  });
});
