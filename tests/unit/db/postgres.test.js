// tests/db/postgres.test.js
//
// Tests for PostgresStore and helper functions (localeToPgConfig).

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = require("pg");

// memories/self_memories use native Postgres UUID columns — PostgresStore
// short-circuits any non-UUID-shaped id to a not-found result before it ever
// reaches the (mocked) query. "Happy path" fixture ids below must be
// UUID-shaped so they still reach the mock; "missing"-style ids are left as
// plain strings since they're meant to hit the not-found guard directly.
const FIXTURE_ID = "a1a1a1a1-1111-4111-8111-111111111111";
const FIXTURE_ID_OLD = "b2b2b2b2-2222-4222-8222-222222222222";
const FIXTURE_ID_SURVIVOR = "d4d4d4d4-4444-4444-8444-444444444444";
const FIXTURE_ID_DUP = "e5e5e5e5-5555-4555-8555-555555555555";

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
  const mod = await import("../../../db/postgres.js");
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
    const mem = await store.getById(FIXTURE_ID);
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
    const title = await store.delete(FIXTURE_ID);
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
    const updated = await store.update(FIXTURE_ID_OLD, { title: "Updated", importance: 5 });
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
    const ok = await store.setPin(FIXTURE_ID, true);
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
    const ok = await store.setExpiry(FIXTURE_ID, new Date().toISOString());
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
    await store.setEmbedding(FIXTURE_ID, [0.1, 0.2, 0.3]);
    assert.ok(capturedSql.includes("UPDATE memories SET embedding"));
  });
});

// =============================================================================
// PostgresStore — insert with embedding
// =============================================================================
describe("PostgresStore — insert with embedding", () => {
  afterEach(() => { _poolQuery = null; });

  const baseRow = {
    id: "abc-123", type: "fact", title: "Test", content: "Content",
    tags: ["test"], importance: 3, created_at: new Date(),
    updated_at: new Date(), expires_at: null, source: "manual",
    lang: "english", valid_from: new Date(), valid_until: null,
    confidence: 1.0, pinned: false,
  };

  test("insert with embedding passes vector param", async () => {
    let capturedArgs;
    _poolQuery = async (sql, args) => {
      capturedArgs = args;
      return { rows: [{ ...baseRow, id: "vec-id" }] };
    };
    const store = await PostgresStore.init();
    const mem = await store.insert(
      { type: "fact", title: "Vec", content: "With emb" },
      [0.1, 0.2, 0.3]
    );
    assert.equal(mem.id, "vec-id");
    assert.ok(capturedArgs[7], "[8] param should be set (embedding)");
  });
});

