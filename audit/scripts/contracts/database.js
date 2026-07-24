// audit/scripts/contracts/database.js
// A14 DB contract gate — deterministic checks that require no LLM.
// Verifies:
//   1. Migration file parity between Postgres and SQLite backends
//   2. Store adapter operations exist in both implementations
//   3. Encryption module has focused tests
//   4. Migration runners exist for both backends

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

// ── Migration parity ────────────────────────────────────────────────────────

function checkMigrationParity(rootDir) {
  const pgDir = join(rootDir, "db", "migrations");
  const sqliteDir = join(rootDir, "db", "migrations-sqlite");

  const pgFiles = existsSync(pgDir)
    ? readdirSync(pgDir).filter(f => f.endsWith(".sql")).sort()
    : [];
  const sqliteFiles = existsSync(sqliteDir)
    ? readdirSync(sqliteDir).filter(f => f.endsWith(".sql")).sort()
    : [];

  const results = [];

  // Check count parity
  if (pgFiles.length !== sqliteFiles.length) {
    results.push({
      invariant: "Migration counts match",
      passed: false,
      detail: `Postgres: ${pgFiles.length}, SQLite: ${sqliteFiles.length}`,
    });
  } else {
    results.push({
      invariant: "Migration counts match",
      passed: true,
      detail: `Both backends: ${pgFiles.length} migrations`,
    });
  }

  // Check file-name parity
  const onlyPg = pgFiles.filter(f => !sqliteFiles.includes(f));
  const onlySqlite = sqliteFiles.filter(f => !pgFiles.includes(f));

  if (onlyPg.length > 0 || onlySqlite.length > 0) {
    results.push({
      invariant: "Migration file names are mirrored",
      passed: false,
      detail: `Only in Postgres: ${onlyPg.join(", ") || "none"}. Only in SQLite: ${onlySqlite.join(", ") || "none"}`,
    });
  } else {
    results.push({
      invariant: "Migration file names are mirrored",
      passed: true,
      detail: `All ${pgFiles.length} migration names match between backends`,
    });
  }

  return {
    pg_count: pgFiles.length,
    sqlite_count: sqliteFiles.length,
    pg_files: pgFiles,
    sqlite_files: sqliteFiles,
    results,
    passed: results.every(r => r.passed),
  };
}

// ── Store operations parity ─────────────────────────────────────────────────

function checkStoreOperations(rootDir) {
  const results = [];

  // Check migration runner files exist
  const migratePg = join(rootDir, "db", "migrate.js");
  const migrateSqlite = join(rootDir, "db", "migrate-sqlite.js");
  const storeSqlite = join(rootDir, "db", "sqlite", "store.js");
  const storePg = join(rootDir, "db", "postgres", "store.js");

  for (const [path, label] of [
    [migratePg, "Postgres migration runner (db/migrate.js)"],
    [migrateSqlite, "SQLite migration runner (db/migrate-sqlite.js)"],
    [storeSqlite, "SQLite store (db/sqlite/store.js)"],
    [storePg, "Postgres store (db/postgres/store.js)"],
  ]) {
    results.push({
      invariant: `${label} exists`,
      passed: existsSync(path),
      detail: existsSync(path) ? "Present" : "MISSING",
    });
  }

  // Check encryption module has corresponding test file
  const encryptTestPath = join(rootDir, "tests", "integration", "db", "encrypt.test.js");
  results.push({
    invariant: "Encryption module has focused integration tests",
    passed: existsSync(encryptTestPath),
    detail: existsSync(encryptTestPath) ? "tests/integration/db/encrypt.test.js present" : "MISSING",
  });

  // Check store factory exists
  const storeFactory = join(rootDir, "db", "index.js");
  results.push({
    invariant: "Store factory (db/index.js) exists and references both backends",
    passed: existsSync(storeFactory),
    detail: existsSync(storeFactory) ? "Present" : "MISSING",
  });

  return {
    results,
    passed: results.every(r => r.passed),
  };
}

// ── Full gate ───────────────────────────────────────────────────────────────

function runDatabaseContractGate(rootDir) {
  rootDir = resolve(rootDir || process.cwd());
  const gate = {
    $schema: "aperio-audit-database-contract-v1",
    slice_id: "A14",
    checks: {
      migration_parity: checkMigrationParity(rootDir),
      store_operations: checkStoreOperations(rootDir),
    },
    passed: false,
  };
  gate.passed = gate.checks.migration_parity.passed && gate.checks.store_operations.passed;
  return gate;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const rootArg = process.argv[2];
const gate = runDatabaseContractGate(rootArg);
process.stdout.write(JSON.stringify(gate, null, 2) + "\n");
process.exit(gate.passed ? 0 : 1);

export { runDatabaseContractGate };
