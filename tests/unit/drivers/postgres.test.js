// tests/db-connect/drivers/postgres.test.js
// Postgres driver: introspection, read row-cap, read-only enforcement.
// Uses a mock pg.Pool — no real Postgres connection required.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PostgresDriver } from "../../../lib/db-connect/drivers/postgres.js";

// ─── Mock pool factories ─────────────────────────────────────────────────────

function mockClient(queries = []) {
  const released = [];
  return {
    query: (...args) => {
      queries.push(args);
      return { rows: [], fields: [] };
    },
    release: () => { released.push(true); },
    _released: released,
  };
}

function mockPool(overrides = {}) {
  let _ended = false;
  const queries = [];
  return {
    query: overrides.query ?? (async (...args) => {
      queries.push(args);
      return { rows: [], fields: [] };
    }),
    connect: overrides.connect ?? (async () => mockClient(queries)),
    end: overrides.end ?? (async () => { _ended = true; }),
    _queries: queries,
    _ended: () => _ended,
  };
}

function makeResult(rows, fields = []) {
  // fields is either an array of field-descriptor objects or of field-name strings
  const fld = fields.map((f) => (typeof f === "string" ? { name: f } : f));
  return { rows, fields: fld, rowCount: rows.length };
}

// =============================================================================
// testConnection
// =============================================================================

describe("testConnection", () => {
  test("returns ok:true on success", async () => {
    const pool = mockPool({ query: async () => makeResult([{ "?column?": 1 }]) });
    const d = new PostgresDriver(pool);
    const result = await d.testConnection();
    assert.strictEqual(result.ok, true);
  });
});

// =============================================================================
// listTables
// =============================================================================

describe("listTables", () => {
  test("returns tables and views", async () => {
    const pool = mockPool({
      query: async () => makeResult([
        { name: "books", schema: "public", type: "BASE TABLE" },
        { name: "recent_books", schema: "public", type: "VIEW" },
      ]),
    });
    const d = new PostgresDriver(pool);
    const tables = await d.listTables();
    assert.strictEqual(tables.length, 2);
    assert.strictEqual(tables[0].name, "books");
    assert.strictEqual(tables[0].type, "table");
    assert.strictEqual(tables[1].name, "recent_books");
    assert.strictEqual(tables[1].type, "view");
  });

  // Note: The WHERE table_schema NOT IN (...) filtering is SQL-level and
  // not exercised by mock-based tests (the mock bypasses actual query execution).
});

// =============================================================================
// describeTable
// =============================================================================

describe("describeTable", () => {
  function mkPool(columnRows = [], pkRows = [], fkRows = [], idxRows = []) {
    let call = 0;
    return mockPool({
      query: async () => {
        const r = [columnRows, pkRows, fkRows, idxRows][call++] ?? [];
        return makeResult(r);
      },
    });
  }

  test("returns columns with metadata", async () => {
    const pool = mkPool(
      [{ column_name: "id", data_type: "integer", is_nullable: "NO", column_default: "nextval(...)" }],
      [{ column_name: "id" }],
      [],
      []
    );
    const d = new PostgresDriver(pool);
    const info = await d.describeTable("books");
    assert.strictEqual(info.table, "books");
    assert.strictEqual(info.columns[0].name, "id");
    assert.strictEqual(info.columns[0].primaryKey, true);
    assert.strictEqual(info.columns[0].nullable, false);
  });

  test("reports foreign keys", async () => {
    const pool = mkPool(
      [{ column_name: "author_id", data_type: "integer", is_nullable: "YES", column_default: null }],
      [],
      [{ column: "author_id", ref_table: "authors", ref_column: "id" }],
      []
    );
    const d = new PostgresDriver(pool);
    const info = await d.describeTable("books");
    assert.strictEqual(info.foreignKeys.length, 1);
    assert.strictEqual(info.foreignKeys[0].column, "author_id");
    assert.deepStrictEqual(info.foreignKeys[0].references, { table: "authors", column: "id" });
  });

  test("reports indexes", async () => {
    const pool = mkPool(
      [{ column_name: "title", data_type: "text", is_nullable: "YES", column_default: null }],
      [],
      [],
      [{ name: "idx_books_title", def: "CREATE INDEX idx_books_title ON books(title)" }]
    );
    const d = new PostgresDriver(pool);
    const info = await d.describeTable("books");
    assert.strictEqual(info.indexes.length, 1);
    assert.strictEqual(info.indexes[0].name, "idx_books_title");
  });

  test("returns null for unknown table", async () => {
    const pool = mockPool({ query: async () => makeResult([]) });
    const d = new PostgresDriver(pool);
    const info = await d.describeTable("nope");
    assert.strictEqual(info, null);
  });
});

