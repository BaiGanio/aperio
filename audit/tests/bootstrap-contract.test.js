// audit/tests/bootstrap-contract.test.js
// A01 Bootstrap contract gate tests.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CONTRACT_SCRIPT = resolve("audit/scripts/contracts/bootstrap.js");

function buildBootFixture() {
  const dir = mkdtempSync(join(tmpdir(), "audit-a01-"));
  mkdirSync(join(dir, "lib", "server"), { recursive: true });
  mkdirSync(join(dir, "lib", "helpers"), { recursive: true });
  mkdirSync(join(dir, "tests", "e2e", "bootstrap"), { recursive: true });
  mkdirSync(join(dir, "tests", "e2e", "real-app"), { recursive: true });
  mkdirSync(join(dir, "tests", "integration", "server"), { recursive: true });
  mkdirSync(join(dir, "tests", "unit", "lib"), { recursive: true });

  const create = (p, c) => writeFileSync(join(dir, p), c, "utf-8");
  create("server.js", "// entrypoint");
  create("bootstrap.js", "// bootstrap");
  create("lib/server.js", "// composition root");
  create("lib/server/shutdown.js", "// shutdown");
  create("lib/load-env.js", "// env loader");
  create("lib/server/hydrateRuntime.js", "// hydrate");
  create("lib/helpers/crashBreaker.js", "// crash breaker");
  create("lib/config-resolver.js", "// config resolver");
  create("tests/e2e/bootstrap/bootstrap.test.js", "// boot test");
  create("tests/e2e/real-app/real-app-lifecycle.test.js", "// lifecycle test");
  create("tests/integration/server/server.test.js", "// server test");
  create("tests/unit/lib/server.shutdown.test.js", "// shutdown test");

  return dir;
}

function runContract(dir) {
  try {
    const result = execSync(`node ${CONTRACT_SCRIPT} "${dir}"`, {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(result);
  } catch (err) {
    return JSON.parse(err.stdout);
  }
}

describe("A01 — Bootstrap contract gate", () => {
  test("gate passes with complete fixture", () => {
    const dir = buildBootFixture();
    try {
      const result = runContract(dir);
      assert.ok(result.passed, "Should pass with complete fixture");
      assert.equal(result.checks.boot_files.passed, true);
      assert.equal(result.checks.boot_tests.passed, true);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when server.js is missing", () => {
    const dir = buildBootFixture();
    try {
      unlinkSync(join(dir, "server.js"));
      assert.equal(runContract(dir).passed, false);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when bootstrap.js is missing", () => {
    const dir = buildBootFixture();
    try {
      unlinkSync(join(dir, "bootstrap.js"));
      assert.equal(runContract(dir).passed, false);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when shutdown.js is missing", () => {
    const dir = buildBootFixture();
    try {
      unlinkSync(join(dir, "lib", "server", "shutdown.js"));
      assert.equal(runContract(dir).passed, false);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when crashBreaker is missing", () => {
    const dir = buildBootFixture();
    try {
      unlinkSync(join(dir, "lib", "helpers", "crashBreaker.js"));
      assert.equal(runContract(dir).passed, false);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when a test file is missing", () => {
    const dir = buildBootFixture();
    try {
      unlinkSync(join(dir, "tests", "e2e", "bootstrap", "bootstrap.test.js"));
      assert.equal(runContract(dir).passed, false);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("restoring a deleted file makes gate pass again", () => {
    const dir = buildBootFixture();
    try {
      unlinkSync(join(dir, "lib", "server.js"));
      assert.equal(runContract(dir).passed, false);

      writeFileSync(join(dir, "lib", "server.js"), "// restored", "utf-8");
      assert.equal(runContract(dir).passed, true);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });
});
