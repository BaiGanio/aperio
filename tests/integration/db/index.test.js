// tests/db/index.test.js
//
// Tests for db/index.js — the store factory / backend resolver.
// The mock pattern is constrained by Node.js limitations:
//   - CJS module namespace properties (spawnSync) cannot be redefined
//   - Direct ESM named exports (logError) cannot be redefined
// We therefore test backend resolution via DB_BACKEND env var, mock
// logger methods (on the default-export object, which IS redefinable),
// and mock the store static methods (on the class, which IS redefinable).

import { describe, test, mock, afterEach, before } from "node:test";
import assert from "node:assert/strict";

// ─── Shared mock state ─────────────────────────────────────────────────────
let mockPgInitResult = null;
let mockPgInitThrow = false;
let mockSqliteInitResult = null;

// ─── Mock logger and store static methods ONCE ─────────────────────────────
before(async () => {
  // Logger methods (on the default-export object) — mock once
  const loggerMod = await import("../../../lib/helpers/logger.js");
  for (const level of ["info", "warn", "error", "debug"]) {
    try { mock.method(loggerMod.default, level, () => {}); } catch { /* ok */ }
  }

  // PostgresStore.init — static method on a class (redefinable)
  const pgMod = await import("../../../db/postgres.js");
  mock.method(pgMod.PostgresStore, "init", async () => {
    if (mockPgInitThrow) throw new Error(mockPgInitThrow);
    return mockPgInitResult;
  });

  // SqliteStore.init — same pattern
  const sqliteMod = await import("../../../db/sqlite.js");
  mock.method(sqliteMod.SqliteStore, "init", async () => {
    return mockSqliteInitResult;
  });
});

// ─── Reset state between tests ─────────────────────────────────────────────
afterEach(() => {
  mockPgInitResult = null;
  mockPgInitThrow = false;
  mockSqliteInitResult = null;
  delete process.env.DB_BACKEND;
});

// ─── Cache-busting import helper ───────────────────────────────────────────
const _cacheBust = () => `../../../db/index.js?t=${Date.now()}_${Math.random().toString(36).slice(2)}`;

// =============================================================================
// isDockerAvailable — verify it exists and is a function
// =============================================================================
describe("isDockerAvailable", () => {
  test("is a function", async () => {
    const { isDockerAvailable } = await import(_cacheBust());
    assert.strictEqual(typeof isDockerAvailable, "function");
  });

  test("returns a boolean", async () => {
    const { isDockerAvailable } = await import(_cacheBust());
    const result = isDockerAvailable();
    assert.strictEqual(typeof result, "boolean");
  });
});

// =============================================================================
// getStore — singleton store factory
// =============================================================================
describe("getStore", () => {
  test("returns a store via SQLite when DB_BACKEND=sqlite", async () => {
    process.env.DB_BACKEND = "sqlite";
    mockSqliteInitResult = { db: {}, _sqlite: true };

    const { getStore } = await import(_cacheBust());
    const store = await getStore();
    assert.ok(store._sqlite);
  });

  test("returns a store via Postgres when DB_BACKEND=postgres", async () => {
    process.env.DB_BACKEND = "postgres";
    mockPgInitResult = { pool: {}, _postgres: true };

    const { getStore } = await import(_cacheBust());
    const store = await getStore();
    assert.ok(store._postgres);
  });

  test("Postgres → SQLite fallback when PostgresStore.init() throws", async () => {
    process.env.DB_BACKEND = "postgres";
    mockPgInitThrow = "pg connection refused";
    mockSqliteInitResult = { db: {}, _sqlite: true };

    const { getStore } = await import(_cacheBust());
    const store = await getStore();
    assert.ok(store._sqlite, "should fall back to SQLite when Postgres fails");
  });

  test("returns cached instance on subsequent calls", async () => {
    process.env.DB_BACKEND = "sqlite";
    let initCount = 0;
    // Override the sqlite mock with a counting version
    const sqliteMod = await import("../../../db/sqlite.js");
    mock.method(sqliteMod.SqliteStore, "init", async () => {
      initCount++;
      return { db: {}, _sqlite: true };
    });

    const { getStore } = await import(_cacheBust());
    const a = await getStore();
    const b = await getStore();
    assert.strictEqual(a, b, "both calls should return the same instance");
    assert.strictEqual(initCount, 1, "init() should only be called once");
  });

  test("resolves the same promise when called concurrently", async () => {
    process.env.DB_BACKEND = "sqlite";
    let initCount = 0;
    const sqliteMod = await import("../../../db/sqlite.js");
    mock.method(sqliteMod.SqliteStore, "init", async () => {
      initCount++;
      await new Promise(r => setTimeout(r, 5));
      return { db: {}, _sqlite: true };
    });

    const { getStore } = await import(_cacheBust());
    const [a, b] = await Promise.all([getStore(), getStore()]);
    assert.strictEqual(a, b);
    assert.strictEqual(initCount, 1);
  });
});

// =============================================================================
// resolveBackend (tested indirectly through getStore / createVectorStore)
// =============================================================================
describe("resolveBackend", () => {
  test("DB_BACKEND=sqlite chooses sqlite", async () => {
    process.env.DB_BACKEND = "sqlite";
    mockSqliteInitResult = { db: {}, _sqlite: true };

    const { getStore } = await import(_cacheBust());
    const store = await getStore();
    assert.ok(store._sqlite);
  });

  test("DB_BACKEND=postgres chooses postgres", async () => {
    process.env.DB_BACKEND = "postgres";
    mockPgInitResult = { pool: {}, _pg: true };

    const { getStore } = await import(_cacheBust());
    const store = await getStore();
    assert.ok(store._pg);
  });

  test("unknown DB_BACKEND falls back to sqlite", async () => {
    // An unknown/typo'd value is never used verbatim and never auto-detects into
    // Postgres — it falls straight back to the zero-config safe default (SQLite),
    // so this is deterministic regardless of whether Docker is running on the host.
    process.env.DB_BACKEND = "mysql";
    mockSqliteInitResult = { db: {}, _sqlite: true };

    const { getStore } = await import(_cacheBust());
    const store = await getStore();
    assert.ok(store._sqlite, "unknown backend should fall back to sqlite");
  });
});

// =============================================================================
// createVectorStore
// =============================================================================
describe("createVectorStore", () => {
  test("creates a SQLite store when DB_BACKEND=sqlite", async () => {
    process.env.DB_BACKEND = "sqlite";
    mockSqliteInitResult = { db: {}, _sqlite: true };

    const { createVectorStore } = await import(_cacheBust());
    const store = await createVectorStore();
    assert.ok(store._sqlite);
  });

  test("creates a Postgres store when DB_BACKEND=postgres", async () => {
    process.env.DB_BACKEND = "postgres";
    mockPgInitResult = { pool: {}, _pg: true };

    const { createVectorStore } = await import(_cacheBust());
    const store = await createVectorStore();
    assert.ok(store._pg);
  });
});
