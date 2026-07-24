// audit/tests/config-contract.test.js
// A02 Config contract gate tests.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CONTRACT_SCRIPT = resolve("audit/scripts/contracts/config.js");

function buildConfigFixture() {
  const dir = mkdtempSync(join(tmpdir(), "audit-a02-"));
  mkdirSync(join(dir, "lib", "routes"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });

  const create = (p, c) => { writeFileSync(join(dir, p), c, "utf-8"); };
  create("lib/config.js", "export const CONFIG = [];");
  create("lib/config-resolver.js", "export function resolve() {}");
  create("lib/config-sync.js", "export function sync() {}");
  create("lib/load-env.js", "import dotenv from 'dotenv';");
  create("lib/routes/api-settings.js", "// settings API");
  create("lib/routes/api-config.js", "// config API");
  create("scripts/gen-env-example.js", "// generator with --check flag");
  create("docs/config-reference.md", "# Config Reference");
  // .env.example with enough real entries (not just comments)
  create(".env.example", [
    "# comment",
    "AI_PROVIDER=llamacpp",
    "ANTHROPIC_API_KEY=",
    "DEEPSEEK_API_KEY=",
    "DB_BACKEND=sqlite",
    "PORT=31337",
    "APERIO_AUTH_TOKEN=",
    "EMBEDDING_PROVIDER=transformers",
    "",
  ].join("\n"));

  return dir;
}

function runContract(dir) {
  try {
    const result = execSync(`node ${CONTRACT_SCRIPT} "${dir}"`, {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(result);
  } catch (err) {
    // Non-zero exit (gate failed) — the JSON is still in stdout
    return JSON.parse(err.stdout);
  }
}

describe("A02 — Config contract gate", () => {
  test("gate passes with complete fixture", () => {
    const dir = buildConfigFixture();
    try {
      const result = runContract(dir);
      assert.ok(result.passed, "Gate should pass with complete fixture");
      assert.equal(result.checks.file_existence.passed, true);
      assert.equal(result.checks.invariants.passed, true);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when config registry is missing", () => {
    const dir = buildConfigFixture();
    try {
      unlinkSync(join(dir, "lib", "config.js"));
      const result = runContract(dir);
      assert.equal(result.passed, false, "Gate should fail without config registry");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when .env.example is missing", () => {
    const dir = buildConfigFixture();
    try {
      unlinkSync(join(dir, ".env.example"));
      const result = runContract(dir);
      assert.equal(result.passed, false, "Gate should fail without .env.example");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when .env.example has only comments", () => {
    const dir = buildConfigFixture();
    try {
      writeFileSync(join(dir, ".env.example"), "# comment\n# another comment\n", "utf-8");
      const result = runContract(dir);
      assert.equal(result.passed, false, "Gate should fail with comment-only .env.example");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when Settings API route is missing", () => {
    const dir = buildConfigFixture();
    try {
      unlinkSync(join(dir, "lib", "routes", "api-settings.js"));
      const result = runContract(dir);
      assert.equal(result.passed, false, "Gate should fail without settings route");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when config reference doc is missing", () => {
    const dir = buildConfigFixture();
    try {
      unlinkSync(join(dir, "docs", "config-reference.md"));
      const result = runContract(dir);
      assert.equal(result.passed, false, "Gate should fail without config reference doc");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("restoring a deleted file makes gate pass again", () => {
    const dir = buildConfigFixture();
    try {
      const create = (p, c) => writeFileSync(join(dir, p), c, "utf-8");

      // Fail: delete resolver
      unlinkSync(join(dir, "lib", "config-resolver.js"));
      assert.equal(runContract(dir).passed, false, "Gate should fail after deletion");

      // Restore
      create("lib/config-resolver.js", "export function resolve() {}");
      assert.equal(runContract(dir).passed, true, "Gate should pass after restoration");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });
});
