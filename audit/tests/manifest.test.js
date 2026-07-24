// audit/tests/manifest.test.js
// T4 — Evidence packet tests for Aperio Continuous Audit.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const MANIFEST_SCRIPT = resolve("audit/scripts/manifest.js");
const FIXTURE_DIR = resolve("audit/tests/fixtures/inventory-test");

function runManifest(sliceId, targetDir) {
  const args = [MANIFEST_SCRIPT, sliceId];
  if (targetDir) args.push(targetDir);
  const result = execSync(`node ${args.join(" ")}`, {
    cwd: process.cwd(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(result);
}

// ─── T4.1: Manifest stability ──────────────────────────────────────────────

describe("T4 — Evidence packet", () => {
  describe("T4.1 — Manifest stability", () => {
    test("two runs produce identical aggregate hash", () => {
      const m1 = runManifest("A14");
      const m2 = runManifest("A14");
      assert.equal(m1.aggregate_hash, m2.aggregate_hash,
        "Aggregate hash changed between runs on the same tree");
    });

    test("manifest has required top-level fields", () => {
      const m = runManifest("A14");
      assert.ok(m.$schema, "Missing $schema");
      assert.equal(m.slice_id, "A14");
      assert.ok(m.slice_name, "Missing slice_name");
      assert.ok(m.invariant, "Missing invariant");
      assert.ok(typeof m.token_estimate === "number", "token_estimate must be a number");
      assert.ok(typeof m.token_ceiling === "number", "token_ceiling must be a number");
      assert.ok(typeof m.exceeds_ceiling === "boolean", "exceeds_ceiling must be boolean");
      assert.ok(Array.isArray(m.entries), "entries must be an array");
      assert.ok(Array.isArray(m.coupled_exclusions), "coupled_exclusions must be an array");
      assert.ok(Array.isArray(m.test_files), "test_files must be an array");
      assert.ok(m.aggregate_hash, "Missing aggregate_hash");
    });

    test("every entry has required fields", () => {
      const m = runManifest("A14");
      for (const e of m.entries) {
        assert.ok(e.path, `Entry missing path: ${JSON.stringify(e)}`);
        assert.ok(e.reason, `Entry ${e.path} missing reason`);
        assert.ok(e.status, `Entry ${e.path} missing status`);
        assert.ok(["present", "missing"].includes(e.status),
          `Entry ${e.path} has invalid status: ${e.status}`);
        if (e.status === "present") {
          assert.ok(e.hash, `Entry ${e.path} missing hash`);
          assert.ok(e.hash.length === 64, `Entry ${e.path} hash should be 64 hex chars`);
          assert.ok(typeof e.bytes === "number", `Entry ${e.path} bytes should be a number`);
        }
      }
    });

    test("every coupled exclusion has path and reason", () => {
      const m = runManifest("A14");
      for (const c of m.coupled_exclusions) {
        assert.ok(c.path, `Coupled exclusion missing path: ${JSON.stringify(c)}`);
        assert.ok(c.reason, `Coupled exclusion ${c.path} missing reason`);
      }
    });

    test("token estimate is positive", () => {
      const m = runManifest("A14");
      assert.ok(m.token_estimate > 0, "Token estimate must be positive");
    });
  });

  // ─── T4.2: Token ceiling enforcement ────────────────────────────────────

  describe("T4.2 — Token ceiling", () => {
    test("manifest reports exceeds_ceiling as boolean", () => {
      const m = runManifest("A14");
      assert.ok(typeof m.exceeds_ceiling === "boolean",
        "exceeds_ceiling must be a boolean");
      // The actual value depends on the total size of A14's include files
      // If true, the packet should be split before model invocation
    });
  });

  // ─── T4.3: Manifest hash drives delta detection ─────────────────────────

  function buildManifestFixture() {
    const dir = mkdtempSync(join(tmpdir(), "audit-t4-3-"));
    mkdirSync(join(dir, "db", "sqlite"), { recursive: true });
    mkdirSync(join(dir, "db", "postgres"), { recursive: true });
    mkdirSync(join(dir, "db", "migrations"), { recursive: true });
    mkdirSync(join(dir, "db", "migrations-sqlite"), { recursive: true });
    mkdirSync(join(dir, "tests", "integration", "db", "contract"), { recursive: true });
    mkdirSync(join(dir, "public", "locales"), { recursive: true });
    const create = (p, c) => { writeFileSync(join(dir, p), c, "utf-8"); };
    create("db/index.js", "// store factory\n");
    create("db/sqlite.js", "// barrel\n");
    create("db/postgres.js", "// barrel\n");
    create("db/sqlite/store.js", "// sqlite store\n");
    create("db/postgres/store.js", "// pg store\n");
    create("db/migrate.js", "// pg migrate\n");
    create("db/migrate-sqlite.js", "// sqlite migrate\n");
    create("db/tables.js", "// tables\n");
    create("db/types.js", "// types\n");
    create("db/encrypt.js", "// encrypt\n");
    create("db/sqlite/encryption.js", "// sqlite encrypt\n");
    create("db/sqlite/search.js", "// sqlite search\n");
    create("db/postgres/search.js", "// pg search\n");
    create("db/sqlite/mappers.js", "// sqlite mappers\n");
    create("db/postgres/mappers.js", "// pg mappers\n");
    create("db/sqlite/wiki.js", "// sqlite wiki\n");
    create("db/migrations/001_core.sql", "-- pg core\n");
    create("db/migrations-sqlite/001_core.sql", "-- sqlite core\n");
    create("tests/integration/db/contract/backends.js", "// backends\n");
    create("tests/integration/db/encrypt.test.js", "// encrypt test\n");
    return { dir, cleanup: () => execSync(`rm -rf "${dir}"`, { shell: true }) };
  }

  describe("T4.3 — Manifest hash sensitivity", () => {
    test("changing a DB file changes the aggregate hash", () => {
      const { dir, cleanup } = buildManifestFixture();
      try {
        const baseline = runManifest("A14", dir).aggregate_hash;
        writeFileSync(join(dir, "db", "index.js"), "// changed content\n", "utf-8");
        const newHash = runManifest("A14", dir).aggregate_hash;
        assert.notEqual(newHash, baseline,
          "Aggregate hash should change when a DB file is modified");
      } finally { cleanup(); }
    });

    test("adding a migration changes the aggregate hash", () => {
      const { dir, cleanup } = buildManifestFixture();
      try {
        const baseline = runManifest("A14", dir).aggregate_hash;
        writeFileSync(join(dir, "db", "migrations", "011_new.sql"), "-- new\n", "utf-8");
        const newHash = runManifest("A14", dir).aggregate_hash;
        assert.notEqual(newHash, baseline,
          "Aggregate hash should change when a migration is added");
      } finally { cleanup(); }
    });

    test("unrelated change does not affect A14 manifest hash", () => {
      const { dir, cleanup } = buildManifestFixture();
      try {
        const baseline = runManifest("A14", dir).aggregate_hash;
        // Create a file in a watched area but not in A14's scope (e.g. settings)
        writeFileSync(join(dir, "public", "locales", "en.json"), '{"change": true}\n', "utf-8");
        const sameHash = runManifest("A14", dir).aggregate_hash;
        assert.equal(sameHash, baseline,
          "A14 hash should not change when unrelated files change");
      } finally { cleanup(); }
    });
  });
});
