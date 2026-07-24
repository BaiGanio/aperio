// audit/tests/database-contract.test.js
// T2 — A14 DB contract gate tests for Aperio Continuous Audit.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runDatabaseContractGate } from "../scripts/contracts/database.js";

const FIXTURE_DIR = resolve("audit/tests/fixtures/inventory-test");
const CONTRACT_SCRIPT = resolve("audit/scripts/contracts/database.js");

// ─── T2.1: Provider matrix detection ───────────────────────────────────────
// (T2.1 is about provider matrices — we use a simplified analog for the DB gate)

function buildContractFixture() {
  const dir = mkdtempSync(join(tmpdir(), "audit-t2-"));
  execSync(`cp -R '${FIXTURE_DIR}/.' "${dir}"`, {
    shell: true, encoding: "utf-8",
  });
  // Add DB structure with parity
  execSync(`mkdir -p "${dir}/db/sqlite" "${dir}/db/postgres" "${dir}/db/migrations" "${dir}/db/migrations-sqlite" "${dir}/tests/integration/db/contract"`, {
    shell: true, encoding: "utf-8",
  });
  const create = (p, c) => { writeFileSync(join(dir, p), c, "utf-8"); };
  create("db/index.js", "// store factory");
  create("db/sqlite.js", "// barrel");
  create("db/postgres.js", "// barrel");
  create("db/sqlite/store.js", "// sqlite store");
  create("db/postgres/store.js", "// postgres store");
  create("db/migrate.js", "// pg migrate");
  create("db/migrate-sqlite.js", "// sqlite migrate");
  create("db/tables.js", "// tables");
  create("db/types.js", "// types");
  create("db/encrypt.js", "// encrypt");
  create("db/sqlite/encryption.js", "// sqlite encrypt");
  create("tests/integration/db/encrypt.test.js", "// encrypt tests");
  create("db/migrations/001_core.sql", "-- pg core");
  create("db/migrations/002_agent_jobs.sql", "-- pg agent");
  create("db/migrations-sqlite/001_core.sql", "-- sqlite core");
  create("db/migrations-sqlite/002_agent_jobs.sql", "-- sqlite agent");
  return dir;
}

function runContract(dir) {
  return JSON.parse(execSync(`node ${CONTRACT_SCRIPT} "${dir}"`, {
    encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
  }));
}

// ─── T2.4: A14 DB contract gate ────────────────────────────────────────────

describe("T2 — DB contract gate", () => {
  describe("T2.4 — A14 DB contract gate", () => {
    test("gate passes with parity fixture", () => {
      const dir = buildContractFixture();
      try {
        const result = runContract(dir);
        assert.ok(result.passed, "Gate should pass with parity fixture");
        assert.equal(result.checks.migration_parity.passed, true);
        assert.equal(result.checks.store_operations.passed, true);
      } finally {
        execSync(`rm -rf "${dir}"`, { shell: true });
      }
    });

    test("gate fails when migrations are asymmetric", () => {
      const dir = buildContractFixture();
      try {
        // Add a migration to Postgres only
        writeFileSync(join(dir, "db", "migrations", "003_pg_only.sql"), "-- pg only", "utf-8");
        const result = runContract(dir);
        assert.equal(result.passed, false, "Gate should fail with asymmetric migrations");
        const migCheck = result.checks.migration_parity.results;
        const hasFailure = migCheck.some(r => !r.passed && r.invariant.includes("count"));
        assert.ok(hasFailure, "Migration count invariant should fail");
      } finally {
        execSync(`rm -rf "${dir}"`, { shell: true });
      }
    });

    test("gate fails when migration file names don't match", () => {
      const dir = buildContractFixture();
      try {
        // Add differently-named migrations to both backends
        writeFileSync(join(dir, "db", "migrations", "003_custom.sql"), "-- pg custom", "utf-8");
        writeFileSync(join(dir, "db", "migrations-sqlite", "003_other.sql"), "-- sqlite other", "utf-8");
        const result = runContract(dir);
        assert.equal(result.passed, false, "Gate should fail with mismatched migration names");
        const nameResult = result.checks.migration_parity.results.find(
          r => r.invariant.includes("mirror")
        );
        assert.ok(nameResult && !nameResult.passed, "Migration name mirror invariant should fail");
      } finally {
        execSync(`rm -rf "${dir}"`, { shell: true });
      }
    });

    test("gate fails when a required store file is missing", () => {
      const dir = buildContractFixture();
      try {
        unlinkSync(join(dir, "db", "sqlite", "store.js"));
        const result = runContract(dir);
        assert.equal(result.passed, false, "Gate should fail with missing SQLite store");
        const storeResult = result.checks.store_operations.results.find(
          r => r.invariant.includes("store")
        );
        assert.ok(storeResult && !storeResult.passed, "Store existence check should fail");
      } finally {
        execSync(`rm -rf "${dir}"`, { shell: true });
      }
    });

    test("gate fails when encryption tests are missing", () => {
      const dir = buildContractFixture();
      try {
        unlinkSync(join(dir, "tests", "integration", "db", "encrypt.test.js"));
        const result = runContract(dir);
        assert.equal(result.passed, false, "Gate should fail without encryption tests");
        const encryptResult = result.checks.store_operations.results.find(
          r => r.invariant.includes("Encryption")
        );
        assert.ok(encryptResult && !encryptResult.passed, "Encryption test check should fail");
      } finally {
        execSync(`rm -rf "${dir}"`, { shell: true });
      }
    });

    test("gate fails when migration runner is missing", () => {
      const dir = buildContractFixture();
      try {
        unlinkSync(join(dir, "db", "migrate.js"));
        const result = runContract(dir);
        assert.equal(result.passed, false, "Gate should fail without migration runner");
      } finally {
        execSync(`rm -rf "${dir}"`, { shell: true });
      }
    });

    test("restoring a deleted file makes the gate pass again", () => {
      const dir = buildContractFixture();
      try {
        // Fail: delete a migration runner
        unlinkSync(join(dir, "db", "migrate.js"));
        const failResult = runContract(dir);
        assert.equal(failResult.passed, false, "Gate should fail after deletion");

        // Restore
        writeFileSync(join(dir, "db", "migrate.js"), "// pg migrate restored", "utf-8");
        const passResult = runContract(dir);
        assert.equal(passResult.passed, true, "Gate should pass after restoration");
      } finally {
        execSync(`rm -rf "${dir}"`, { shell: true });
      }
    });
  });
});
