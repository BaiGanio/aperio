// tests/db-connect/classify.test.js
// Exhaustive tests for the SQL statement classifier (issue #170).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  classify, splitStatements, isAllowedForQuery, isAllowedForExecute,
} from "../../../lib/db-connect/classify.js";

const cls = (sql) => classify(sql).class;

describe("classify — reads", () => {
  for (const sql of [
    "SELECT * FROM users",
    "  select 1",
    "SELECT * FROM t WHERE name = 'a;b'",        // ';' inside a string literal
    "WITH t AS (SELECT 1) SELECT * FROM t",      // plain CTE
    "EXPLAIN SELECT * FROM users",
    "EXPLAIN QUERY PLAN SELECT 1",
    "PRAGMA table_info(users)",
    "SHOW TABLES",
    "DESCRIBE users",
    "VALUES (1), (2)",
    "(SELECT 1)",                                // leading paren
  ]) {
    test(`read: ${sql}`, () => assert.equal(cls(sql), "read"));
  }
});

describe("classify — writes", () => {
  for (const sql of [
    "INSERT INTO t (a) VALUES (1)",
    "update t set a = 1 where id = 2",
    "DELETE FROM t WHERE id = 1",
    "REPLACE INTO t (a) VALUES (1)",
    "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET a = 1",
  ]) {
    test(`write: ${sql}`, () => assert.equal(cls(sql), "write"));
  }

  test("data-modifying CTE escalates to write", () => {
    assert.equal(cls("WITH d AS (DELETE FROM t RETURNING id) SELECT * FROM d"), "write");
  });
  test("EXPLAIN ANALYZE of a DML escalates to write", () => {
    assert.equal(cls("EXPLAIN ANALYZE INSERT INTO t (a) VALUES (1)"), "write");
  });
});

describe("classify — DDL", () => {
  for (const sql of [
    "CREATE TABLE t (id INT)",
    "ALTER TABLE t ADD COLUMN b INT",
    "DROP TABLE t",
    "TRUNCATE TABLE t",
    "CREATE INDEX idx ON t (a)",
  ]) {
    test(`ddl: ${sql}`, () => assert.equal(cls(sql), "ddl"));
  }
});

describe("classify — multi-statement", () => {
  for (const sql of [
    "SELECT 1; SELECT 2",
    "INSERT INTO t (a) VALUES (1); DELETE FROM t",
    "DROP TABLE a; DROP TABLE b",
  ]) {
    test(`multi: ${sql}`, () => assert.equal(cls(sql), "multi"));
  }

  test("trailing semicolon is NOT multi", () => {
    assert.equal(cls("SELECT 1;"), "read");
    assert.equal(cls("DELETE FROM t;  "), "write");
  });
  test("semicolon inside a string literal is NOT a boundary", () => {
    assert.equal(cls("SELECT * FROM t WHERE s = 'a; b; c'"), "read");
    assert.equal(cls("INSERT INTO t (a) VALUES ('x;y')"), "write");
  });
  test("semicolon inside a comment is NOT a boundary", () => {
    assert.equal(cls("SELECT 1 -- a; b\n"), "read");
    assert.equal(cls("SELECT 1 /* a; b */"), "read");
  });
});

describe("classify — unknown / empty", () => {
  for (const sql of ["", "   ", "-- just a comment", "/* x */", "BANANA foo", "BEGIN"]) {
    test(`unknown: ${JSON.stringify(sql)}`, () => assert.equal(cls(sql), "unknown"));
  }
  test("null/undefined are unknown", () => {
    assert.equal(cls(null), "unknown");
    assert.equal(cls(undefined), "unknown");
  });
});

describe("comment stripping", () => {
  test("line comment is removed, keyword still found", () => {
    assert.equal(cls("-- header\nSELECT 1"), "read");
  });
  test("# comment (MySQL) is removed", () => {
    assert.equal(cls("# note\nUPDATE t SET a = 1"), "write");
  });
  test("block comment before the keyword", () => {
    assert.equal(cls("/* lead */ DROP TABLE t"), "ddl");
  });
  test("comment markers inside a string survive", () => {
    const stmts = splitStatements("SELECT '-- not a comment', '/* nor this */'");
    assert.equal(stmts.length, 1);
    assert.match(stmts[0], /not a comment/);
  });
});

describe("gate helpers", () => {
  test("isAllowedForQuery only passes reads", () => {
    assert.equal(isAllowedForQuery("SELECT 1"), true);
    assert.equal(isAllowedForQuery("DELETE FROM t"), false);
    assert.equal(isAllowedForQuery("SELECT 1; SELECT 2"), false);
  });
  test("isAllowedForExecute passes write + ddl, rejects read/multi/unknown", () => {
    assert.equal(isAllowedForExecute("INSERT INTO t (a) VALUES (1)"), true);
    assert.equal(isAllowedForExecute("DROP TABLE t"), true);
    assert.equal(isAllowedForExecute("SELECT 1"), false);
    assert.equal(isAllowedForExecute("DELETE FROM a; DELETE FROM b"), false);
    assert.equal(isAllowedForExecute("BANANA"), false);
  });
});