// =============================================================================
// runRead
// =============================================================================

describe("runRead", () => {
  function makeReadPool(clientQueryImpl) {
    const defaultQuery = async (...args) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
      // FETCH returns the rows
      if (sql?.includes("FETCH")) return makeResult(
        Array.from({ length: 15 }, (_, i) => ({ id: i + 1, title: `Book ${i + 1}` })),
        ["id", "title"]
      );
      return makeResult([]);
    };
    return {
      _queries: [],
      _ended: () => false,
      query: defaultQuery,
      connect: async () => ({
        query: clientQueryImpl ?? defaultQuery,
        release: () => {},
      }),
      end: async () => {},
    };
  }

  test("caps rows and flags truncated", async () => {
    const d = new PostgresDriver(makeReadPool());
    const res = await d.runRead("SELECT * FROM books", [], 5);
    assert.strictEqual(res.rowCount, 5);
    assert.strictEqual(res.truncated, true);
    assert.ok(res.columns.includes("id"));
  });

  test("returns all rows when under the cap", async () => {
    const d = new PostgresDriver(makeReadPool());
    const res = await d.runRead("SELECT * FROM books", [], 100);
    assert.strictEqual(res.rowCount, 15);
    assert.strictEqual(res.truncated, false);
  });

  test("normalizes buffer values", async () => {
    const pool = {
      _queries: [],
      _ended: () => false,
      query: async () => makeResult([]),
      connect: async () => ({
        query: async (...args) => {
          const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
          if (sql?.includes("FETCH")) return makeResult(
            [{ id: 1, data: Buffer.from("binary") }],
            [{ name: "id" }, { name: "data" }]
          );
          return makeResult([]);
        },
        release: () => {},
      }),
      end: async () => {},
    };
    const d = new PostgresDriver(pool);
    const res = await d.runRead("SELECT * FROM blobs", [], 10);
    assert.strictEqual(res.rows[0].data, "<6 bytes>");
  });
});

// =============================================================================
// runWrite
// =============================================================================

describe("runWrite", () => {
  test("throws on read-only connection", async () => {
    const pool = mockPool();
    const d = new PostgresDriver(pool, { readOnly: true });
    await assert.rejects(
      () => d.runWrite("DELETE FROM books"),
      (err) => err.message.includes("read-only"),
    );
  });

  test("returns rowsAffected on writable connection", async () => {
    // runWrite calls pool.connect() then client.query({ text, values })
    let clientQueryRes = { rowCount: 3 };
    const pool = mockPool({
      connect: async () => ({
        query: async () => clientQueryRes,
        release: () => {},
      }),
    });
    const d = new PostgresDriver(pool, { readOnly: false });
    const res = await d.runWrite("DELETE FROM books");
    assert.strictEqual(res.rowsAffected, 3);
  });
});

// =============================================================================
// close
// =============================================================================

describe("close", () => {
  test("calls pool.end when ownsPool is true", async () => {
    let ended = false;
    const pool = mockPool({ end: async () => { ended = true; } });
    const d = new PostgresDriver(pool, { ownsPool: true });
    await d.close();
    assert.strictEqual(ended, true);
  });

  test("does not call pool.end when ownsPool is false", async () => {
    let ended = false;
    const pool = mockPool({ end: async () => { ended = true; } });
    const d = new PostgresDriver(pool, { ownsPool: false });
    await d.close();
    assert.strictEqual(ended, false);
  });
});
