// tests/db-connect/drivers/mssql.test.js
// MSSQL driver: introspection, read row-cap, read-only enforcement.
// Uses a mock mssql pool — no real SQL Server connection required.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MssqlDriver } from "../../lib/db-connect/drivers/mssql.js";

// ─── Mock pool / request factories ───────────────────────────────────────────

function makeRequest(opts = {}) {
  const inputs = [];
  const events = {};
  const req = {
    input(name, val) { inputs.push({ name, val }); return req; },
    _inputs: inputs,
    stream: false,
    on(ev, cb) { events[ev] = cb; return req; },
    cancel() { events.error?.(new Error("cancelled")); },
    query: opts.query ?? (async () => ({ recordset: [], rowsAffected: [0] })),
  };
  return req;
}

function mockPool(request) {
  let _closed = false;
  return {
    request: () => request,
    close: async () => { _closed = true; },
    _closed: () => _closed,
  };
}

// =============================================================================
// testConnection
// =============================================================================

describe("testConnection", () => {
  test("returns ok:true on success", async () => {
    const req = makeRequest({ query: async () => ({ recordset: [{ ok: 1 }], rowsAffected: [0] }) });
    const pool = mockPool(req);
    const d = new MssqlDriver(pool, { database: "test" });
    const result = await d.testConnection();
    assert.strictEqual(result.ok, true);
  });
});

// =============================================================================
// listTables
// =============================================================================

describe("listTables", () => {
  test("returns tables and views", async () => {
    const req = makeRequest({
      query: async () => ({
        recordset: [
          { name: "books", type: "BASE TABLE" },
          { name: "recent_books", type: "VIEW" },
        ],
        rowsAffected: [0],
      }),
    });
    const pool = mockPool(req);
    const d = new MssqlDriver(pool, { database: "test" });
    const tables = await d.listTables();
    assert.strictEqual(tables.length, 2);
    assert.strictEqual(tables[0].name, "books");
    assert.strictEqual(tables[0].type, "table");
    assert.strictEqual(tables[1].name, "recent_books");
    assert.strictEqual(tables[1].type, "view");
  });
});

// =============================================================================
// describeTable
// =============================================================================

describe("describeTable", () => {
  function mkPool(cols = [], pks = [], fks = []) {
    let call = 0;
    const queries = [cols, pks, fks].map((rows) => ({
      recordset: rows,
      rowsAffected: [rows.length],
    }));
    const req = makeRequest({
      query: async () => queries[call++] ?? { recordset: [], rowsAffected: [0] },
    });
    return mockPool(req);
  }

  test("returns columns with metadata", async () => {
    const pool = mkPool(
      [{ COLUMN_NAME: "id", DATA_TYPE: "int", IS_NULLABLE: "NO", COLUMN_DEFAULT: null }],
      [{ COLUMN_NAME: "id" }],
      []
    );
    const d = new MssqlDriver(pool, { database: "test" });
    const info = await d.describeTable("books");
    assert.strictEqual(info.table, "books");
    assert.strictEqual(info.columns[0].name, "id");
    assert.strictEqual(info.columns[0].primaryKey, true);
    assert.strictEqual(info.columns[0].nullable, false);
  });

  test("reports foreign keys", async () => {
    const pool = mkPool(
      [{ COLUMN_NAME: "author_id", DATA_TYPE: "int", IS_NULLABLE: "YES", COLUMN_DEFAULT: null }],
      [],
      [{ col: "author_id", ref_table: "authors", ref_column: "id" }]
    );
    const d = new MssqlDriver(pool, { database: "test" });
    const info = await d.describeTable("books");
    assert.strictEqual(info.foreignKeys.length, 1);
    assert.strictEqual(info.foreignKeys[0].references.table, "authors");
  });

  test("returns null for unknown table", async () => {
    const pool = mkPool([], [], []);
    // Override the first query to return empty
    const req = makeRequest({
      query: async () => ({ recordset: [], rowsAffected: [0] }),
    });
    const d = new MssqlDriver(mockPool(req), { database: "test" });
    const info = await d.describeTable("nope");
    assert.strictEqual(info, null);
  });
});

