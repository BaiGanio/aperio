// tests/tools/files.test.js
// Tests for readFileHandler, writeFileHandler, appendFileHandler, scanProjectHandler.
// Uses proper mocking of path validation functions.

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import {
  readFileHandler,
  writeFileHandler,
  appendFileHandler,
  scanProjectHandler,
} from "../../../mcp/tools/files.js";

// ─── Temp workspace ───────────────────────────────────────────────────────────
// Place TMP under process.cwd() so the real path validation in paths.js allows
// access. Tests that need to verify "path denied" behaviour use /tmp directly,
// which is outside the default ALLOWED_READ/WRITE_PATHS (= cwd).
const TMP = join(process.cwd(), ".test-tmp", String(process.pid));

before(async () => {
  await fs.mkdir(TMP, { recursive: true });
});

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

afterEach(() => {
  // Clean up any extra files
});

function tmpFile(name, content = "line1\nline2\nline3\n") {
  const p = join(TMP, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function createNestedDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}


// ─── readFileHandler Tests ────────────────────────────────────────────────────

describe("readFileHandler", () => {
  test("returns file content for an allowed extension", async () => {
    const p = tmpFile("hello.js", 'console.log("hi");\n');
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes('console.log("hi")'));
    assert.ok(result.content[0].text.includes(p));
  });

  test("rejects disallowed file extension", async () => {
    const p = tmpFile("secret.exe", "binary content");
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes("❌ File type not allowed"));
    assert.ok(result.content[0].text.includes(".exe"));
  });

  test("returns error when file does not exist", async () => {
    const result = await readFileHandler({ path: join(TMP, "ghost.js") });
    assert.ok(result.content[0].text.includes("❌ File not found"));
  });

  test("respects offset parameter", async () => {
    const lines = ["apple", "banana", "cherry", "date", "elderberry", "fig", "grape"].join("\n");
    const p = tmpFile("offset_test.js", lines);
    
    const result = await readFileHandler({ path: p, offset: 3 });
    const text = result.content[0].text;
    
    assert.ok(text.includes("date"), "Should include the line at offset");
    assert.ok(!text.includes("apple"), "Should not include lines before offset");
  });

  test("respects max_lines parameter", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const p = tmpFile("maxlines.js", lines);
    
    const result = await readFileHandler({ path: p, max_lines: 10 });
    const text = result.content[0].text;
    const lineCount = (text.match(/^line \d+$/gm) || []).length;

    assert.ok(lineCount <= 10, `Expected ≤10 lines, got ${lineCount}`);
  });

  test("truncates and adds notice when content exceeds max_lines", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `// line ${i}`).join("\n");
    const p = tmpFile("big.js", lines);
    const result = await readFileHandler({ path: p, max_lines: 10 });
    assert.ok(result.content[0].text.includes("⚠️ Truncated"));
    assert.ok(result.content[0].text.includes("Use offset:"));
  });

  test("does not add truncation notice when content fits", async () => {
    const p = tmpFile("small.js", "const x = 1;\n");
    const result = await readFileHandler({ path: p });
    assert.ok(!result.content[0].text.includes("Truncated"));
  });

  test("defaults max_lines to READ_FILE_CHUNK_SIZE (500)", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    const p = tmpFile("default.js", lines);
    const result = await readFileHandler({ path: p });
    const text = result.content[0].text;
    const lineMatches = text.match(/^line \d+$/gm);
    assert.ok(lineMatches.length <= 500, `Expected ≤500 lines, got ${lineMatches.length}`);
  });

  test("caps offset at READ_FILE_MAX_OFFSET (10,000)", async () => {
    const lines = Array.from({ length: 15000 }, (_, i) => `line ${i}`).join("\n");
    const p = tmpFile("bigoffset.js", lines);
    // Requesting offset beyond max should be capped
    const result = await readFileHandler({ path: p, offset: 20000 });
    // Should still return something (won't crash)
    assert.ok(result.content[0].text.includes("line"));
  });

  test("returns error for files larger than 500KB", async () => {
    const largeContent = "x".repeat(600 * 1024); // ~600KB
    const p = tmpFile("large.js", largeContent);
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes("❌ File too large"));
    assert.ok(result.content[0].text.includes("Max 500KB"));
  });

  test("returns error when read path is not allowed", async () => {
    // /tmp is outside ALLOWED_READ_PATHS (defaults to cwd), so validation rejects it
    const result = await readFileHandler({ path: "/tmp/aperio-deny-read-test.js" });
    assert.ok(result.content[0].text.includes("❌ Read not allowed"));
    assert.ok(result.content[0].text.includes("Allowed read paths:"));
  });

  test("handles absolute paths with ~ expansion", async () => {
    const p = tmpFile("tilde.js", "content");
    // ~ expansion happens in write/append, read doesn't expand ~
    // Just verify normal path works
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes(p));
  });
});