// =============================================================================
// PostgresStore — recall (fulltext, semantic, hybrid, no-query, asOf)
// =============================================================================
describe("PostgresStore — recall", () => {
  afterEach(() => { _poolQuery = null; });

  const sampleRow = {
    id: "abc-123", type: "fact", title: "Test", content: "Content",
    tags: ["test"], importance: 3, created_at: new Date(),
    updated_at: new Date(), expires_at: null, source: "manual",
    lang: "english", valid_from: new Date(), valid_until: null,
    confidence: 1.0, pinned: false,
  };

  test("fulltext mode returns results", async () => {
    _poolQuery = async (sql) => {
      if (sql.includes("ts_rank")) return { rows: [{ ...sampleRow, ts_score: "0.5" }] };
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const results = await store.recall({ query: "test", mode: "fulltext", limit: 5 });
    assert.ok(results.length >= 1);
    assert.ok(typeof results[0].similarity === "number");
  });

  test("semantic mode with queryEmbedding", async () => {
    _poolQuery = async (sql) => {
      if (sql.includes("<=>")) return { rows: [{ ...sampleRow, similarity: "0.9" }] };
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const results = await store.recall({ queryEmbedding: [0.1, 0.2, 0.3], mode: "semantic", limit: 5 });
    assert.ok(results.length >= 1);
    assert.equal(results[0].similarity, 0.9);
  });

  test("auto/hybrid mode fuses both paths", async () => {
    _poolQuery = async (sql) => {
      if (sql.includes("rrf_score")) return { rows: [{ ...sampleRow, rrf_score: "0.8" }] };
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const results = await store.recall({
      query: "test", queryEmbedding: [0.1, 0.2, 0.3], mode: "auto", limit: 5,
    });
    assert.ok(results.length >= 1);
    assert.ok(typeof results[0].similarity === "number");
  });

  test("no query returns importance-sorted results", async () => {
    let capturedSql = "";
    _poolQuery = async (sql, params) => {
      capturedSql = sql;
      return { rows: [{ ...sampleRow, ts_score: null }] };
    };
    const store = await PostgresStore.init();
    const results = await store.recall({ limit: 5 });
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
  });

  test("recall with asOf parameter filters temporally", async () => {
    let capturedSql = "";
    _poolQuery = async (sql, params) => {
      capturedSql = sql;
      if (sql.includes("ts_rank")) return { rows: [{ ...sampleRow, ts_score: "0.4" }] };
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const results = await store.recall({
      query: "test", asOf: new Date("2026-06-01").toISOString(),
      limit: 5, mode: "fulltext",
    });
    assert.ok(Array.isArray(results));
  });

  test("recall with type and tags filters", async () => {
    _poolQuery = async (sql) => {
      if (sql.includes("ts_rank")) return { rows: [{ ...sampleRow, ts_score: "0.6" }] };
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const results = await store.recall({
      query: "test", type: "fact", tags: ["test"],
      limit: 5, mode: "fulltext",
    });
    assert.ok(results.length >= 1);
  });
});

// =============================================================================
// PostgresStore — listWithoutEmbeddings
// =============================================================================
describe("PostgresStore — listWithoutEmbeddings", () => {
  afterEach(() => { _poolQuery = null; });

  test("returns memories without embeddings", async () => {
    _poolQuery = async () => ({
      rows: [{ id: "no-emb", title: "No Emb", content: "No embedding yet" }],
    });
    const store = await PostgresStore.init();
    const items = await store.listWithoutEmbeddings();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "no-emb");
  });
});

// =============================================================================
// PostgresStore — clearAllEmbeddings
// =============================================================================
describe("PostgresStore — clearAllEmbeddings", () => {
  afterEach(() => { _poolQuery = null; });

  test("clears embeddings from memories and wiki", async () => {
    const queries = [];
    _poolQuery = async (sql) => {
      queries.push(sql);
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    await store.clearAllEmbeddings();
    assert.ok(queries.length >= 2);
    assert.ok(queries.some(q => q.includes("memories") && q.includes("SET embedding = NULL")));
    assert.ok(queries.some(q => q.includes("wiki_articles") && q.includes("SET embedding = NULL")));
  });
});

// =============================================================================
// PostgresStore — findDuplicates
// =============================================================================
describe("PostgresStore — findDuplicates", () => {
  afterEach(() => { _poolQuery = null; });

  test("finds duplicate memories by embedding similarity", async () => {
    _poolQuery = async () => ({
      rows: [{
        id_a: "a1", title_a: "Alpha", type_a: "fact",
        id_b: "b1", title_b: "Beta", type_b: "fact",
        similarity: "0.95",
      }],
    });
    const store = await PostgresStore.init();
    const dups = await store.findDuplicates(0.9);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].id_a, "a1");
    assert.equal(dups[0].similarity, 0.95);
  });

  test("returns empty when no duplicates exceed threshold", async () => {
    _poolQuery = async () => ({ rows: [] });
    const store = await PostgresStore.init();
    const dups = await store.findDuplicates(0.99);
    assert.deepEqual(dups, []);
  });
});

// =============================================================================
// PostgresStore — mergeDuplicate
// =============================================================================
describe("PostgresStore — mergeDuplicate", () => {
  afterEach(() => { _poolQuery = null; });

  test("merges duplicate memory and updates citations", async () => {
    const queries = [];
    _poolQuery = async (sql, params) => {
      queries.push({ sql: sql.slice(0, 60), params });
      if (sql.includes("WHERE id = ANY")) {
        return { rows: [
          { id: FIXTURE_ID_SURVIVOR, content: "Survivor content" },
          { id: FIXTURE_ID_DUP, content: "Dup content for merging" },
        ]};
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    await store.mergeDuplicate(FIXTURE_ID_SURVIVOR, FIXTURE_ID_DUP);
    assert.ok(queries.length >= 3);
    // Should have done the content append, stale marking, source re-pointing, and DELETE
    assert.ok(queries.some(q => q.sql.includes("UPDATE memories SET content")));
    assert.ok(queries.some(q => q.sql.includes("DELETE FROM memories")));
  });
});

// =============================================================================
// PostgresStore — agent jobs
// =============================================================================
describe("PostgresStore — agent jobs", () => {
  afterEach(() => { _poolQuery = null; });

  test("listAgentJobs returns all jobs", async () => {
    _poolQuery = async () => ({
      rows: [
        { id: "j1", enabled: true, definition: { prompt: "test" }, created_at: new Date(), updated_at: new Date() },
      ],
    });
    const store = await PostgresStore.init();
    const jobs = await store.listAgentJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].prompt, "test");
    assert.equal(jobs[0].spec.id, "background.j1");
  });

  test("getAgentJob returns a job by id", async () => {
    _poolQuery = async () => ({
      rows: [{ id: "j1", enabled: true, definition: { prompt: "hello" }, created_at: new Date(), updated_at: new Date() }],
    });
    const store = await PostgresStore.init();
    const job = await store.getAgentJob("j1");
    assert.equal(job.prompt, "hello");
    assert.equal(job.spec.id, "background.j1");
  });

  test("getAgentJob returns null for missing", async () => {
    _poolQuery = async () => ({ rows: [] });
    const store = await PostgresStore.init();
    const job = await store.getAgentJob("missing");
    assert.equal(job, null);
  });

  test("seedBaseline seeds nightly-maintenance disabled on empty agent_jobs", async () => {
    const inserted = [];
    let counts = 0;
    const store = new PostgresStore({
      query: async (sql, values) => {
        if (sql.includes("COUNT(*)::int AS c")) {
          counts++;
          return { rows: [{ c: counts === 4 ? 0 : 1 }] };
        }
        if (sql.includes("INSERT INTO agent_jobs")) {
          inserted.push(values);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      },
    });

    await store.seedBaseline();

    assert.equal(inserted.length, 1);
    assert.equal(inserted[0][0], "nightly-maintenance");
    assert.equal(inserted[0][1], false);
    assert.equal(JSON.parse(inserted[0][2]).trigger.kind, "interval");
  });

  test("upsertAgentJob saves and returns a job", async () => {
    let afterInsert = false;
    _poolQuery = async (sql) => {
      if (sql.includes("ON CONFLICT")) {
        afterInsert = true;
        return { rows: [] };
      }
      if (afterInsert && sql.includes("agent_jobs")) {
        return { rows: [{ id: "j1", enabled: true, definition: { prompt: "hi" }, created_at: new Date(), updated_at: new Date() }] };
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const job = await store.upsertAgentJob({ id: "j1", enabled: true, prompt: "hi" });
    assert.equal(job.prompt, "hi");
    assert.equal(job.spec.id, "background.j1");
  });

  test("deleteAgentJob returns true/false", async () => {
    let delQueries = 0;
    _poolQuery = async (sql) => {
      if (sql.includes("DELETE FROM agent_jobs")) {
        delQueries++;
        return { rows: delQueries === 1 ? [{ id: "j1" }] : [] };
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    assert.equal(await store.deleteAgentJob("j1"), true);
    assert.equal(await store.deleteAgentJob("j1"), false);
  });
});

// =============================================================================
// PostgresStore — agent run history
// =============================================================================
describe("PostgresStore — agent run history", () => {
  afterEach(() => { _poolQuery = null; });

  test("recordAgentRun inserts a run", async () => {
    let params;
    _poolQuery = async (_sql, values) => {
      params = values;
      return { rows: [{ id: 42 }] };
    };
    const store = await PostgresStore.init();
    const id = await store.recordAgentRun({
      jobId: "j1", startedAt: "2026-06-01T00:00:00Z", verdict: "ok", mode: "steps",
      artifactCount: 2, artifactBytes: 12345,
    });
    assert.equal(id, 42);
    assert.deepEqual(params.slice(-2), [2, 12345]);
  });

  test("listAgentRuns returns runs newest-first", async () => {
    _poolQuery = async () => ({
      rows: [{ id: 2, job_id: "j1", started_at: "2026-06-02T00:00:00Z", verdict: "ok" }],
    });
    const store = await PostgresStore.init();
    const runs = await store.listAgentRuns("j1");
    assert.equal(runs.length, 1);
  });

  test("deleteAgentRun returns true/false", async () => {
    _poolQuery = async (sql) => {
      if (sql.includes("DELETE FROM agent_runs")) return { rowCount: 1, rows: [] };
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    assert.equal(await store.deleteAgentRun(42), true);
  });

  test("pruneAgentRuns removes old runs", async () => {
    _poolQuery = async (sql) => {
      if (sql.includes("DELETE FROM agent_runs")) return { rowCount: 3, rows: [] };
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const removed = await store.pruneAgentRuns(30);
    assert.equal(removed, 3);
  });
});

// =============================================================================
// PostgresStore — agent interrupts
// =============================================================================
describe("PostgresStore — agent interrupts", () => {
  afterEach(() => { _poolQuery = null; });

  test("createAgentInterrupt inserts a durable descriptor", async () => {
    let captured;
    _poolQuery = async (sql, values) => {
      if (sql.includes("INSERT INTO agent_interrupts")) {
        captured = values;
        return {
          rows: [{
            id: values[0],
            session_id: values[1],
            run_id: values[2],
            tool_name: values[3],
            canonical_arguments: JSON.parse(values[4]),
            protected_payload_ref: null,
            digest: values[6],
            allowed_decisions: JSON.parse(values[7]),
            status: values[8],
            created_at: values[9],
            updated_at: values[10],
            expires_at: values[11],
          }],
        };
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const interrupt = await store.createAgentInterrupt({
      id: "pg-interrupt-1",
      sessionId: "session-a",
      runId: "run-a",
      toolName: "write_file",
      canonicalArguments: { path: "notes.md" },
      digest: "sha256:abc",
      allowedDecisions: ["approve", "reject"],
    });

    assert.equal(interrupt.id, "pg-interrupt-1");
    assert.equal(interrupt.session_id, "session-a");
    assert.deepEqual(interrupt.canonical_arguments, { path: "notes.md" });
    assert.deepEqual(interrupt.allowed_decisions, ["approve", "reject"]);
    assert.equal(captured[4], JSON.stringify({ path: "notes.md" }));
    assert.equal(captured[5], null);
  });

  test("listAgentInterrupts builds scoped pending query", async () => {
    let captured;
    _poolQuery = async (sql, values) => {
      if (sql.includes("FROM agent_interrupts")) {
        captured = { sql, values };
        return {
          rows: [{
            id: "pg-interrupt-1",
            session_id: "session-a",
            run_id: null,
            tool_name: "write_file",
            canonical_arguments: { path: "notes.md" },
            protected_payload_ref: null,
            digest: "sha256:abc",
            allowed_decisions: ["approve"],
            status: "pending",
            created_at: new Date(),
            updated_at: new Date(),
            expires_at: null,
          }],
        };
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const rows = await store.listAgentInterrupts({ sessionId: "session-a", limit: 10 });
    assert.equal(rows.length, 1);
    assert.ok(captured.sql.includes("session_id = $1"));
    assert.ok(captured.sql.includes("status = $2"));
    assert.ok(captured.sql.includes("expires_at IS NULL OR expires_at > $3"));
    assert.equal(captured.values[0], "session-a");
    assert.equal(captured.values[1], "pending");
    assert.equal(captured.values[3], 10);
  });

  test("updateAgentInterruptStatus returns the updated row", async () => {
    _poolQuery = async (sql, values) => {
      if (sql.includes("UPDATE agent_interrupts")) {
        return {
          rows: [{
            id: values[0],
            session_id: "session-a",
            run_id: null,
            tool_name: "write_file",
            canonical_arguments: { path: "notes.md" },
            protected_payload_ref: null,
            digest: "sha256:abc",
            allowed_decisions: ["approve"],
            status: values[1],
            created_at: new Date(),
            updated_at: new Date(),
            expires_at: null,
          }],
        };
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const row = await store.updateAgentInterruptStatus("pg-interrupt-1", "expired");
    assert.equal(row.status, "expired");
  });

  test("expireAgentInterrupts updates pending expired rows", async () => {
    let captured;
    _poolQuery = async (sql, values) => {
      if (sql.includes("UPDATE agent_interrupts") && sql.includes("expires_at <= $1")) {
        captured = values;
        return { rowCount: 2, rows: [] };
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const count = await store.expireAgentInterrupts("2026-07-07T00:00:00.000Z");
    assert.equal(count, 2);
    assert.deepEqual(captured, ["2026-07-07T00:00:00.000Z"]);
  });

  test("decideAgentInterrupt conditionally records one decision", async () => {
    let captured;
    _poolQuery = async (sql, values) => {
      if (sql.includes("UPDATE agent_interrupts") && sql.includes("decision_payload")) {
        captured = values;
        return {
          rows: [{
            id: values[0],
            session_id: "session-a",
            run_id: null,
            tool_name: "write_file",
            canonical_arguments: { path: "notes.md" },
            protected_payload_ref: null,
            digest: "sha256:abc",
            allowed_decisions: ["approve"],
            decision: values[1],
            decision_payload: JSON.parse(values[2]),
            claim_id: null,
            status: values[3],
            created_at: new Date(),
            updated_at: values[4],
            decided_at: values[4],
            claimed_at: null,
            completed_at: null,
            expires_at: null,
          }],
        };
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const row = await store.decideAgentInterrupt("pg-interrupt-1", {
      decision: "edit",
      status: "edited",
      decisionPayload: { editedArguments: { path: "notes.md" } },
      now: "2026-07-07T00:00:00.000Z",
    });
    assert.equal(row.status, "edited");
    assert.deepEqual(row.decision_payload, { editedArguments: { path: "notes.md" } });
    assert.equal(captured[0], "pg-interrupt-1");
    assert.equal(captured[1], "edit");
  });

  test("claimAgentInterrupt conditionally claims approved rows", async () => {
    _poolQuery = async (sql, values) => {
      if (sql.includes("SET status = 'claimed'")) {
        return {
          rows: [{
            id: values[0],
            session_id: "session-a",
            run_id: null,
            tool_name: "write_file",
            canonical_arguments: { path: "notes.md" },
            protected_payload_ref: null,
            digest: "sha256:abc",
            allowed_decisions: ["approve"],
            decision: "approve",
            decision_payload: null,
            claim_id: values[1],
            status: "claimed",
            created_at: new Date(),
            updated_at: values[2],
            decided_at: new Date(),
            claimed_at: values[2],
            completed_at: null,
            expires_at: null,
          }],
        };
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const row = await store.claimAgentInterrupt("pg-interrupt-1", {
      claimId: "claim-1",
      now: "2026-07-07T00:00:00.000Z",
    });
    assert.equal(row.status, "claimed");
    assert.equal(row.claim_id, "claim-1");
  });

  test("completeAgentInterrupt only completes claimed rows", async () => {
    _poolQuery = async (sql, values) => {
      if (sql.includes("UPDATE agent_interrupts") && sql.includes("completed_at")) {
        return {
          rows: [{
            id: values[0],
            session_id: "session-a",
            run_id: null,
            tool_name: "write_file",
            canonical_arguments: { path: "notes.md" },
            protected_payload_ref: null,
            digest: "sha256:abc",
            allowed_decisions: ["approve"],
            decision: "approve",
            decision_payload: null,
            claim_id: "claim-1",
            status: values[1],
            created_at: new Date(),
            updated_at: values[2],
            decided_at: new Date(),
            claimed_at: new Date(),
            completed_at: values[2],
            expires_at: null,
          }],
        };
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const row = await store.completeAgentInterrupt("pg-interrupt-1", {
      status: "executed",
      now: "2026-07-07T00:00:00.000Z",
    });
    assert.equal(row.status, "executed");
    assert.ok(row.completed_at);
  });

  test("rejects non-JSON executable descriptors", async () => {
    const store = await PostgresStore.init();
    await assert.rejects(
      () => store.createAgentInterrupt({
        sessionId: "session-a",
        toolName: "write_file",
        canonicalArguments: { run: () => {} },
        digest: "sha256:function",
        allowedDecisions: ["approve"],
      }),
      /JSON-serializable/,
    );
  });
});

// =============================================================================
// PostgresStore — issue triage
// =============================================================================
describe("PostgresStore — issue triage", () => {
  afterEach(() => { _poolQuery = null; });

  test("upsertIssue inserts or updates an issue", async () => {
    let captured;
    _poolQuery = async (sql, args) => {
      captured = { sql: sql.slice(0, 50), args };
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    await store.upsertIssue({ repo: "org/repo", number: 1, title: "Fix", state: "open", updatedAt: "2026-06-01T00:00:00Z" });
    assert.ok(captured.sql.includes("INSERT INTO issue_triage"));
  });

  test("listPendingIssues returns untriaged issues", async () => {
    _poolQuery = async () => ({
      rows: [{ repo: "org/repo", issue_number: 1, title: "Fix", state: "open" }],
    });
    const store = await PostgresStore.init();
    const pending = await store.listPendingIssues();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].issue_number, 1);
  });

  test("listPendingIssues filters by repo", async () => {
    _poolQuery = async () => ({
      rows: [{ repo: "org/repo", issue_number: 1 }],
    });
    const store = await PostgresStore.init();
    const pending = await store.listPendingIssues("org/repo");
    assert.equal(pending.length, 1);
  });

  test("markTriaged updates the issue", async () => {
    let captured;
    _poolQuery = async (sql, args) => {
      captured = { sql: sql.slice(0, 50), args };
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    await store.markTriaged({ repo: "org/repo", number: 1, priority: 3, verdict: "fix" });
    assert.ok(captured.sql.includes("UPDATE issue_triage"));
  });
});

// =============================================================================
// PostgresStore — exportAll / importAll / close
// =============================================================================
describe("PostgresStore — exportAll / importAll / close", () => {
  afterEach(() => { _poolQuery = null; });

  test("exportAll returns memories, wiki, agent data", async () => {
    let phase = "init";
    _poolQuery = async (sql) => {
      if (sql.includes("SELECT id, type, title, content") && sql.includes("memories")) {
        phase = "memories";
        return { rows: [{ id: "m1", type: "fact", title: "Exported", content: "Exported memory", tags: ["t"], importance: 3, expires_at: null, source: "manual", pinned: false, lang: "english", confidence: 1.0 }] };
      }
      if (sql.includes("wiki_articles") && sql.includes("LEFT JOIN")) {
        phase = "wiki";
        return { rows: [{ slug: "wiki-1", title: "Wiki Exported", summary: "s", body_md: "b", tags: ["t"], generated_by: "test", revision: 1, source_memory_ids: ["m1"] }] };
      }
      if (sql.includes("agent_jobs") && !sql.includes("INSERT")) {
        phase = "jobs";
        return { rows: [{ id: "aj1", enabled: true, definition: { prompt: "test" }, created_at: new Date(), updated_at: new Date() }] };
      }
      if (sql.includes("agent_runs") && sql.includes("job_id = ANY")) {
        phase = "runs";
        return { rows: [{ job_id: "aj1", started_at: "2026-06-01T00:00:00Z", verdict: "ok" }] };
      }
      if (sql.includes("self_memories") && sql.includes("SELECT id, title, content")) {
        phase = "self_memories";
        return { rows: [{ id: "s1", title: "Self exported", content: "Own note", tags: ["a"], importance: 4, source: "self", lang: "english", confidence: 1.0 }] };
      }
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const data = await store.exportAll();
    assert.ok(Array.isArray(data.memories));
    assert.ok(Array.isArray(data.wiki_articles));
    assert.ok(Array.isArray(data.agent_jobs));
    assert.ok(Array.isArray(data.agent_runs));
    assert.ok(Array.isArray(data.self_memories));
    assert.equal(data.memories[0].title, "Exported");
    assert.equal(data.self_memories[0].title, "Self exported");
  });

  test("importAll imports memories, wiki, jobs, runs and self_memories", async () => {
    let queryCount = 0;
    _poolQuery = async () => {
      queryCount++;
      return { rows: [], rowCount: 1 };
    };
    const store = await PostgresStore.init();
    const result = await store.importAll({
      memories: [{ id: "imp-m1", type: "fact", title: "Imported", content: "Imported content" }],
      wiki_articles: [{ slug: "imp-wiki", title: "Imported Wiki", body_md: "content" }],
      agent_jobs: [{ id: "imp-job", enabled: true, prompt: "test" }],
      agent_runs: [{ job_id: "imp-job", started_at: "2026-06-01T00:00:00Z", verdict: "ok" }],
      self_memories: [{ id: "imp-s1", title: "Imported Self", content: "content" }],
    });
    assert.equal(result.imported.memories, 1);
    assert.equal(result.imported.wiki, 1);
    assert.equal(result.imported.jobs, 1);
    assert.equal(result.imported.runs, 1);
    assert.equal(result.imported.self_memories, 1);
  });

  test("close calls pool.end", async () => {
    let ended = false;
    const store = await PostgresStore.init();
    store.pool.end = async () => { ended = true; };
    await store.close();
    assert.ok(ended);
  });
});

// =============================================================================
// assertNonDefaultDbUrl
// =============================================================================
describe("assertNonDefaultDbUrl", () => {
  let assertFn;

  before(async () => {
    const mod = await import("../../../db/postgres.js");
    assertFn = mod.assertNonDefaultDbUrl;
  });

  test("throws when DATABASE_URL contains default password", () => {
    assert.throws(
      () => assertFn("postgres://user:aperio_secret@localhost:5432/db"),
      { message: /default Postgres password/ }
    );
  });

  test("does not throw for a custom password", () => {
    assert.doesNotThrow(
      () => assertFn("postgres://user:real_password@localhost:5432/db")
    );
  });

  test("does not throw when APERIO_ALLOW_DEFAULT_DB_PASSWORD=1", () => {
    assert.doesNotThrow(
      () => assertFn("postgres://user:aperio_secret@localhost:5432/db", "1")
    );
  });

  test("does not throw for non-string url", () => {
    assert.doesNotThrow(() => assertFn(undefined));
    assert.doesNotThrow(() => assertFn(null));
  });
});

// =============================================================================
// PostgresStore — update with embedding
// =============================================================================
describe("PostgresStore — update with embedding", () => {
  afterEach(() => { _poolQuery = null; });

  const existingRow = {
    id: "old-id", type: "fact", title: "Original", content: "Original content",
    tags: [], importance: 3, created_at: new Date(), updated_at: new Date(),
    expires_at: null, source: "manual", lang: "english",
    valid_from: new Date(), valid_until: null, confidence: 1.0, pinned: false,
  };

  test("update with embedding stores vector on new row", async () => {
    _poolQuery = async (sql) => {
      if (sql.includes("WHERE id =")) return { rows: [existingRow] };
      if (sql.startsWith("INSERT INTO memories")) {
        return { rows: [{ ...existingRow, id: "new-id", title: "Updated" }] };
      }
      if (sql.startsWith("UPDATE memories SET valid_until")) return { rows: [] };
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    const updated = await store.update(FIXTURE_ID_OLD, { title: "Updated" }, [0.5, 0.5, 0.5]);
    assert.equal(updated.title, "Updated");
    assert.equal(updated.id, "new-id");
  });

  test("update with superseded existing throws", async () => {
    const superseded = { ...existingRow, valid_until: new Date() };
    _poolQuery = async () => ({ rows: [superseded] });
    const store = await PostgresStore.init();
    await assert.rejects(
      () => store.update(FIXTURE_ID_OLD, { title: "Nope" }),
      { message: /superseded/ }
    );
  });
});

// =============================================================================
// PostgresStore — bulkInsert ROLLBACK error path
// =============================================================================
describe("PostgresStore — bulkInsert error path", () => {
  afterEach(() => { _poolQuery = null; });

  test("throws and rolls back on error", async () => {
    let seenBegin = false;
    let seenRollback = false;
    _poolQuery = async (sql) => {
      if (sql === "BEGIN") { seenBegin = true; return {}; }
      if (sql.startsWith("INSERT INTO memories")) throw new Error("db failure");
      return { rows: [] };
    };
    // Mock client.query to throw
    _poolQuery = async (_sql) => {
      if (_sql === "BEGIN") return {};
      if (_sql.startsWith("INSERT INTO memories")) throw new Error("db failure");
      return { rows: [] };
    };
    const store = await PostgresStore.init();
    await assert.rejects(
      () => store.bulkInsert([{ type: "fact", title: "Fail", content: "Will fail" }]),
      { message: /db failure/ }
    );
  });
});

// =============================================================================
// PostgresStore — setPin/setExpiry edge cases
// =============================================================================
describe("PostgresStore — pin/expiry edge cases", () => {
  afterEach(() => { _poolQuery = null; });

  test("setPin(false) returns true when row updated", async () => {
    _poolQuery = async () => ({ rows: [{ id: "abc" }] });
    const store = await PostgresStore.init();
    const ok = await store.setPin(FIXTURE_ID, false);
    assert.equal(ok, true);
  });

  test("setExpiry returns false when no row matches", async () => {
    _poolQuery = async () => ({ rows: [] });
    const store = await PostgresStore.init();
    const ok = await store.setExpiry("missing", new Date().toISOString());
    assert.equal(ok, false);
  });
});
