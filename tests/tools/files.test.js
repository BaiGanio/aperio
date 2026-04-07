// tests/tools/files.test.js
// Tests for readFileHandler, writeFileHandler, appendFileHandler, scanProjectHandler.
// Imports directly from mcp/tools/files.js — no inline copies.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readFileHandler,
  writeFileHandler,
  appendFileHandler,
  scanProjectHandler,
} from "../../mcp/tools/files.js";

// ─── Temp workspace ───────────────────────────────────────────────────────────

const TMP = join(tmpdir(), `aperio-test-${process.pid}`);

before(() => mkdirSync(TMP, { recursive: true }));
after(() => fs.rm(TMP, { recursive: true, force: true }));

function tmpFile(name, content = "line1\nline2\nline3\n") {
  const p = join(TMP, name);
  writeFileSync(p, content, "utf8");
  return p;
}

// ─── ctx factory ─────────────────────────────────────────────────────────────

function makeCtx({ allowed = true } = {}) {
  return {
    isPathAllowed: () => allowed,
    ALLOWED_PATHS: [TMP],
  };
}

// ─── readFileHandler ──────────────────────────────────────────────────────────

describe("readFileHandler", () => {
  test("returns file content for an allowed extension", async () => {
    const p = tmpFile("hello.js", 'console.log("hi");\n');
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes('console.log("hi")'));
    assert.ok(result.content[0].text.includes(p));
  });

  test("rejects disallowed file extension", async () => {
    const p = tmpFile("secret.exe", "binary");
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes("❌ File type not allowed"));
    assert.ok(result.content[0].text.includes(".exe"));
  });

  test("returns error when file does not exist", async () => {
    const result = await readFileHandler({ path: join(TMP, "ghost.js") });
    assert.ok(result.content[0].text.includes("❌ File not found"));
  });

  test("respects offset parameter", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const p = tmpFile("offset.js", lines);
    const result = await readFileHandler({ path: p, offset: 5 });
    assert.ok(result.content[0].text.includes("line6"));
    assert.ok(!result.content[0].text.includes("line1"));
  });

  test("truncates and adds notice when content exceeds max_lines", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `// line ${i}`).join("\n");
    const p = tmpFile("big.js", lines);
    const result = await readFileHandler({ path: p, max_lines: 10 });
    assert.ok(result.content[0].text.includes("⚠️ Truncated"));
  });

  test("does not add truncation notice when content fits", async () => {
    const p = tmpFile("small.js", "const x = 1;\n");
    const result = await readFileHandler({ path: p });
    assert.ok(!result.content[0].text.includes("Truncated"));
  });
});

// ─── writeFileHandler ─────────────────────────────────────────────────────────

describe("writeFileHandler", () => {
  test("creates a new file and reports its size", async () => {
    const p = join(TMP, "new-file.js");
    const result = await writeFileHandler(makeCtx(), { path: p, content: "const x = 42;\n" });
    assert.ok(result.content[0].text.includes("✅ Created"));
    assert.ok(existsSync(p));
  });

  test("overwrites an existing file and reports old size", async () => {
    const p = tmpFile("overwrite.js", "old content\n");
    const result = await writeFileHandler(makeCtx(), { path: p, content: "new content\n" });
    assert.ok(result.content[0].text.includes("✅ Overwrote"));
    assert.ok(result.content[0].text.includes("was"));
  });

  test("returns error when path is not allowed", async () => {
    const result = await writeFileHandler(makeCtx({ allowed: false }), {
      path: join(TMP, "blocked.js"),
      content: "x",
    });
    assert.ok(result.content[0].text.includes("❌ Path not allowed"));
    assert.ok(result.content[0].text.includes("APERIO_ALLOWED_PATHS"));
  });

  test("creates parent directories when create_dirs is true", async () => {
    const p = join(TMP, "deep", "nested", "file.js");
    const result = await writeFileHandler(makeCtx(), { path: p, content: "// deep\n", create_dirs: true });
    assert.ok(result.content[0].text.includes("✅"));
    assert.ok(existsSync(p));
  });

  test("returns error on fs failure (create_dirs false, missing dir)", async () => {
    const p = join(TMP, "nonexistent-dir", "file.js");
    const result = await writeFileHandler(makeCtx(), { path: p, content: "x", create_dirs: false });
    assert.ok(result.content[0].text.includes("❌ write_file failed"));
  });
});

