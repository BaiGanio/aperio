// audit/tests/memory-contract.test.js
// A13 Memory contract gate tests.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CONTRACT_SCRIPT = resolve("audit/scripts/contracts/memory.js");

function buildMemoryFixture() {
  const dir = mkdtempSync(join(tmpdir(), "audit-a13-"));
  mkdirSync(join(dir, "db", "sqlite"), { recursive: true });
  mkdirSync(join(dir, "lib", "handlers", "memory"), { recursive: true });
  mkdirSync(join(dir, "lib", "helpers"), { recursive: true });
  mkdirSync(join(dir, "lib", "memory"), { recursive: true });
  mkdirSync(join(dir, "tests", "unit", "tools"), { recursive: true });
  mkdirSync(join(dir, "tests", "unit", "wiki"), { recursive: true });
  mkdirSync(join(dir, "tests", "unit", "helpers"), { recursive: true });
  mkdirSync(join(dir, "tests", "unit", "db"), { recursive: true });
  mkdirSync(join(dir, "tests", "unit", "memory"), { recursive: true });
  mkdirSync(join(dir, "tests", "integration", "db", "contract"), { recursive: true });

  const create = (p, c) => writeFileSync(join(dir, p), c, "utf-8");
  create("db/memory-seed.js", "// seed");
  create("db/self-memory-seed.js", "// self seed");
  create("db/wiki-seed.js", "// wiki seed");
  create("db/sqlite/wiki.js", "// sqlite wiki");
  create("db/memory-seed-lite.js", "// lite seed");
  create("lib/handlers/memory/memoryHandlers.js", "// handlers");
  create("lib/handlers/memory/selfMemoryHandlers.js", "// self handlers");
  create("lib/helpers/embeddings.js", "// embeddings");
  create("lib/helpers/embedding-queue.js", "// queue");
  create("lib/helpers/embedding-backlog.js", "// backlog");
  create("lib/helpers/embedding-worker.js", "// worker");
  create("lib/helpers/embedding-worker-client.js", "// worker client");
  create("lib/memory/compactionBaseline.js", "// compaction");
  create("lib/memory/tokenCount.js", "// token count");
  create("tests/unit/tools/memory.test.js", "// memory test");
  create("tests/unit/tools/self-memory.test.js", "// self test");
  create("tests/unit/tools/self-wiki.test.js", "// self wiki test");
  create("tests/unit/wiki/wikiHandlers.test.js", "// wiki handlers test");
  create("tests/unit/wiki/wikiQueries.test.js", "// wiki queries test");
  create("tests/unit/helpers/embeddings.test.js", "// embed test");
  create("tests/unit/helpers/embedding-queue.test.js", "// queue test");
  create("tests/unit/helpers/embedding-backlog.test.js", "// backlog test");
  create("tests/unit/helpers/embedding-worker-client.test.js", "// wc test");
  create("tests/unit/db/memory-seed.test.js", "// seed test");
  create("tests/integration/db/contract/memories.test.js", "// memories test");
  create("tests/integration/db/contract/wiki.test.js", "// wiki test");
  create("tests/integration/db/contract/self-memory.test.js", "// self test");
  create("tests/integration/db/contract/embeddings.js", "// embed contract");
  create("tests/integration/db/self-wiki.test.js", "// self wiki test");

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

describe("A13 — Memory contract gate", () => {
  test("gate passes with complete fixture", () => {
    const dir = buildMemoryFixture();
    try {
      const result = runContract(dir);
      assert.ok(result.passed, "Gate should pass with complete fixture");
      assert.equal(result.checks.memory_files.passed, true);
      assert.equal(result.checks.memory_tests.passed, true);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when memory handler is missing", () => {
    const dir = buildMemoryFixture();
    try {
      unlinkSync(join(dir, "lib", "handlers", "memory", "memoryHandlers.js"));
      const result = runContract(dir);
      assert.equal(result.passed, false);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when embedding module is missing", () => {
    const dir = buildMemoryFixture();
    try {
      unlinkSync(join(dir, "lib", "helpers", "embeddings.js"));
      const result = runContract(dir);
      assert.equal(result.passed, false);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when wiki seed is missing", () => {
    const dir = buildMemoryFixture();
    try {
      unlinkSync(join(dir, "db", "wiki-seed.js"));
      const result = runContract(dir);
      assert.equal(result.passed, false);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when compaction baseline is missing", () => {
    const dir = buildMemoryFixture();
    try {
      unlinkSync(join(dir, "lib", "memory", "compactionBaseline.js"));
      const result = runContract(dir);
      assert.equal(result.passed, false);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when test file is missing", () => {
    const dir = buildMemoryFixture();
    try {
      unlinkSync(join(dir, "tests", "unit", "tools", "memory.test.js"));
      const result = runContract(dir);
      assert.equal(result.passed, false);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("restoring a deleted file makes gate pass again", () => {
    const dir = buildMemoryFixture();
    try {
      unlinkSync(join(dir, "lib", "handlers", "memory", "selfMemoryHandlers.js"));
      assert.equal(runContract(dir).passed, false, "Should fail after deletion");

      writeFileSync(join(dir, "lib", "handlers", "memory", "selfMemoryHandlers.js"),
        "// self handlers", "utf-8");
      assert.equal(runContract(dir).passed, true, "Should pass after restoration");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });
});
