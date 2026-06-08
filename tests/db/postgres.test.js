// tests/db/postgres.test.js
//
// Tests for PostgresStore and helper functions (localeToPgConfig).

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = require("pg");

// ─── Mock pg.Pool ─────────────────────────────────────────────────────────
// pg is CJS, so mock.method on the module object works.

let _poolQuery;

const _defaultQuery = async () => ({ rows: [], fields: [] });

class MockClient {
  constructor() {
    this.query = async (...args) => (_poolQuery ?? _defaultQuery)(...args);
    this.release = mock.fn();
  }
}

class MockPool {
  constructor() {
    this.query = async (...args) => (_poolQuery ?? _defaultQuery)(...args);
    this.connect = async () => new MockClient();
    this.end = mock.fn();
  }
}

// In Node 26, after() called inside before() runs immediately after before()
// completes (not after tests). Save RealPool at module scope so the top-level
// after() can restore it correctly.
const RealPool = pg.Pool;
before(() => { pg.Pool = MockPool; });
after(() => { pg.Pool = RealPool; });

// ─── Dynamic import ───────────────────────────────────────────────────────

let PostgresStore, localeToPgConfig, LOCALE_TO_PG_CONFIG;

before(async () => {
  const mod = await import("../../db/postgres.js");
  PostgresStore = mod.PostgresStore;
  localeToPgConfig = mod.localeToPgConfig;
  LOCALE_TO_PG_CONFIG = mod.LOCALE_TO_PG_CONFIG;
});

// =============================================================================
// LOCALE_TO_PG_CONFIG
// =============================================================================
describe("LOCALE_TO_PG_CONFIG", () => {
  test("maps common locales", () => {
    assert.equal(LOCALE_TO_PG_CONFIG.en, "english");
    assert.equal(LOCALE_TO_PG_CONFIG.de, "german");
    assert.equal(LOCALE_TO_PG_CONFIG.fr, "french");
    assert.equal(LOCALE_TO_PG_CONFIG.es, "spanish");
  });

  test("falls back to 'simple' for unsupported locales", () => {
    assert.equal(LOCALE_TO_PG_CONFIG.bg, "simple");
    assert.equal(LOCALE_TO_PG_CONFIG.pl, "simple");
  });
});

// =============================================================================
// localeToPgConfig
// =============================================================================
describe("localeToPgConfig()", () => {
  test("returns correct config for known locales", () => {
    assert.equal(localeToPgConfig("en"), "english");
    assert.equal(localeToPgConfig("de"), "german");
    assert.equal(localeToPgConfig("fr"), "french");
    assert.equal(localeToPgConfig("nl"), "dutch");
  });

  test("returns default for unknown locale", () => {
    assert.equal(localeToPgConfig("xx"), "english");
    assert.equal(localeToPgConfig(""), "english");
  });

  test("returns default for null/undefined", () => {
    assert.equal(localeToPgConfig(null), "english");
    assert.equal(localeToPgConfig(undefined), "english");
  });
});

