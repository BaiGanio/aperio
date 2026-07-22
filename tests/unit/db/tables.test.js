// tests/db/tables.test.js
// INJECTION-01 — table names can't be SQL-parameterized, so readTable()/the DB
// browser interpolate `name` directly. The only thing standing between that and
// SQL injection is the isAllowedTable() whitelist. Lock it down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DB_TABLES, isAllowedTable } from "../../../db/tables.js";

describe("isAllowedTable whitelist", () => {
  test("accepts every advertised browser table", () => {
    for (const { name } of DB_TABLES) assert.equal(isAllowedTable(name), true);
  });

  test("rejects injection payloads", () => {
    for (const bad of [
      "memories; DROP TABLE memories",
      "memories--",
      "memories WHERE 1=1",
      "pg_catalog.pg_user",
      "'; DELETE FROM memories; --",
    ]) assert.equal(isAllowedTable(bad), false, `should reject: ${bad}`);
  });

  test("rejects internal/plumbing tables not meant for the browser", () => {
    for (const internal of ["schema_migrations", "vec_memories", "settings_fts"])
      assert.equal(isAllowedTable(internal), false);
  });

  test("rejects empty / non-string input", () => {
    assert.equal(isAllowedTable(""), false);
    assert.equal(isAllowedTable(undefined), false);
    assert.equal(isAllowedTable(null), false);
  });
});
