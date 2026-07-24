// tests/integration/db/contract/backends.js
// Shared backend enumeration for the SQLite/Postgres store contract suite
// (issue #307 Phase 3). Every domain file under this directory runs the exact
// same test bodies against whatever this returns — the identical code path is
// the guarantee against silent behavioral drift between the two stores.
//
// SQLite always runs: a fresh in-memory store per file, same
// SQLITE_PATH=":memory:" convention already used across tests/integration/db/.
// Postgres only runs when APERIO_E2E_POSTGRES_URL is set — the same opt-in
// knob tests/e2e/real-app/real-app-lifecycle.test.js (T64) already checks.
// Point it at a real, disposable Postgres, e.g.:
//   docker compose -f docker/docker-compose.yml --env-file .env up -d
//   export APERIO_E2E_POSTGRES_URL=postgres://aperio:<password>@localhost:8008/aperio
// If that URL's password is the shipped example (aperio_secret),
// assertNonDefaultDbUrl() (db/postgres/store.js) refuses to connect — use a
// real password, or export APERIO_ALLOW_DEFAULT_DB_PASSWORD=1 for disposable
// local dev.
//
// Postgres's `vector` columns are fixed at 1024 dims by migration (not
// configurable per-env like SQLite's vec0 tables), so this harness pins
// SQLite to EMBEDDING_DIMS=1024 too — one embedding helper (see embeddings.js)
// works unmodified against either backend.
//
// `node --test` runs separate test FILES in parallel worker processes by
// default (only the test:integration script pins --test-concurrency=1; the
// top-level test/test:ci scripts that glob every tier do not). Each of this
// directory's domain files independently calls PostgresStore.init(), which
// runs migrations + baseline seeding — neither of which is safe to race
// across processes against a fresh database (runMigrations() has no
// cross-process lock, so concurrent workers can select the same pending
// migrations and collide on duplicate DDL / schema_migrations inserts).
// getStore() below wraps init() in a Postgres advisory lock so every process
// serializes on that critical section; once one process has migrated+seeded,
// the rest see zero pending migrations and already-seeded tables and return
// almost immediately — only the risky window is serialized, not the tests.

import { randomUUID } from "node:crypto";
import pg from "pg";

// Arbitrary but fixed lock key — every process calling getStore() must use
// the same one to actually serialize on each other.
const PG_INIT_LOCK_KEY = 307_03; // issue #307, phase 3

export async function contractBackends() {
  const backends = [{
    name: "sqlite",
    async getStore() {
      const oldPath = process.env.SQLITE_PATH;
      const oldDims = process.env.EMBEDDING_DIMS;
      process.env.SQLITE_PATH = ":memory:";
      process.env.EMBEDDING_DIMS = "1024";
      const { SqliteStore } = await import("../../../../db/sqlite.js");
      const store = await SqliteStore.init();
      store._contractRestoreEnv = () => {
        if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
        if (oldDims) process.env.EMBEDDING_DIMS = oldDims; else delete process.env.EMBEDDING_DIMS;
      };
      return store;
    },
    async teardown(store) {
      await store?.close?.();
      store?._contractRestoreEnv?.();
    },
  }];

  const pgUrl = process.env.APERIO_E2E_POSTGRES_URL;
  if (pgUrl) {
    backends.push({
      name: "postgres",
      async getStore() {
        const oldUrl = process.env.DATABASE_URL;
        process.env.DATABASE_URL = pgUrl;
        const { PostgresStore } = await import("../../../../db/postgres.js");

        const lock = new pg.Pool({ connectionString: pgUrl });
        let store;
        try {
          await lock.query("SELECT pg_advisory_lock($1)", [PG_INIT_LOCK_KEY]);
          store = await PostgresStore.init();
        } finally {
          await lock.query("SELECT pg_advisory_unlock($1)", [PG_INIT_LOCK_KEY]);
          await lock.end();
        }

        store._contractRestoreEnv = () => {
          if (oldUrl) process.env.DATABASE_URL = oldUrl; else delete process.env.DATABASE_URL;
        };
        return store;
      },
      async teardown(store) {
        await store?.pool?.end?.();
        store?._contractRestoreEnv?.();
      },
    });
  }
  return backends;
}

// Registers one diagnostic-only test when Postgres is skipped, mirroring the
// skip pattern tests/e2e/real-app/real-app-lifecycle.test.js already uses.
export function postgresSkipNotice(test) {
  if (process.env.APERIO_E2E_POSTGRES_URL) return;
  test("postgres contract skipped (APERIO_E2E_POSTGRES_URL not set)", (t) => {
    t.diagnostic(
      "APERIO_E2E_POSTGRES_URL not set — bring up docker compose -f docker/docker-compose.yml " +
      "--env-file .env up -d, export APERIO_E2E_POSTGRES_URL, and re-run to include this backend"
    );
  });
}

// A unique namespace per test-process run, so contract tests stay
// order-independent and safe to re-run against a real, persistent, opt-in
// Postgres database without colliding with rows a previous run left behind.
export function contractId(label = "contract") {
  return `${label}-${randomUUID()}`;
}