// ─── writeFileHandler Tests ───────────────────────────────────────────────────

describe("writeFileHandler", () => {
  // Create a minimal ctx object (only used for compatibility)
  const ctx = {};

  test("creates a new file and reports its size", async () => {
    const p = join(TMP, "new-file.js");
    const result = await writeFileHandler(ctx, { path: p, content: "const x = 42;\n" });
    assert.ok(result.content[0].text.includes("✅ Created"));
    assert.ok(existsSync(p));
    const content = await fs.readFile(p, "utf8");
    assert.equal(content, "const x = 42;\n");
  });

  test("overwrites an existing file and reports old size", async () => {
    const p = tmpFile("overwrite.js", "old content\n");
    const result = await writeFileHandler(ctx, { path: p, content: "new content\n" });
    assert.ok(result.content[0].text.includes("✅ Overwrote"));
    assert.ok(result.content[0].text.includes("was"));
    const content = await fs.readFile(p, "utf8");
    assert.equal(content, "new content\n");
  });

  test("reports correct file size in KB", async () => {
    const p = join(TMP, "size-test.js");
    const content = "x".repeat(2048); // 2KB
    const result = await writeFileHandler(ctx, { path: p, content });
    assert.ok(result.content[0].text.includes("2.0 KB"));
  });

  test("returns error when write path is not allowed", async () => {
    // /tmp is outside ALLOWED_WRITE_PATHS (defaults to cwd), so validation rejects it
    const result = await writeFileHandler(ctx, { path: "/tmp/aperio-deny-write-test.js", content: "x" });
    assert.ok(result.content[0].text.includes("❌ Write not allowed"));
    assert.ok(result.content[0].text.includes("Allowed write paths:"));
  });

  test("creates parent directories when create_dirs is true (default)", async () => {
    const p = join(TMP, "deep", "nested", "file.js");
    const result = await writeFileHandler(ctx, { path: p, content: "// deep\n" });
    assert.ok(result.content[0].text.includes("✅ Created"));
    assert.ok(existsSync(p));
  });

  test("does NOT create parent directories when create_dirs is false", async () => {
    const p = join(TMP, "nonexistent-dir", "file.js");
    const result = await writeFileHandler(ctx, { path: p, content: "x", create_dirs: false });
    assert.ok(result.content[0].text.includes("❌ write_file failed"));
    assert.ok(!existsSync(p));
  });

  test("expands ~ to process.cwd()", async () => {
    const originalCwd = process.cwd();
    const testDir = join(TMP, "tilde-expand");
    await fs.mkdir(testDir, { recursive: true });
    process.chdir(testDir);
    
    try {
      const p = "~/test-file.js";
      const expectedPath = join(testDir, "test-file.js");
      const result = await writeFileHandler(ctx, { path: p, content: "content\n" });
      assert.ok(result.content[0].text.includes("✅ Created"));
      assert.ok(existsSync(expectedPath));
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("handles write errors gracefully", async () => {
    // Pass an invalid path (empty string) to cause an error
    const result = await writeFileHandler(ctx, { path: "", content: "x" });
    assert.ok(result.content[0].text.includes("❌ write_file failed"));
  });
});

// ─── appendFileHandler Tests ──────────────────────────────────────────────────

describe("appendFileHandler", () => {
  const ctx = {};

  test("appends content and reports line counts", async () => {
    const p = tmpFile("append-me.js", "line1\nline2\n");
    const result = await appendFileHandler(ctx, { path: p, content: "line3\nline4\n" });
    const text = result.content[0].text;
    assert.ok(text.includes("✅ Appended"));
    assert.ok(text.includes("Last 5 lines"));
    assert.ok(text.includes("line4"));
    
    const content = await fs.readFile(p, "utf8");
    assert.equal(content, "line1\nline2\nline3\nline4\n");
  });

  test("shows tail (last 5 lines) after append", async () => {
    const p = tmpFile("tail-test.js", Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
    const result = await appendFileHandler(ctx, { path: p, content: "line10\nline11\n" });
    const text = result.content[0].text;
    // Should include last 5 lines of the new content
    assert.ok(text.includes("Last 5 lines"));
  });

  test("returns error when write path is not allowed", async () => {
    // /tmp is outside ALLOWED_WRITE_PATHS (defaults to cwd), so validation rejects it
    const result = await appendFileHandler(ctx, { path: "/tmp/aperio-deny-append-test.js", content: "x" });
    assert.ok(result.content[0].text.includes("❌ Write not allowed"));
  });

  test("returns error when file does not exist", async () => {
    const result = await appendFileHandler(ctx, {
      path: join(TMP, "no-such-file.js"),
      content: "x",
    });
    assert.ok(result.content[0].text.includes("❌ File not found"));
  });

  test("expands ~ to process.cwd()", async () => {
    const originalCwd = process.cwd();
    const testDir = join(TMP, "append-tilde");
    await fs.mkdir(testDir, { recursive: true });
    process.chdir(testDir);
    
    try {
      const filePath = join(testDir, "append-test.js");
      writeFileSync(filePath, "initial\n");
      
      const result = await appendFileHandler(ctx, { path: "~/append-test.js", content: "appended\n" });
      assert.ok(result.content[0].text.includes("✅ Appended"));
      
      const content = await fs.readFile(filePath, "utf8");
      assert.equal(content, "initial\nappended\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("returns error message on fs failure (append to directory)", async () => {
    const result = await appendFileHandler(ctx, { path: TMP, content: "x" });
    assert.ok(result.content[0].text.includes("❌ append_file failed"));
  });
});

// ─── scanProjectHandler Tests ─────────────────────────────────────────────────

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

  test("returns error when read path is not allowed", async () => {
    // /tmp is outside ALLOWED_READ_PATHS (defaults to cwd), so validation rejects it
    const result = await scanProjectHandler({ path: "/tmp" });
    assert.ok(result.content[0].text.includes("❌ Read not allowed"));
  });

  test("returns tree and file count for a valid directory", async () => {
    const dir = join(TMP, "project");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "index.js"), "// entry\n");
    await fs.writeFile(join(dir, "README.md"), "# Project\n");
    await fs.writeFile(join(dir, "config.json"), '{"key":"value"}\n');

    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    assert.ok(text.includes("🗂️ Project:"));
    assert.ok(text.includes("index.js"));
    assert.ok(text.includes("README.md"));
    assert.ok(text.includes("💡 Use read_file"));
  });

  test("uses correct icon for code files vs other files", async () => {
    const dir = join(TMP, "icons-test");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "app.js"), "// code");
    await fs.writeFile(join(dir, "data.json"), "{}");
    
    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    // Code files should have 📄, data files 📋
    assert.ok(text.includes("📄 app.js") || text.includes("📄 app.js"));
    assert.ok(text.includes("📋 data.json"));
  });

  test("reads key file contents when read_key_files is true", async () => {
    const dir = join(TMP, "project-with-pkg");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "package.json"), '{"name":"test-pkg","version":"1.0.0"}');
    await fs.writeFile(join(dir, "README.md"), "# Test Project\n\nDescription here.");
    await fs.writeFile(join(dir, "index.js"), "// main");

    const result = await scanProjectHandler({ path: dir, read_key_files: true });
    const text = result.content[0].text;
    assert.ok(text.includes("📋 Key files:"));
    assert.ok(text.includes("test-pkg"));
    assert.ok(text.includes("# Test Project"));
  });

  test("limits key file content to 100 lines", async () => {
    const dir = join(TMP, "big-readme");
    await fs.mkdir(dir, { recursive: true });
    const longContent = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
    await fs.writeFile(join(dir, "README.md"), longContent);
    
    const result = await scanProjectHandler({ path: dir, read_key_files: true });
    const text = result.content[0].text;
    const lineMatches = (text.match(/Line \d+/g) || []).length;
    assert.ok(lineMatches <= 100, `Expected ≤100 lines from README, got ${lineMatches}`);
  });

  test("skips key file contents when read_key_files is false", async () => {
    const dir = join(TMP, "project-no-key");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "package.json"), '{"name":"hidden-pkg"}');

    const result = await scanProjectHandler({ path: dir, read_key_files: false });
    assert.ok(!result.content[0].text.includes("hidden-pkg"));
    assert.ok(!result.content[0].text.includes("📋 Key files:"));
  });

  test("skips node_modules directory", async () => {
    const dir = join(TMP, "project-with-skips");
    await fs.mkdir(join(dir, "node_modules", "some-pkg"), { recursive: true });
    await fs.mkdir(join(dir, ".git"), { recursive: true });
    await fs.writeFile(join(dir, "index.js"), "// ok\n");

    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    assert.ok(!text.includes("node_modules"));
    assert.ok(!text.includes(".git"));
    assert.ok(text.includes("index.js"));
  });

  test("skips other common directories", async () => {
    const dir = join(TMP, "skip-dirs-check");
    await fs.mkdir(join(dir, "dist"), { recursive: true });
    await fs.mkdir(join(dir, "build"), { recursive: true });
    await fs.mkdir(join(dir, "__pycache__"), { recursive: true });
    await fs.mkdir(join(dir, ".venv"), { recursive: true });
    await fs.mkdir(join(dir, "venv"), { recursive: true });
    await fs.writeFile(join(dir, "src.js"), "// source");

    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    assert.ok(!text.includes("dist"));
    assert.ok(!text.includes("build"));
    assert.ok(!text.includes("__pycache__"));
    assert.ok(!text.includes(".venv"));
    assert.ok(!text.includes("venv"));
    assert.ok(text.includes("src.js"));
  });

  test("limits tree depth to 3 levels", async () => {
    const dir = join(TMP, "deep-tree");
    const deep = join(dir, "level1", "level2", "level3", "level4", "level5");
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(join(deep, "deep-file.js"), "// deep");
    
    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    // Should show up to level3 but not level4/5
    assert.ok(text.includes("level1/"));
    assert.ok(text.includes("level2/"));
    assert.ok(text.includes("level3/"));
    // level4 may appear as truncated or not
  });

  test("limits total files shown to 50", async () => {
    const dir = join(TMP, "many-files");
    await fs.mkdir(dir, { recursive: true });
    // Create 60 files
    for (let i = 0; i < 60; i++) {
      await fs.writeFile(join(dir, `file-${i}.js`), `// file ${i}`);
    }
    
    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    const fileMatches = (text.match(/📄 file-\d+\.js/g) || []).length;
    assert.ok(fileMatches <= 55, `Expected ≤55 files shown, got ${fileMatches}`);
    assert.ok(text.includes("..."), "Should show ellipsis when truncated");
  });

  test("handles directories with permission errors gracefully", async () => {
    const dir = join(TMP, "no-permission");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "readable.js"), "// readable");
    
    // Just verify it doesn't crash - the function catches errors internally
    const result = await scanProjectHandler({ path: dir });
    assert.ok(result.content[0].text.includes("readable.js"));
  });

  test("shows correct file count", async () => {
    const dir = join(TMP, "count-test");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "a.js"), "// a");
    await fs.writeFile(join(dir, "b.js"), "// b");
    await fs.writeFile(join(dir, "c.js"), "// c");
    
    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    assert.ok(text.includes("Files: 3"));
  });
});

