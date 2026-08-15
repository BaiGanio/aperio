// T2.4 — audit/scripts/database-contract.js (aperio-continuous-audit-tests.md, T2.4).
//
// Verify-first proof for the DB adapter method-parity gate: a fixture adapter
// missing a method fails and names it (T2.4's own input/setup), a reviewed
// exception passes, and — separately — today's real adapters are checked and
// their known asymmetries are pinned so a THIRD, unreviewed asymmetry would
// be caught by this same suite.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  publicMethodNames, diffAdapterMethods, checkAdapterParity, REVIEWED_EXCEPTIONS,
} from "../scripts/database-contract.js";

describe("audit/scripts/database-contract.js", () => {
  test("publicMethodNames extracts class-body methods, not call sites or private helpers", () => {
    const src = `
class Fixture {
  constructor(db) {}
  async insert(x) {
    const tx = this.db.transaction(() => {
      SUM(x);
    });
    tx();
  }
  _privateHelper() { return 1; }
  static async init() { return new Fixture(); }
}`;
    const names = publicMethodNames(src);
    assert.deepStrictEqual([...names].sort(), ["init", "insert"]);
  });

  test("T2.4 — a fixture adapter missing a required method fails and names it", () => {
    const sqlite = new Set(["insert", "getById", "delete", "close"]);
    const postgres = new Set(["insert", "getById", "close"]); // missing "delete"
    const diff = diffAdapterMethods(sqlite, postgres, {});
    assert.deepStrictEqual(diff.unreviewedSqliteOnly, ["delete"]);
    assert.deepStrictEqual(diff.unreviewedPostgresOnly, []);
  });

  test("T2.4 — a reviewed exception passes even though the sets differ", () => {
    const sqlite = new Set(["insert", "refreshCache"]);
    const postgres = new Set(["insert"]);
    const diff = diffAdapterMethods(sqlite, postgres, {
      refreshCache: { backend: "sqlite", reason: "test fixture exception" },
    });
    assert.deepStrictEqual(diff.sqliteOnly, ["refreshCache"]);
    assert.deepStrictEqual(diff.unreviewedSqliteOnly, [], "a reviewed exception must not fail the gate");
  });

  test("T5.1 red/green proof — an unreviewed asymmetry fails; removing the exception entry " +
    "for the same asymmetry flips it back to failing (mutate the fixture input, not real files)", () => {
    const sqlite = new Set(["insert", "onlyOnSqlite"]);
    const postgres = new Set(["insert"]);

    const red = diffAdapterMethods(sqlite, postgres, {});
    assert.deepStrictEqual(red.unreviewedSqliteOnly, ["onlyOnSqlite"], "should fail before it's reviewed");

    const green = diffAdapterMethods(sqlite, postgres, {
      onlyOnSqlite: { backend: "sqlite", reason: "test fixture exception" },
    });
    assert.deepStrictEqual(green.unreviewedSqliteOnly, [], "should pass once reviewed");

    const redAgain = diffAdapterMethods(sqlite, postgres, {});
    assert.deepStrictEqual(redAgain.unreviewedSqliteOnly, ["onlyOnSqlite"], "removing the review must fail again");
  });

  test("current real state — today's SqliteStore/PostgresStore reconcile under the reviewed-exception list", () => {
    const result = checkAdapterParity();
    assert.strictEqual(result.ok, true, `unreviewed drift: ${JSON.stringify({
      sqliteOnly: result.unreviewedSqliteOnly, postgresOnly: result.unreviewedPostgresOnly,
    })}`);
    // Pin exactly today's two reviewed asymmetries, so a THIRD one appearing
    // in either sqliteOnly/postgresOnly (reviewed or not) is visible here —
    // this is the "detects drift" half of the gate, not just "passes today."
    assert.deepStrictEqual(result.sqliteOnly, ["refreshCache"]);
    assert.deepStrictEqual(result.postgresOnly, ["seedBaseline"]);
    assert.deepStrictEqual(Object.keys(REVIEWED_EXCEPTIONS).sort(), ["refreshCache", "seedBaseline"]);
  });
});
