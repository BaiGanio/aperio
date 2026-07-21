// tests/db-connect/sample-db.test.js
// Tests for the disposable "practice shop" SQLite database.
//
// ZERO real filesystem access. The fs operations (existsSync, mkdirSync, rmSync)
// are patched via mock.method on the CJS fs module. The Database constructor
// from better-sqlite3 is replaced by patching require.cache before dynamically
// importing the module under test.

import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock } from "node:test";

const require = createRequire(import.meta.url);
const fsMod = require("fs");

// ─── Mock Database — never touches the filesystem ───────────────────────────
// Accurately simulates better-sqlite3's prepare/run/transaction model so seed
// data counts are verified against the real constants from the source module.

class MockDatabase {
  constructor(file) {
    this.file = file;
    this._tables = new Set();
    this._prepared = [];
  }
  pragma() {}

  exec(sql) {
    const re = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g;
    let m;
    while ((m = re.exec(sql)) !== null) this._tables.add(m[1]);
  }

  prepare(sql) {
    // Return a statement proxy that sends every run() call to the collector
    // with the table name derived from the SQL.
    if (sql.startsWith("INSERT INTO ")) {
      const tbl = sql.split(" ")[2];
      return { run: (...args) => collector.run(tbl, args) };
    }
    // COUNT(*) query used by seed verification in the store
    if (/COUNT\(\*\)/.test(sql)) {
      return { get: () => ({ c: collector.count(sql) }) };
    }
    // Table listing
    if (/FROM sqlite_master/.test(sql)) {
      return { all: () => [...this._tables].map((n) => ({ name: n, type: "table" })) };
    }
    return { run() {}, get() { return {}; }, all() { return []; } };
  }

  close() {}
  transaction(fn) { return fn; }
}

// ─── Insert collector — counts per table, persists across transaction ───────
// The seed function prepares statements OUTSIDE the transaction then calls run
// inside db.transaction(() => { ... })().  Our transaction mock returns fn
// directly, so run calls land here in order.

const collector = (globalThis.__dbCollector = {
  _prepareCount: 0,
  _runs: [],
  _reset() {
    this._prepareCount = 0;
    this._runs = [];
  },
  run(table, args) {
    this._runs.push({ table, args });
  },
  count(sql) {
    const m = sql.match(/FROM (\w+)/);
    if (!m) return 0;
    return this._runs.filter((r) => r.table === m[1]).length;
  },
  byTable() {
    const counts = {};
    for (const r of this._runs) {
      counts[r.table] = (counts[r.table] || 0) + 1;
    }
    return counts;
  },
});

// Replace require.cache entry BEFORE the module under test is imported.
const bsqlitePath = require.resolve("better-sqlite3");
require.cache[bsqlitePath] = { exports: MockDatabase };

// ─── Mock fs operations (intercepts ESM module-level fs imports) ────────────

const fsCalls = { existsSync: [], mkdirSync: [], rmSync: [] };

mock.method(fsMod, "existsSync", (p) => { fsCalls.existsSync.push(p); return true; });
mock.method(fsMod, "mkdirSync", (p, opts) => { fsCalls.mkdirSync.push({ p, opts }); });
mock.method(fsMod, "rmSync", (p, opts) => { fsCalls.rmSync.push({ p, opts }); });

// ─── Dynamic import of the module under test (after mocking) ─────────────────

let sampleDbMod;

before(async () => {
  collector._reset();
  fsCalls.existsSync = [];
  fsCalls.mkdirSync = [];
  fsCalls.rmSync = [];
  process.env.SQLITE_PATH = "/mem/test/aperio.db";

  sampleDbMod = await import("../../../lib/db-connect/sample-db.js");
});

// The collector persists across the whole file, but each test that calls
// createSampleDatabase appends another full seed run. Reset per test so
// collector._runs reflects exactly one seed (otherwise counts accumulate:
// e.g. 3 seed runs ⇒ 42 customer inserts, masked only because the count
// assertions dedupe IDs via Set).
beforeEach(() => collector._reset());

after(() => {
  delete process.env.SQLITE_PATH;
  mock.reset();
  delete require.cache[bsqlitePath];
  for (const key of Object.keys(require.cache)) {
    if (key.includes("sample-db")) delete require.cache[key];
  }
});

const SETTINGS_KEY = "db.connections";

function makeStore(initialConns = []) {
  const data = { [SETTINGS_KEY]: initialConns };
  return {
    async getSetting(k) { return data[k] ?? null; },
    async setSetting(k, v) { if (k === SETTINGS_KEY) data[k] = v; },
  };
}

// =============================================================================
// sampleDbPath
// =============================================================================

describe("sampleDbPath", () => {
  test("resolves based on SQLITE_PATH env var", () => {
    const path = sampleDbMod.sampleDbPath();
    assert.ok(path.startsWith("/mem/test"));
    assert.ok(path.endsWith("sample-shop.db"));
  });

  test("changes when SQLITE_PATH changes", () => {
    process.env.SQLITE_PATH = "/other/aperio.db";
    try {
      const path = sampleDbMod.sampleDbPath();
      assert.ok(path.startsWith("/other"));
    } finally {
      process.env.SQLITE_PATH = "/mem/test/aperio.db";
    }
  });
});