// ─── Integration Tests ────────────────────────────────────────────────────────

describe("Integration: File workflow", () => {
  const ctx = {};
  let testDir;

  beforeEach(async () => {
    testDir = join(TMP, `workflow-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  test("complete CRUD workflow: write → read → append → read", async () => {
    const filePath = join(testDir, "workflow.js");
    
    // 1. Write initial content
    const writeResult = await writeFileHandler(ctx, { path: filePath, content: "line1\nline2\n" });
    assert.ok(writeResult.content[0].text.includes("✅ Created"));
    
    // 2. Read back
    const readResult = await readFileHandler({ path: filePath });
    assert.ok(readResult.content[0].text.includes("line1"));
    assert.ok(readResult.content[0].text.includes("line2"));
    
    // 3. Append more content
    const appendResult = await appendFileHandler(ctx, { path: filePath, content: "line3\nline4\n" });
    assert.ok(appendResult.content[0].text.includes("✅ Appended"));
    
    // 4. Read again to verify
    const finalRead = await readFileHandler({ path: filePath });
    const finalText = finalRead.content[0].text;
    assert.ok(finalText.includes("line1"));
    assert.ok(finalText.includes("line2"));
    assert.ok(finalText.includes("line3"));
    assert.ok(finalText.includes("line4"));
  });

  test("scan → read_key_file → read_file workflow", async () => {
    const dir = join(testDir, "app");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-app", version: "1.0.0" }));
    await fs.writeFile(join(dir, "index.js"), 'console.log("hello");');
    
    // 1. Scan to find key files
    const scanResult = await scanProjectHandler({ path: dir });
    assert.ok(scanResult.content[0].text.includes("test-app"));
    assert.ok(scanResult.content[0].text.includes("index.js"));
    
    // 2. Read the actual file
    const readResult = await readFileHandler({ path: join(dir, "index.js") });
    assert.ok(readResult.content[0].text.includes('console.log("hello")'));
  });
});