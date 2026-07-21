// tests/db-connect/sqlite-driver.test.js
// SQLite driver: introspection, read row-cap, read-only enforcement (issue #170).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { SqliteDriver, openSqlite } from "../../../lib/db-connect/drivers/sqlite.js";

let dbPath;

before(() => {
  dbPath = join(tmpdir(), `aperio-driver-test-${randomBytes(6).toString("hex")}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      author_id INTEGER REFERENCES authors(id)
    );
    CREATE INDEX idx_books_title ON books(title);
    CREATE VIEW recent_books AS SELECT * FROM books;
  `);
  const ins = db.prepare("INSERT INTO books (title, author_id) VALUES (?, ?)");
  for (let i = 0; i < 10; i++) ins.run(`Book ${i}`, null);
  db.close();
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(dbPath + suffix); } catch { /* ignore */ }
  }
});

describe("SqliteDriver introspection", () => {
  test("listTables returns tables and views, hides sqlite_ internals", () => {
    const d = openSqlite({ file: dbPath, readOnly: true });
    const names = d.listTables();
    d.close();
    const byName = Object.fromEntries(names.map((t) => [t.name, t.type]));
    assert.equal(byName.authors, "table");
    assert.equal(byName.books, "table");
    assert.equal(byName.recent_books, "view");
    assert.ok(!names.some((t) => t.name.startsWith("sqlite_")));
  });

  test("describeTable reports columns, pk, fk, and index", () => {
    const d = openSqlite({ file: dbPath, readOnly: true });
    const info = d.describeTable("books");
    d.close();
    const cols = Object.fromEntries(info.columns.map((c) => [c.name, c]));
    assert.equal(cols.id.primaryKey, true);
    assert.equal(cols.title.nullable, false);
    assert.equal(cols.author_id.nullable, true);
    assert.deepEqual(info.foreignKeys[0].references, { table: "authors", column: "id" });
    assert.ok(info.indexes.some((i) => i.columns.includes("title")));
  });

  test("describeTable is case-insensitive and returns null for unknown", () => {
    const d = openSqlite({ file: dbPath, readOnly: true });
    assert.equal(d.describeTable("BOOKS").table, "books");
    assert.equal(d.describeTable("nope"), null);
    d.close();
  });
});

describe("SqliteDriver reads", () => {
  test("runRead caps rows and flags truncated", () => {
    const d = openSqlite({ file: dbPath, readOnly: true });
    const res = d.runRead("SELECT * FROM books", [], 5);
    d.close();
    assert.equal(res.rowCount, 5);
    assert.equal(res.truncated, true);
    assert.ok(res.columns.includes("title"));
  });

  test("runRead returns all rows when under the cap", () => {
    const d = openSqlite({ file: dbPath, readOnly: true });
    const res = d.runRead("SELECT * FROM books", [], 100);
    d.close();
    assert.equal(res.rowCount, 10);
    assert.equal(res.truncated, false);
  });

  test("runRead binds positional params", () => {
    const d = openSqlite({ file: dbPath, readOnly: true });
    const res = d.runRead("SELECT * FROM books WHERE title = ?", ["Book 3"], 10);
    d.close();
    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0].title, "Book 3");
  });
});

describe("SqliteDriver read-only enforcement", () => {
  test("runWrite throws on a read-only connection", () => {
    const d = openSqlite({ file: dbPath, readOnly: true });
    assert.throws(() => d.runWrite("DELETE FROM books"), /read-only/);
    d.close();
  });

  test("read-only connection cannot mutate even if runWrite is bypassed", () => {
    const d = openSqlite({ file: dbPath, readOnly: true });
    // better-sqlite3 opened read-only rejects writes at the SQLite level too.
    assert.throws(() => d.db.prepare("DELETE FROM books").run(), /readonly|read-only/i);
    d.close();
  });

  test("a writable driver can insert and reports rowsAffected", () => {
    const d = new SqliteDriver(new Database(dbPath), { readOnly: false, ownsHandle: true });
    const res = d.runWrite("INSERT INTO authors (name) VALUES (?)", ["Ursula"]);
    assert.equal(res.rowsAffected, 1);
    assert.ok(res.lastInsertRowid > 0);
    d.runWrite("DELETE FROM authors WHERE name = ?", ["Ursula"]); // cleanup
    d.close();
  });
});