// =============================================================================
// runRead
// =============================================================================

describe("runRead", () => {
  // Helper: simulate a streaming request with the given on/query behaviour.
  function streamReq({ queryFn, recordsetCols, rowData, doneAfter }) {
    const events = {};
    const req = makeRequest({ query: async () => ({ recordset: [], rowsAffected: [0] }) });
    req.stream = true;
    req.on = (ev, cb) => { events[ev] = cb; return req; };
    req.query = (sql) => {
      // recordset receives column metadata objects keyed by column name
      if (recordsetCols) events.recordset?.(recordsetCols);
      if (rowData) for (const r of rowData) events.row?.(r);
      if (doneAfter !== false) events.done?.();
      if (queryFn) queryFn(sql);
    };
    return { req, events };
  }

  test("caps rows and flags truncated via streaming", async () => {
    // Simulate 15 rows with cap=5 → truncated, cancel called
    const rowData = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, title: `Book ${i + 1}` }));
    let cancelled = false;
    const { req } = streamReq({
      recordsetCols: { id: { name: "id" }, title: { name: "title" } },
      rowData,
    });
    req.cancel = () => { cancelled = true; };

    const d = new MssqlDriver(mockPool(req), { database: "test" });
    const res = await d.runRead("SELECT * FROM books", [], 5);
    assert.strictEqual(res.rowCount, 5);
    assert.strictEqual(res.truncated, true);
    assert.ok(res.columns.includes("id"));
    assert.strictEqual(cancelled, true);
  });

  test("returns all rows when under the cap", async () => {
    const rowData = Array.from({ length: 3 }, (_, i) => ({ id: i + 1 }));
    const { req } = streamReq({
      recordsetCols: { id: { name: "id" } },
      rowData,
    });

    const d = new MssqlDriver(mockPool(req), { database: "test" });
    const res = await d.runRead("SELECT * FROM books", [], 100);
    assert.strictEqual(res.rowCount, 3);
    assert.strictEqual(res.truncated, false);
  });

  test("normalizes buffer values", async () => {
    const { req } = streamReq({
      recordsetCols: { id: { name: "id" }, data: { name: "data" } },
      rowData: [{ id: 1, data: Buffer.from("binary") }],
    });

    const d = new MssqlDriver(mockPool(req), { database: "test" });
    const res = await d.runRead("SELECT * FROM blobs", [], 10);
    assert.strictEqual(res.rows[0].data, "<6 bytes>");
  });
});

// =============================================================================
// runWrite
// =============================================================================

describe("runWrite", () => {
  test("throws on read-only connection", async () => {
    const pool = mockPool(makeRequest());
    const d = new MssqlDriver(pool, { readOnly: true, database: "test" });
    await assert.rejects(
      () => d.runWrite("DELETE FROM books"),
      (err) => err.message.includes("read-only"),
    );
  });

  test("returns rowsAffected on writable connection", async () => {
    const req = makeRequest({
      query: async () => ({ recordset: [], rowsAffected: [3] }),
    });
    const pool = mockPool(req);
    const d = new MssqlDriver(pool, { readOnly: false, database: "test" });
    const res = await d.runWrite("DELETE FROM books");
    assert.strictEqual(res.rowsAffected, 3);
  });

  test("handles array rowsAffected (mssql format)", async () => {
    const req = makeRequest({
      query: async () => ({ recordset: [], rowsAffected: [1, 2] }),
    });
    const pool = mockPool(req);
    const d = new MssqlDriver(pool, { readOnly: false, database: "test" });
    const res = await d.runWrite("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)");
    assert.strictEqual(res.rowsAffected, 3);
  });
});

// =============================================================================
// close
// =============================================================================

describe("close", () => {
  test("calls pool.close", async () => {
    let closed = false;
    const req = makeRequest();
    const pool = { request: () => req, close: async () => { closed = true; } };
    const d = new MssqlDriver(pool, { database: "test" });
    await d.close();
    assert.strictEqual(closed, true);
  });
});
