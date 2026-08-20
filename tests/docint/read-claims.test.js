// Unit tests for read-claims.mjs — the phantom-read check.
//
//   npm run test:docint
//
// Mirrors write-claims.test.js's shape: one true positive (a query against a
// table this run never established), a handful of true negatives that would
// make this the check's own false-failure debut if they fired.

import { test } from "node:test";
import assert from "node:assert/strict";
import { phantomReadClaims } from "./read-claims.mjs";

function queryCall(connection, sql, overrides = {}) {
  return { name: "db_query", ok: true, arguments: { connection, sql }, ...overrides };
}

function createCall(connection, sql, overrides = {}) {
  return { name: "db_execute", ok: true, pending: false, arguments: { connection, sql }, ...overrides };
}

function schemaCall(connection, detail, overrides = {}) {
  return { name: "db_schema", ok: true, arguments: { connection }, detail, ...overrides };
}

test("a query against a table this run never created or discovered is flagged", () => {
  const violations = phantomReadClaims({
    toolCalls: [queryCall("extraction", "SELECT * FROM monthly_spending")],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].table, "monthly_spending");
  assert.equal(violations[0].connection, "extraction");
});

test("a query against a table this run CREATEd is not flagged", () => {
  const violations = phantomReadClaims({
    toolCalls: [
      createCall("extraction", "CREATE TABLE monthly_spending (id INTEGER PRIMARY KEY)"),
      queryCall("extraction", "SELECT * FROM monthly_spending"),
    ],
  });
  assert.equal(violations.length, 0);
});

test("CREATE TABLE IF NOT EXISTS is recognized the same as a bare CREATE TABLE", () => {
  const violations = phantomReadClaims({
    toolCalls: [
      createCall("extraction", "CREATE TABLE IF NOT EXISTS monthly_spending (id INTEGER PRIMARY KEY)"),
      queryCall("extraction", "SELECT * FROM monthly_spending"),
    ],
  });
  assert.equal(violations.length, 0);
});

test("a table legitimately discovered via db_schema on the same connection is not flagged", () => {
  const violations = phantomReadClaims({
    toolCalls: [
      schemaCall("extraction", JSON.stringify({ tables: [{ name: "legacy_import" }] })),
      queryCall("extraction", "SELECT * FROM legacy_import"),
    ],
  });
  assert.equal(violations.length, 0);
});

test("db_schema evidence on a DIFFERENT connection does not vouch for this one", () => {
  const violations = phantomReadClaims({
    toolCalls: [
      schemaCall("other_db", JSON.stringify({ tables: [{ name: "monthly_spending" }] })),
      queryCall("extraction", "SELECT * FROM monthly_spending"),
    ],
  });
  assert.equal(violations.length, 1);
});

test("the built-in aperio connection is excluded outright — memories/wiki always pre-exist", () => {
  const violations = phantomReadClaims({
    toolCalls: [queryCall("aperio", "SELECT * FROM memories WHERE id = ?")],
  });
  assert.equal(violations.length, 0);
});

test("a CTE name is never judged as a phantom table", () => {
  const violations = phantomReadClaims({
    toolCalls: [
      createCall("extraction", "CREATE TABLE monthly_spending (id INTEGER PRIMARY KEY, amount REAL)"),
      queryCall(
        "extraction",
        "WITH totals AS (SELECT SUM(amount) AS s FROM monthly_spending) SELECT * FROM totals",
      ),
    ],
  });
  assert.equal(violations.length, 0);
});

test("a derived subquery in FROM is skipped, not guessed at", () => {
  const violations = phantomReadClaims({
    toolCalls: [
      createCall("extraction", "CREATE TABLE monthly_spending (id INTEGER PRIMARY KEY, amount REAL)"),
      queryCall(
        "extraction",
        "SELECT * FROM (SELECT amount FROM monthly_spending) AS derived",
      ),
    ],
  });
  assert.equal(violations.length, 0);
});

test("a pending (unconfirmed) CREATE TABLE does not count as this run having created the table", () => {
  const violations = phantomReadClaims({
    toolCalls: [
      createCall("extraction", "CREATE TABLE monthly_spending (id INTEGER PRIMARY KEY)", { pending: true }),
      queryCall("extraction", "SELECT * FROM monthly_spending"),
    ],
  });
  assert.equal(violations.length, 1);
});

test("a failed db_query (ok: false) is not evidence of a phantom read", () => {
  const violations = phantomReadClaims({
    toolCalls: [queryCall("extraction", "SELECT * FROM monthly_spending", { ok: false })],
  });
  assert.equal(violations.length, 0);
});

test("a JOINed table is checked the same as a FROM table", () => {
  const violations = phantomReadClaims({
    toolCalls: [
      createCall("extraction", "CREATE TABLE monthly_spending (id INTEGER PRIMARY KEY)"),
      queryCall(
        "extraction",
        "SELECT * FROM monthly_spending JOIN spending_categories ON spending_categories.id = monthly_spending.category_id",
      ),
    ],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].table, "spending_categories");
});

test("multiple documents, real corpus shape: two real tables, one phantom", () => {
  const violations = phantomReadClaims({
    toolCalls: [
      createCall("extraction", "CREATE TABLE monthly_spending (id INTEGER PRIMARY KEY, amount REAL, currency TEXT)"),
      queryCall("aperio", "SELECT * FROM memories WHERE tags LIKE ?"),
      queryCall("extraction", "SELECT currency, SUM(amount) FROM monthly_spending GROUP BY currency"),
      queryCall("extraction", "SELECT * FROM spending_summary_2025"),
    ],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].table, "spending_summary_2025");
});
