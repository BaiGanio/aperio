// tests/unit/db/store-surface-parity.test.js
// db/index.js is a factory: it hands callers EITHER a SqliteStore or a
// PostgresStore and every handler downstream is written against "the store".
// So the two prototypes must expose the same public method names. A method
// that exists on one backend and not the other is the storage-layer version of
// the schema drift db/migrations ↔ db/migrations-sqlite is already guarded
// against by tests/unit/db/migration-lockstep.test.js — silent, and only
// discovered at runtime on whichever backend the user happens to run.
//
// This test exists because S3.2 (aperio-reset) splits both store classes into
// per-domain mixin modules. A split that moves a method out of one store but
// not the other would otherwise pass every other suite: the SQLite contract
// tests would stay green, and the Postgres ones only run when
// APERIO_E2E_POSTGRES_URL is set. This assertion needs neither backend
// running — it reads the prototypes — so it runs everywhere, always.
//
// KNOWN_ASYMMETRY is an allowlist, not a waiver: each entry is a method that
// is genuinely backend-specific. Adding to it should be a deliberate act with
// a reason written next to it.

import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../../../db/sqlite.js";
import { PostgresStore } from "../../../db/postgres.js";

// Methods that legitimately exist on one backend only.
const KNOWN_ASYMMETRY = {
  sqlite: [
    // sqlite-vec may be unavailable (no loadable extension) — Postgres either
    // has pgvector or the migrations failed outright, so there is nothing to ask.
    "vectorSupported",
    "rebuiltVectorStores",
    // store.cache compatibility shape; the Postgres store never materialized one.
    "refreshCache",
  ],
  postgres: [
    // Postgres seeds wiki/memory/self/job baselines as a separate step after
    // migrations; SqliteStore.init() does the same work inline.
    "seedBaseline",
  ],
};

// Walks the whole prototype chain, not just the own prototype: S3.2 moved each
// store's per-domain methods onto mixin base classes (db/mixins.js), so an
// own-properties-only check would see a shrinking surface where callers see
// none. What a caller can invoke is the chain, so the chain is what is asserted.
function publicMethodNames(Klass) {
  const names = new Set();
  for (let proto = Klass.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
  }
  names.delete("constructor");
  return [...names].filter((name) => !name.startsWith("_")).sort();
}

test("store surface parity", async (t) => {
  const sqlite = publicMethodNames(SqliteStore);
  const postgres = publicMethodNames(PostgresStore);

  await t.test("every public SqliteStore method exists on PostgresStore", () => {
    const missing = sqlite
      .filter((name) => !postgres.includes(name))
      .filter((name) => !KNOWN_ASYMMETRY.sqlite.includes(name));
    assert.deepEqual(missing, [], `PostgresStore is missing: ${missing.join(", ")}`);
  });

  await t.test("every public PostgresStore method exists on SqliteStore", () => {
    const missing = postgres
      .filter((name) => !sqlite.includes(name))
      .filter((name) => !KNOWN_ASYMMETRY.postgres.includes(name));
    assert.deepEqual(missing, [], `SqliteStore is missing: ${missing.join(", ")}`);
  });

  await t.test("the asymmetry allowlist has no stale entries", () => {
    const stale = [
      ...KNOWN_ASYMMETRY.sqlite.filter((n) => !sqlite.includes(n) || postgres.includes(n)),
      ...KNOWN_ASYMMETRY.postgres.filter((n) => !postgres.includes(n) || sqlite.includes(n)),
    ];
    assert.deepEqual(stale, [], `no longer backend-specific (or gone): ${stale.join(", ")}`);
  });

  // A floor, not an exact count: it fails loud if a split drops a whole
  // domain's methods off BOTH prototypes at once, which the two
  // missing-method checks above cannot see.
  await t.test("the shared surface is not silently shrinking", () => {
    const shared = sqlite.filter((name) => postgres.includes(name));
    assert.ok(
      shared.length >= 74,
      `shared public surface fell to ${shared.length} (expected >= 74) — ` +
      `did a mixin fail to apply to both stores?`
    );
  });
});