// =============================================================================
// PostgresStore — init and counts
// =============================================================================
describe("PostgresStore", () => {
  afterEach(() => {
    _poolQuery = null;
  });

  test("init creates a store with a pool", async () => {
    _poolQuery = async (sql) => {
      if (sql.includes("INSERT INTO")) return { rows: [] };
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    assert.ok(store instanceof PostgresStore);
    assert.ok(store.pool);
  });

  test("counts returns total, embedded, and current", async () => {
    _poolQuery = async () => ({ rows: [{ total: 5, embedded: 3, current: 4 }] });
    const store = await PostgresStore.init();
    const c = await store.counts();
    assert.deepEqual(c, { total: 5, embedded: 3, current: 4 });
  });
});

// =============================================================================
// PostgresStore — CRUD
// =============================================================================
describe("PostgresStore — CRUD", () => {
  afterEach(() => { _poolQuery = null; });

  const sampleRow = {
    id: "abc-123", type: "fact", title: "Test", content: "Content",
    tags: ["test"], importance: 3, created_at: new Date(),
    updated_at: new Date(), expires_at: null, source: "manual",
    lang: "english", valid_from: new Date(), valid_until: null,
    confidence: 1.0, pinned: false,
  };

  test("insert creates a memory", async () => {
    _poolQuery = async () => ({ rows: [sampleRow] });
    const store = await PostgresStore.init();
    const mem = await store.insert({ type: "fact", title: "Test", content: "Content" });
    assert.equal(mem.title, "Test");
    assert.equal(mem.type, "fact");
  });

  test("getById returns a memory", async () => {
    _poolQuery = async () => ({ rows: [sampleRow] });
    const store = await PostgresStore.init();
    const mem = await store.getById("abc-123");
    assert.equal(mem.id, "abc-123");
  });

  test("getById returns null for missing", async () => {
    _poolQuery = async () => ({ rows: [] });
    const store = await PostgresStore.init();
    const mem = await store.getById("missing");
    assert.equal(mem, null);
  });

  test("listAll returns all current memories", async () => {
    _poolQuery = async () => ({ rows: [sampleRow] });
    const store = await PostgresStore.init();
    const all = await store.listAll();
    assert.equal(all.length, 1);
  });

  test("delete removes a memory and returns title", async () => {
    _poolQuery = async () => ({ rows: [{ title: "Deleted" }] });
    const store = await PostgresStore.init();
    const title = await store.delete("abc-123");
    assert.equal(title, "Deleted");
  });

  test("delete returns null for missing", async () => {
    _poolQuery = async () => ({ rows: [] });
    const store = await PostgresStore.init();
    const title = await store.delete("missing");
    assert.equal(title, null);
  });
});

// =============================================================================
// PostgresStore — update
// =============================================================================
describe("PostgresStore — update", () => {
  afterEach(() => { _poolQuery = null; });

  test("update creates new row and marks old as superseded", async () => {
    _poolQuery = async (sql) => {
      if (sql.includes("WHERE id =")) {
        return {
          rows: [{
            id: "old-id", type: "fact", title: "Original", content: "Original",
            tags: [], importance: 3, created_at: new Date(), updated_at: new Date(),
            expires_at: null, source: "manual", lang: "english",
            valid_from: new Date(), valid_until: null, confidence: 1.0, pinned: false,
          }],
        };
      }
      if (sql.startsWith("INSERT INTO memories") && !sql.includes("schema_migrations")) {
        return {
          rows: [{
            id: "new-id", type: "fact", title: "Updated", content: "Updated",
            tags: [], importance: 5, created_at: new Date(), updated_at: new Date(),
            expires_at: null, source: "manual", lang: "english",
            valid_from: new Date(), valid_until: null, confidence: 1.0, pinned: false,
          }],
        };
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const updated = await store.update("old-id", { title: "Updated", importance: 5 });
    assert.equal(updated.id, "new-id");
    assert.equal(updated.title, "Updated");
  });

  test("throws for nonexistent id", async () => {
    _poolQuery = async () => ({ rows: [] });
    const store = await PostgresStore.init();
    await assert.rejects(
      () => store.update("missing", { title: "Nope" }),
      { message: /not found/ }
    );
  });
});

// =============================================================================
// PostgresStore — settings
// =============================================================================
describe("PostgresStore — settings", () => {
  afterEach(() => { _poolQuery = null; });

  test("setSetting returns the value", async () => {
    _poolQuery = async () => ({ rows: [] });
    const store = await PostgresStore.init();
    const v = await store.setSetting("theme", "dark");
    assert.equal(v, "dark");
  });

  test("getSetting returns a value", async () => {
    _poolQuery = async () => ({ rows: [{ value: "dark" }] });
    const store = await PostgresStore.init();
    const v = await store.getSetting("theme");
    assert.equal(v, "dark");
  });

  test("getSetting returns null for missing", async () => {
    _poolQuery = async () => ({ rows: [] });
    const store = await PostgresStore.init();
    const v = await store.getSetting("nonexistent");
    assert.equal(v, null);
  });

  test("getSettings returns all settings", async () => {
    _poolQuery = async () => ({
      rows: [{ key: "theme", value: "dark" }, { key: "lang", value: "en" }],
    });
    const store = await PostgresStore.init();
    const all = await store.getSettings();
    assert.deepEqual(all, { theme: "dark", lang: "en" });
  });

  test("deleteSetting returns true for existing", async () => {
    _poolQuery = async () => ({ rows: [{ key: "theme" }] });
    const store = await PostgresStore.init();
    const ok = await store.deleteSetting("theme");
    assert.equal(ok, true);
  });

  test("deleteSetting returns false for missing", async () => {
    _poolQuery = async () => ({ rows: [] });
    const store = await PostgresStore.init();
    const ok = await store.deleteSetting("nonexistent");
    assert.equal(ok, false);
  });
});

// =============================================================================
// PostgresStore — pin / expiry
// =============================================================================
describe("PostgresStore — pin / expiry", () => {
  afterEach(() => { _poolQuery = null; });

  test("setPin returns true when row updated", async () => {
    _poolQuery = async () => ({ rows: [{ id: "abc" }] });
    const store = await PostgresStore.init();
    const ok = await store.setPin("abc", true);
    assert.equal(ok, true);
  });

  test("setPin returns false when no row matches", async () => {
    _poolQuery = async () => ({ rows: [] });
    const store = await PostgresStore.init();
    const ok = await store.setPin("missing", true);
    assert.equal(ok, false);
  });

  test("setExpiry returns true when row updated", async () => {
    _poolQuery = async () => ({ rows: [{ id: "abc" }] });
    const store = await PostgresStore.init();
    const ok = await store.setExpiry("abc", new Date().toISOString());
    assert.equal(ok, true);
  });
});

// =============================================================================
// PostgresStore — bulkInsert
// =============================================================================
describe("PostgresStore — bulkInsert", () => {
  afterEach(() => { _poolQuery = null; });

  test("inserts multiple memories in a transaction", async () => {
    let callCount = 0;
    _poolQuery = async (sql) => {
      callCount++;
      if (sql === "BEGIN") return {};
      if (sql.startsWith("INSERT INTO memories")) {
        return {
          rows: [{
            id: `id-${callCount}`, type: "fact", title: "Bulk",
            content: `Item ${callCount}`, tags: [], importance: 3,
            created_at: new Date(), updated_at: new Date(),
            expires_at: null, source: "import", lang: "english",
            valid_from: new Date(), valid_until: null, confidence: 1.0, pinned: false,
          }],
        };
      }
      if (sql === "COMMIT") return {};
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const results = await store.bulkInsert([
      { type: "fact", title: "A", content: "First" },
      { type: "fact", title: "B", content: "Second" },
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[1].title, "Bulk");
  });

  test("returns empty array for empty input", async () => {
    _poolQuery = async () => ({ rows: [] });
    const store = await PostgresStore.init();
    const results = await store.bulkInsert([]);
    assert.deepEqual(results, []);
  });
});

// =============================================================================
// PostgresStore — tables
// =============================================================================
describe("PostgresStore — tables", () => {
  afterEach(() => { _poolQuery = null; });

  test("listTables returns table list with counts", async () => {
    _poolQuery = async () => ({ rows: [{ c: 3 }] }); // same count for all tables
    const store = await PostgresStore.init();
    const tables = await store.listTables();
    assert.ok(Array.isArray(tables));
    assert.ok(tables.length >= 1);
    assert.ok(tables[0].name);
    assert.equal(tables[0].count, 3);
  });

  test("readTable returns columns and rows", async () => {
    _poolQuery = async () => ({
      rows: [{ id: "abc", title: "Test" }],
      fields: [{ name: "id" }, { name: "title" }],
    });
    const store = await PostgresStore.init();
    const result = await store.readTable("memories");
    assert.ok(result.columns.includes("id"));
    assert.equal(result.rows[0].title, "Test");
  });

  test("readTable throws for invalid table", async () => {
    const store = await PostgresStore.init();
    await assert.rejects(
      () => store.readTable("secrets"),
      { message: /Unknown table/ }
    );
  });
});

// =============================================================================
// PostgresStore — setEmbedding
// =============================================================================
describe("PostgresStore — setEmbedding", () => {
  afterEach(() => { _poolQuery = null; });

  test("updates embedding for a memory", async () => {
    let capturedSql = "";
    _poolQuery = async (sql) => {
      capturedSql = sql;
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    await store.setEmbedding("abc", [0.1, 0.2, 0.3]);
    assert.ok(capturedSql.includes("UPDATE memories SET embedding"));
  });
});