// =============================================================================
// createSampleDatabase
// =============================================================================

describe("createSampleDatabase", () => {
  test("registers both sample connections in the store", async () => {
    const store = makeStore();
    await sampleDbMod.createSampleDatabase(store);

    const conns = await store.getSetting(SETTINGS_KEY);
    const names = conns.map((c) => c.name);
    assert.ok(names.includes(sampleDbMod.SAMPLE_RO));
    assert.ok(names.includes(sampleDbMod.SAMPLE_RW));

    const ro = conns.find((c) => c.name === sampleDbMod.SAMPLE_RO);
    assert.strictEqual(ro.readOnly, true);
    assert.strictEqual(ro.sample, true);

    const rw = conns.find((c) => c.name === sampleDbMod.SAMPLE_RW);
    assert.strictEqual(rw.readOnly, false);
    assert.strictEqual(rw.sample, true);
  });

  test("preserves existing non-sample connections", async () => {
    const store = makeStore([{ name: "my-pg", engine: "postgres", host: "localhost" }]);
    await sampleDbMod.createSampleDatabase(store);

    const conns = await store.getSetting(SETTINGS_KEY);
    const names = conns.map((c) => c.name);
    assert.ok(names.includes("my-pg"));
    assert.ok(names.includes(sampleDbMod.SAMPLE_RO));
  });

  test("seed inserts 14 customers, 10 products, 24 orders, and order items", async () => {
    await sampleDbMod.createSampleDatabase(makeStore());

    // Derive counts from the captured run arguments so we validate the seed
    // data against the constants in lib/db-connect/sample-db.js.
    const custIds = new Set(collector._runs.filter((r) => r.table === "customers").map((r) => r.args[0]));
    const prodIds = new Set(collector._runs.filter((r) => r.table === "products").map((r) => r.args[0]));
    const orderIds = new Set(collector._runs.filter((r) => r.table === "orders").map((r) => r.args[0]));
    const itemIds = new Set(collector._runs.filter((r) => r.table === "order_items").map((r) => r.args[0]));

    assert.strictEqual(custIds.size, 14, "14 unique customer IDs");
    assert.strictEqual(prodIds.size, 10, "10 unique product IDs");
    assert.strictEqual(orderIds.size, 24, "24 unique order IDs");
    assert.ok(itemIds.size >= 24, `at least 24 order_items (got ${itemIds.size})`);
  });

  test("seed data includes realistic order IDs starting at 4801", async () => {
    await sampleDbMod.createSampleDatabase(makeStore());
    // First order row should have id=4801 (from the source code)
    const firstOrder = collector._runs.find((r) => r.table === "orders");
    assert.ok(firstOrder, "at least one order inserted");
    assert.strictEqual(firstOrder.args[0], 4801, "first order id is 4801");
  });

  test("seed customers include realistic names and emails", async () => {
    await sampleDbMod.createSampleDatabase(makeStore());
    const custRuns = collector._runs.filter((r) => r.table === "customers");
    // First customer: Ava Reyes, ava.reyes@example.com
    assert.strictEqual(custRuns[0].args[0], 1);
    assert.strictEqual(custRuns[0].args[1], "Ava Reyes");
    assert.strictEqual(custRuns[0].args[2], "ava.reyes@example.com");
  });
});

// =============================================================================
// deleteSampleDatabase
// =============================================================================

describe("deleteSampleDatabase", () => {
  test("removes sample connections from the store", async () => {
    const store = makeStore([{ name: "keep", engine: "sqlite", file: "/x.db" }]);
    await sampleDbMod.createSampleDatabase(store);
    await sampleDbMod.deleteSampleDatabase(store);

    const conns = await store.getSetting(SETTINGS_KEY);
    const names = conns.map((c) => c.name);
    assert.ok(names.includes("keep"));
    assert.ok(!names.includes(sampleDbMod.SAMPLE_RO));
    assert.ok(!names.includes(sampleDbMod.SAMPLE_RW));
  });

  test("calls rmSync for the sample DB file and its WAL/SHM", async () => {
    const store = makeStore();
    await sampleDbMod.createSampleDatabase(store);
    const afterCreate = fsCalls.rmSync.length;
    await sampleDbMod.deleteSampleDatabase(store);

    const deleteCalls = fsCalls.rmSync.slice(afterCreate);
    assert.strictEqual(deleteCalls.length, 3, "rmSync called 3 times (db, -wal, -shm)");
    assert.ok(deleteCalls[0].p.endsWith("sample-shop.db"));
    assert.ok(deleteCalls[1].p.endsWith("sample-shop.db-wal"));
    assert.ok(deleteCalls[2].p.endsWith("sample-shop.db-shm"));
  });

  test("no-ops when no sample connections exist", async () => {
    const store = makeStore([{ name: "other", engine: "sqlite", file: "/x.db" }]);
    const prevConns = (await store.getSetting(SETTINGS_KEY)).length;
    await sampleDbMod.deleteSampleDatabase(store);
    assert.strictEqual((await store.getSetting(SETTINGS_KEY)).length, prevConns);
  });
});
