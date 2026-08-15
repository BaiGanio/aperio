// audit/scripts/database-contract.js
//
// T2.4 — DB adapter method-parity contract for the continuous-audit program's
// A14 bootstrap vertical (aperio-continuous-audit.md Step 2, T2.4). Compares
// the public instance-method surface of SqliteStore and PostgresStore so an
// adapter drift — one backend silently gaining a capability the other lacks —
// fails a fast, deterministic gate instead of surfacing as a runtime bug on
// whichever backend a given user happens to run.
//
// Parity is based on declared operations, not identical SQL text (T2.4's own
// assertion) — this only compares method NAMES on the two classes' bodies.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Reviewed, intentional adapter asymmetries (Step 2: "Treat current
// asymmetries as questions, not automatic bugs"). Each entry names which
// backend has the method and why the other doesn't need an equivalent.
export const REVIEWED_EXCEPTIONS = {
  refreshCache: {
    backend: "sqlite",
    reason: "SQLite has no cross-process cache to refresh; prunes SqliteStore's own " +
      "process-local settings cache. Postgres callers query live instead.",
  },
  seedBaseline: {
    backend: "postgres",
    reason: "PostgresStore factors baseline-row seeding into a named method called from " +
      "init(); SqliteStore seeds inline inside its own init() transaction blocks (same " +
      "behavior, different shape — see db/sqlite/store.js's init()).",
  },
};

// Matches a class-body method declaration at exactly two-space indent —
// `  name(...) {` or `  async name(...) {` or `  static async name(...) {` —
// so SQL/JS call sites like `tx()` or `SUM(...)` (arbitrary indent, no
// trailing `{`) never match. Both store.js files use consistent 2-space
// class-body indentation.
const METHOD_DECL = /^  (?:static\s+)?(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/gm;

export function publicMethodNames(source) {
  const names = new Set();
  let m;
  METHOD_DECL.lastIndex = 0;
  while ((m = METHOD_DECL.exec(source))) {
    const name = m[1];
    // Private-by-convention (leading underscore) helpers are implementation
    // detail, not part of the cross-backend contract.
    if (name === "constructor" || name.startsWith("_")) continue;
    names.add(name);
  }
  return names;
}

export function diffAdapterMethods(sqliteMethods, postgresMethods, exceptions = REVIEWED_EXCEPTIONS) {
  const sqliteOnly = [...sqliteMethods].filter((m) => !postgresMethods.has(m)).sort();
  const postgresOnly = [...postgresMethods].filter((m) => !sqliteMethods.has(m)).sort();
  const isReviewed = (name, backend) => exceptions[name]?.backend === backend;
  return {
    sqliteOnly,
    postgresOnly,
    unreviewedSqliteOnly: sqliteOnly.filter((m) => !isReviewed(m, "sqlite")),
    unreviewedPostgresOnly: postgresOnly.filter((m) => !isReviewed(m, "postgres")),
  };
}

export function checkAdapterParity({ exceptions = REVIEWED_EXCEPTIONS } = {}) {
  const sqliteSrc = readFileSync(`${ROOT}/db/sqlite/store.js`, "utf8");
  const postgresSrc = readFileSync(`${ROOT}/db/postgres/store.js`, "utf8");
  const diff = diffAdapterMethods(publicMethodNames(sqliteSrc), publicMethodNames(postgresSrc), exceptions);
  return {
    ok: diff.unreviewedSqliteOnly.length === 0 && diff.unreviewedPostgresOnly.length === 0,
    ...diff,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkAdapterParity(), null, 2));
}
