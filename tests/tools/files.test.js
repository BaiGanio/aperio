// tests/tools/files.test.js
// Tests for readFileHandler, writeFileHandler, appendFileHandler, scanProjectHandler.
// Uses real temp files in os.tmpdir() — no fs mocking needed or wanted.
// Each test cleans up after itself.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

import {
  readFileHandler,
  writeFileHandler,
  appendFileHandler,
  scanProjectHandler,
} from "../../mcp/tools/files.js";

// ─── Temp directory helpers ───────────────────────────────────────────────────

const TEST_ROOT = join(tmpdir(), `aperio-test-${randomBytes(4).toString("hex")}`);
mkdirSync(TEST_ROOT, { recursive: true });

// Clean up the entire temp tree when all tests finish
after(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

function tmpFile(name, content = "line1\nline2\nline3") {
  const p = join(TEST_ROOT, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function tmpDir(name) {
  const p = join(TEST_ROOT, name);
  mkdirSync(p, { recursive: true });
  return p;
}

// ─── ctx for write/append (path guard) ───────────────────────────────────────

const allowedCtx = {
  isPathAllowed: () => true,
  ALLOWED_PATHS: [TEST_ROOT],
};

const blockedCtx = {
  isPathAllowed: () => false,
  ALLOWED_PATHS: ["/some/other/path"],
};

// ─── readFileHandler ──────────────────────────────────────────────────────────

describe("readFileHandler", () => {
  test("reads a file and returns its content", async () => {
    const p = tmpFile("read-basic.js", "const x = 1;\nconst y = 2;");
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes("const x = 1;"));
    assert.ok(result.content[0].text.includes("const y = 2;"));
  });

  test("includes filename and line count in header", async () => {
    const p = tmpFile("read-header.js", "a\nb\nc");
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes("read-header.js"));
    assert.ok(result.content[0].text.includes("3 lines"));
  });

  test("rejects disallowed file extension", async () => {
    const p = tmpFile("secret.exe", "bad");
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes("❌ File type not allowed"));
    assert.ok(result.content[0].text.includes(".exe"));
  });

  test("returns error for non-existent file", async () => {
    const result = await readFileHandler({ path: join(TEST_ROOT, "ghost.js") });
    assert.ok(result.content[0].text.includes("❌ File not found"));
  });

  test("respects offset parameter", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const p = tmpFile("read-offset.js", lines);
    const result = await readFileHandler({ path: p, offset: 10 });
    assert.ok(result.content[0].text.includes("line11"));
    assert.ok(!result.content[0].text.includes("line1\n")); // line1 not in this chunk
  });

  test("respects max_lines parameter", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const p = tmpFile("read-maxlines.js", lines);
    const result = await readFileHandler({ path: p, max_lines: 3 });
    const text = result.content[0].text;
    assert.ok(text.includes("line1"));
    assert.ok(text.includes("line3"));
    assert.ok(!text.includes("line4"));
  });

  test("adds truncation notice when file exceeds limit", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line${i + 1}`).join("\n");
    const p = tmpFile("read-trunc.js", lines);
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes("⚠️ Truncated"));
    assert.ok(result.content[0].text.includes("offset:"));
  });

  test("does not add truncation notice for short files", async () => {
    const p = tmpFile("read-short.js", "only a few lines\nhere");
    const result = await readFileHandler({ path: p });
    assert.ok(!result.content[0].text.includes("Truncated"));
  });
});

// ─── writeFileHandler ─────────────────────────────────────────────────────────

describe("writeFileHandler", () => {
  test("creates a new file and returns confirmation", async () => {
    const p = join(TEST_ROOT, "write-new.js");
    const result = await writeFileHandler(allowedCtx, { path: p, content: "const a = 1;" });
    assert.ok(result.content[0].text.includes("✅ Created"));
    assert.ok(result.content[0].text.includes("write-new.js"));
    assert.ok(existsSync(p));
  });

  test("written file contains the correct content", async () => {
    const p = join(TEST_ROOT, "write-content.js");
    await writeFileHandler(allowedCtx, { path: p, content: "hello world" });
    const actual = await fs.readFile(p, "utf8");
    assert.equal(actual, "hello world");
  });

  test("overwrites an existing file and reports old size", async () => {
    const p = tmpFile("write-overwrite.js", "original content");
    const result = await writeFileHandler(allowedCtx, { path: p, content: "new content" });
    assert.ok(result.content[0].text.includes("✅ Overwrote"));
    assert.ok(result.content[0].text.includes("was"));
  });

  test("blocks write when path is not allowed", async () => {
    const p = join(TEST_ROOT, "write-blocked.js");
    const result = await writeFileHandler(blockedCtx, { path: p, content: "x" });
    assert.ok(result.content[0].text.includes("❌ Path not allowed"));
  });

  test("creates parent directories when create_dirs is true", async () => {
    const p = join(TEST_ROOT, "deep/nested/dir/file.js");
    const result = await writeFileHandler(allowedCtx, { path: p, content: "x", create_dirs: true });
    assert.ok(result.content[0].text.includes("✅"));
    assert.ok(existsSync(p));
  });

  test("includes size in KB in the confirmation message", async () => {
    const p = join(TEST_ROOT, "write-size.js");
    const result = await writeFileHandler(allowedCtx, { path: p, content: "x".repeat(1024) });
    assert.ok(result.content[0].text.includes("KB"));
  });
});

// ─── appendFileHandler ────────────────────────────────────────────────────────

describe("appendFileHandler", () => {
  test("appends content to an existing file", async () => {
    const p = tmpFile("append-basic.js", "original\n");
    await appendFileHandler(allowedCtx, { path: p, content: "appended" });
    const actual = await fs.readFile(p, "utf8");
    assert.ok(actual.includes("original"));
    assert.ok(actual.includes("appended"));
  });

  test("returns confirmation with before/after line counts", async () => {
    const p = tmpFile("append-counts.js", "line1\nline2\n");
    const result = await appendFileHandler(allowedCtx, { path: p, content: "line3\nline4" });
    assert.ok(result.content[0].text.includes("→ now"));
    assert.ok(result.content[0].text.includes("✅ Appended"));
  });

  test("shows last 5 lines in confirmation", async () => {
    const p = tmpFile("append-tail.js", "a\nb\nc\n");
    await appendFileHandler(allowedCtx, { path: p, content: "SENTINEL_LINE" });
    const result = await appendFileHandler(allowedCtx, { path: p, content: "LAST" });
    assert.ok(result.content[0].text.includes("Last 5 lines"));
  });

  test("blocks append when path is not allowed", async () => {
    const p = tmpFile("append-blocked.js", "x");
    const result = await appendFileHandler(blockedCtx, { path: p, content: "y" });
    assert.ok(result.content[0].text.includes("❌ Path not allowed"));
  });

  test("returns error when file does not exist", async () => {
    const p = join(TEST_ROOT, "append-ghost.js");
    const result = await appendFileHandler(allowedCtx, { path: p, content: "x" });
    assert.ok(result.content[0].text.includes("❌ File not found"));
  });
});

// ─── scanProjectHandler ───────────────────────────────────────────────────────

describe("scanProjectHandler", () => {
  // Build a small realistic project tree once for all scan tests
  const projectRoot = tmpDir("scan-project");
  writeFileSync(join(projectRoot, "index.js"),    "// entry point", "utf8");
  writeFileSync(join(projectRoot, "README.md"),   "# My project", "utf8");
  writeFileSync(join(projectRoot, "package.json"), '{"name":"test"}', "utf8");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "app.ts"), "export default {}", "utf8");
  mkdirSync(join(projectRoot, "node_modules", "some-lib"), { recursive: true });
  writeFileSync(join(projectRoot, "node_modules", "some-lib", "index.js"), "// lib", "utf8");

  test("returns project name and path in output", async () => {
    const result = await scanProjectHandler({ path: projectRoot });
    assert.ok(result.content[0].text.includes("scan-project"));
    assert.ok(result.content[0].text.includes(projectRoot));
  });

  test("lists files in the tree", async () => {
    const result = await scanProjectHandler({ path: projectRoot });
    assert.ok(result.content[0].text.includes("index.js"));
    assert.ok(result.content[0].text.includes("README.md"));
  });

  test("skips node_modules directory", async () => {
    const result = await scanProjectHandler({ path: projectRoot });
    assert.ok(!result.content[0].text.includes("some-lib"));
  });

  test("reads key file contents when read_key_files is true", async () => {
    const result = await scanProjectHandler({ path: projectRoot, read_key_files: true });
    assert.ok(result.content[0].text.includes("📋 Key files"));
    assert.ok(result.content[0].text.includes("My project")); // README content
  });

  test("does not read key file contents when read_key_files is false", async () => {
    const result = await scanProjectHandler({ path: projectRoot, read_key_files: false });
    assert.ok(!result.content[0].text.includes("My project"));
  });

  test("returns error for non-existent path", async () => {
    const result = await scanProjectHandler({ path: join(TEST_ROOT, "ghost-dir") });
    assert.ok(result.content[0].text.includes("❌ Path not found"));
  });

  test("returns error when path is a file, not a directory", async () => {
    const p = tmpFile("not-a-dir.js", "x");
    const result = await scanProjectHandler({ path: p });
    assert.ok(result.content[0].text.includes("❌ Not a directory"));
  });

  test("includes tip about read_file at the end", async () => {
    const result = await scanProjectHandler({ path: projectRoot });
    assert.ok(result.content[0].text.includes("read_file"));
  });
});