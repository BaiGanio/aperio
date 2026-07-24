// tests/unit/db/migration-lockstep.test.js
// AGENTS.md hard rule: every migration in db/migrations/ needs a mirror in
// db/migrations-sqlite/. Schema drift here is silent and catastrophic, so guard
// the filename lockstep in CI. (issue #283 added 010; this keeps the pair honest.)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pgDir = path.join(root, "db/migrations");
const liteDir = path.join(root, "db/migrations-sqlite");
const sqlNames = (dir) => new Set(readdirSync(dir).filter(f => f.endsWith(".sql")));

describe("migration lockstep", () => {
  test("every Postgres migration has a SQLite mirror and vice versa", () => {
    const pg = sqlNames(pgDir);
    const lite = sqlNames(liteDir);
    const onlyPg = [...pg].filter(f => !lite.has(f));
    const onlyLite = [...lite].filter(f => !pg.has(f));
    assert.deepEqual(onlyPg, [], `migrations missing a SQLite mirror: ${onlyPg.join(", ")}`);
    assert.deepEqual(onlyLite, [], `migrations missing a Postgres mirror: ${onlyLite.join(", ")}`);
  });

  test("010_codegraph_intelligence exists in both backends", () => {
    assert.ok(sqlNames(pgDir).has("010_codegraph_intelligence.sql"));
    assert.ok(sqlNames(liteDir).has("010_codegraph_intelligence.sql"));
  });
});
