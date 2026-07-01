// tests/handlers/database-confirm.test.js
// Two-phase confirm flow for db_execute, plus db_query read-only gating (#170).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import {
  executeHandler, queryHandler, connectionsHandler,
} from "../../lib/handlers/database/databaseHandlers.js";

let dbPath, ctx;

function makeStore(connections) {
  const settings = new Map([["db.connections", connections]]);
  return {
    getSetting: async (k) => (settings.has(k) ? settings.get(k) : null),
    setSetting: async (k, v) => { settings.set(k, v); return v; },
  };
}

const textOf = (res) => res.content[0].text;

before(() => {
  dbPath = join(tmpdir(), `aperio-confirm-test-${randomBytes(6).toString("hex")}.db`);
  const db = new Database(dbPath);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)");
  db.exec("INSERT INTO t (a) VALUES (1), (2)");
  db.close();
  ctx = { store: makeStore([
    { name: "rw", engine: "sqlite", file: dbPath, readOnly: false },
    { name: "ro", engine: "sqlite", file: dbPath, readOnly: true },
  ]) };
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(dbPath + suffix); } catch { /* ignore */ } }
});

describe("db_connections", () => {
  test("lists built-in aperio + user connections, no secrets", async () => {
    const data = JSON.parse(textOf(await connectionsHandler(ctx, {})));
    const names = data.connections.map((c) => c.name);
    assert.ok(names.includes("aperio"));
    assert.ok(names.includes("rw") && names.includes("ro"));
    assert.ok(data.connections.every((c) => !("password" in c)));
  });
});

describe("db_query gating", () => {
  test("rejects a write statement", async () => {
    const res = await queryHandler(ctx, { connection: "rw", sql: "DELETE FROM t" });
    assert.ok(res.isError);
    assert.match(textOf(res), /only runs read statements/i);
  });
  test("runs a read and returns rows", async () => {
    const data = JSON.parse(textOf(await queryHandler(ctx, { connection: "rw", sql: "SELECT * FROM t ORDER BY id" })));
    assert.equal(data.rowCount, 2);
  });
  test("accepts the statement under a near-miss key (query alias)", async () => {
    // Weak models pass the SQL as `query` instead of `sql`; the handler recovers it.
    const data = JSON.parse(textOf(await queryHandler(ctx, { connection: "rw", query: "SELECT * FROM t ORDER BY id" })));
    assert.equal(data.rowCount, 2);
  });
  test("surfaces a friendly error when no sql is provided", async () => {
    const res = await queryHandler(ctx, { connection: "rw" });
    assert.ok(res.isError);
    assert.match(textOf(res), /`sql` is required/i);
  });
});

describe("db_execute two-phase confirm", () => {
  test("propose returns a db_ token and does NOT write", async () => {
    const res = await executeHandler(ctx, { connection: "rw", sql: "INSERT INTO t (a) VALUES (?)", params: [99] });
    assert.match(textOf(res), /Token:\s*db_[a-z0-9]+/);
    assert.match(textOf(res), /nothing has been written/i);
    // confirm nothing inserted yet
    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare("SELECT COUNT(*) c FROM t").get().c;
    db.close();
    assert.equal(count, 2);
  });

  test("commit with the token performs the write", async () => {
    const propose = await executeHandler(ctx, { connection: "rw", sql: "INSERT INTO t (a) VALUES (?)", params: [99] });
    const token = textOf(propose).match(/Token:\s*(db_[a-z0-9]+)/)[1];
    const commit = await executeHandler(ctx, { confirmation_token: token });
    assert.match(textOf(commit), /✅ Executed/);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT a FROM t WHERE a = 99").get();
    db.close();
    assert.ok(row);
  });

  test("an invalid/expired token is refused", async () => {
    const res = await executeHandler(ctx, { confirmation_token: "db_nope12" });
    assert.ok(res.isError);
    assert.match(textOf(res), /invalid or expired/i);
  });

  test("rejects a read statement", async () => {
    const res = await executeHandler(ctx, { connection: "rw", sql: "SELECT 1" });
    assert.ok(res.isError);
    assert.match(textOf(res), /use db_query/i);
  });

  test("rejects a read-only connection", async () => {
    const res = await executeHandler(ctx, { connection: "ro", sql: "DELETE FROM t" });
    assert.ok(res.isError);
    assert.match(textOf(res), /read-only/i);
  });

  test("rejects a multi-statement batch", async () => {
    const res = await executeHandler(ctx, { connection: "rw", sql: "DELETE FROM t; DROP TABLE t" });
    assert.ok(res.isError);
    assert.match(textOf(res), /ONE statement/i);
  });
});