// ─── appendFileHandler ────────────────────────────────────────────────────────

describe("appendFileHandler", () => {
  test("appends content and reports line counts", async () => {
    const p = tmpFile("append-me.js", "line1\nline2\n");
    const result = await appendFileHandler(makeCtx(), { path: p, content: "line3\nline4\n" });
    const text = result.content[0].text;
    assert.ok(text.includes("✅ Appended"));
    assert.ok(text.includes("Last 5 lines"));
    assert.ok(text.includes("line4"));
  });

  test("returns error when path is not allowed", async () => {
    const p = tmpFile("append-blocked.js");
    const result = await appendFileHandler(makeCtx({ allowed: false }), { path: p, content: "x" });
    assert.ok(result.content[0].text.includes("❌ Path not allowed"));
  });

  test("returns error when file does not exist", async () => {
    const result = await appendFileHandler(makeCtx(), {
      path: join(TMP, "no-such-file.js"),
      content: "x",
    });
    assert.ok(result.content[0].text.includes("❌ File not found"));
  });

  test("returns error message on fs failure", async () => {
    // Pass a directory path as the file to force appendFile to throw
    const result = await appendFileHandler(makeCtx(), { path: TMP, content: "x" });
    assert.ok(result.content[0].text.includes("❌ append_file failed"));
  });
});

// ─── scanProjectHandler ───────────────────────────────────────────────────────

describe("scanProjectHandler", () => {
  test("returns error when path does not exist", async () => {
    const result = await scanProjectHandler({ path: join(TMP, "no-such-dir") });
    assert.ok(result.content[0].text.includes("❌ Path not found"));
  });

  test("returns error when path is a file, not a directory", async () => {
    const p = tmpFile("not-a-dir.js");
    const result = await scanProjectHandler({ path: p });
    assert.ok(result.content[0].text.includes("❌ Not a directory"));
  });

  test("returns tree and file count for a valid directory", async () => {
    const dir = join(TMP, "project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.js"), "// entry\n");
    writeFileSync(join(dir, "README.md"), "# Project\n");

    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    assert.ok(text.includes("🗂️ Project:"));
    assert.ok(text.includes("index.js"));
    assert.ok(text.includes("README.md"));
    assert.ok(text.includes("💡 Use read_file"));
  });

  test("reads key file contents when read_key_files is true", async () => {
    const dir = join(TMP, "project-with-pkg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"test-pkg"}');

    const result = await scanProjectHandler({ path: dir, read_key_files: true });
    assert.ok(result.content[0].text.includes("test-pkg"));
    assert.ok(result.content[0].text.includes("📋 Key files:"));
  });

  test("skips key file contents when read_key_files is false", async () => {
    const dir = join(TMP, "project-no-key");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"hidden-pkg"}');

    const result = await scanProjectHandler({ path: dir, read_key_files: false });
    assert.ok(!result.content[0].text.includes("hidden-pkg"));
  });

  test("skips node_modules and .git directories", async () => {
    const dir = join(TMP, "project-with-skips");
    mkdirSync(join(dir, "node_modules", "some-pkg"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "index.js"), "// ok\n");

    const result = await scanProjectHandler({ path: dir });
    assert.ok(!result.content[0].text.includes("node_modules"));
    assert.ok(!result.content[0].text.includes(".git"));
    assert.ok(result.content[0].text.includes("index.js"));
  });
});