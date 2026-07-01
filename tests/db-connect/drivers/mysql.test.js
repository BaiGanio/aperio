// tests/db-connect/drivers/mysql.test.js
// MySQL driver: introspection, read row-cap, read-only enforcement.
// Uses a mock mysql2/promise pool — no real MySQL connection required.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MysqlDriver } from "../../../lib/db-connect/drivers/mysql.js";

// ─── Mock pool factories ─────────────────────────────────────────────────────

function mockConnection(queries = []) {
  return {
    query: (...args) => {
      queries.push(args);
      return [[], []];
    },
    release: () => {},
    _queries: queries,
  };
}

function mockPool(overrides = {}) {
  let _ended = false;
  const queries = [];
  return {
    query: overrides.query ?? (async (...args) => {
      queries.push(args);
      return [[], []];
    }),
    getConnection: overrides.getConnection ?? (async () => mockConnection(queries)),
    end: overrides.end ?? (async () => { _ended = true; }),
    _queries: queries,
    _ended: () => _ended,
  };
}

// Helper: simulate mysql2 result format [rows, fields]
function fmt(rows, fieldNames = []) {
  return [rows, fieldNames.map((n) => ({ name: n }))];
}

// =============================================================================
// testConnection
// =============================================================================

describe("testConnection", () => {
  test("returns ok:true on success", async () => {
    const pool = mockPool({
      getConnection: async () => ({
        query: async () => [[{ 1: 1 }], []],
        release: () => {},
      }),
    });
    const d = new MysqlDriver(pool, { database: "test" });
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
      query: async () => fmt([
        { table_name: "books", type: "BASE TABLE" },
        { table_name: "recent_books", type: "VIEW" },
      ]),
    });
    const d = new MysqlDriver(pool, { database: "test" });
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
  function mkPool(columns = [], fks = [], idxs = []) {
    let call = 0;
    return mockPool({
      query: async () => {
        const sets = [fmt(columns), fmt(fks), fmt(idxs)];
        return sets[call++] ?? fmt([]);
      },
    });
  }

  test("returns columns with metadata", async () => {
    const pool = mkPool(
      [{ column_name: "id", data_type: "int", is_nullable: "NO", column_default: null, column_key: "PRI" }],
      [],
      []
    );
    const d = new MysqlDriver(pool, { database: "test" });
    const info = await d.describeTable("books");
    assert.strictEqual(info.table, "books");
    assert.strictEqual(info.columns[0].name, "id");
    assert.strictEqual(info.columns[0].primaryKey, true);
    assert.strictEqual(info.columns[0].nullable, false);
  });

  test("reports foreign keys", async () => {
    const pool = mkPool(
      [{ column_name: "author_id", data_type: "int", is_nullable: "YES", column_default: null, column_key: "" }],
      [{ col: "author_id", ref_table: "authors", ref_column: "id" }],
      []
    );
    const d = new MysqlDriver(pool, { database: "test" });
    const info = await d.describeTable("books");
    assert.strictEqual(info.foreignKeys.length, 1);
    assert.strictEqual(info.foreignKeys[0].references.table, "authors");
  });

  test("returns null for unknown table", async () => {
    const pool = mockPool({ query: async () => fmt([]) });
    const d = new MysqlDriver(pool, { database: "test" });
    const info = await d.describeTable("nope");
    assert.strictEqual(info, null);
  });
});

// =============================================================================
// runRead
// =============================================================================

describe("runRead", () => {
  function mkRowPool(rows, fieldNames = []) {
    let connQ;
    return mockPool({
      getConnection: async () => {
        connQ = async (arg) => {
          // runRead calls conn.query("START TRANSACTION READ ONLY") first
          // (string), then conn.query({ sql, rowsAsArray }, params) (object).
          // Return empty arrays for the string call; return data for the object call.
          if (typeof arg === "string") return [[], []];
          const sql = arg?.sql ?? "";
          if (sql.includes("_aperio_sub")) return fmt(rows, fieldNames);
          return fmt(rows, fieldNames);
        };
        return { query: connQ, release: () => {}, _queries: [] };
      },
    });
  }

  test("caps rows and flags truncated", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, title: `Book ${i + 1}` }));
    const d = new MysqlDriver(mkRowPool(rows, ["id", "title"]), { database: "test" });
    const res = await d.runRead("SELECT * FROM books", [], 5);
    assert.strictEqual(res.rowCount, 5);
    assert.strictEqual(res.truncated, true);
    assert.ok(res.columns.includes("id"));
  });

  test("returns all rows when under the cap", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: i + 1 }));
    const d = new MysqlDriver(mkRowPool(rows, ["id"]), { database: "test" });
    const res = await d.runRead("SELECT * FROM books", [], 100);
    assert.strictEqual(res.rowCount, 8);
    assert.strictEqual(res.truncated, false);
  });

  test("normalizes buffer values", async () => {
    const pool = {
      _queries: [],
      _ended: () => false,
      getConnection: async () => ({
        query: async () => [[{ id: 1, data: Buffer.from("blob") }], [{ name: "id" }, { name: "data" }]],
        release: () => {},
      }),
      end: async () => {},
    };
    const d = new MysqlDriver(pool, { database: "test" });
    const res = await d.runRead("SELECT * FROM blobs", [], 10);
    assert.strictEqual(res.rows[0].data, "<4 bytes>");
  });
});

// =============================================================================
// runWrite
// =============================================================================

describe("runWrite", () => {
  test("throws on read-only connection", async () => {
    const pool = mockPool();
    const d = new MysqlDriver(pool, { readOnly: true, database: "test" });
    await assert.rejects(
      () => d.runWrite("DELETE FROM books"),
      (err) => err.message.includes("read-only"),
    );
  });

  test("returns rowsAffected on writable connection", async () => {
    const pool = mockPool({
      query: async () => [{ affectedRows: 5, insertId: null }],
    });
    const d = new MysqlDriver(pool, { readOnly: false, database: "test" });
    const res = await d.runWrite("UPDATE books SET title='x'");
    assert.strictEqual(res.rowsAffected, 5);
  });

  test("returns insertId when available", async () => {
    const pool = mockPool({
      query: async () => [{ affectedRows: 1, insertId: 42 }],
    });
    const d = new MysqlDriver(pool, { readOnly: false, database: "test" });
    const res = await d.runWrite("INSERT INTO books (title) VALUES ('new')");
    assert.strictEqual(res.rowsAffected, 1);
    assert.strictEqual(res.insertId, 42);
  });
});

// =============================================================================
// close
// =============================================================================

describe("close", () => {
  test("calls pool.end", async () => {
    let ended = false;
    const pool = mockPool({ end: async () => { ended = true; } });
    const d = new MysqlDriver(pool, { database: "test" });
    await d.close();
    assert.strictEqual(ended, true);
  });
});
