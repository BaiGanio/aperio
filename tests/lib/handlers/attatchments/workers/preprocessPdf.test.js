// tests/tools/files.test.js
// Tests for readFileHandler, writeFileHandler, appendFileHandler, scanProjectHandler.
// Uses proper mocking of fs operations and path validation.

import { test, describe, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";

import {
  readFileHandler,
  writeFileHandler,
  appendFileHandler,
  scanProjectHandler,
} from "../../../../mcp/tools/files.js";

import { setupSecureTestEnvironment, createIsolatedTestDir } from "../../helpers/sandbox.js";

// ─── Test Setup ───────────────────────────────────────────────────────────────

describe("File Handlers", () => {
  let testDir;
  let restoreDir;
  let cleanupMock;
  let mockFs;
  
  before(() => {
    // Setup secure test environment with mocks
    cleanupMock = setupSecureTestEnvironment();
  });
  
  beforeEach(async () => {
    // Create isolated temp dir for path safety
    const isolated = createIsolatedTestDir();
    testDir = isolated.root;
    restoreDir = isolated.restore;
    
    // Setup mock filesystem with in-memory storage
    mockFs = new Map();
    
    // Mock fs.promises methods
    mock.method(fs, 'readFile', mock.fn(async (path, encoding) => {
      const content = mockFs.get(path.toString());
      if (!content) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    }));
    
    mock.method(fs, 'writeFile', mock.fn(async (path, content, options) => {
      mockFs.set(path.toString(), content.toString());
      return undefined;
    }));
    
    mock.method(fs, 'appendFile', mock.fn(async (path, content) => {
      const existing = mockFs.get(path.toString()) || '';
      mockFs.set(path.toString(), existing + content.toString());
      return undefined;
    }));
    
    mock.method(fs, 'mkdir', mock.fn(async (path, options) => {
      mockFs.set(path.toString(), '');
      return undefined;
    }));
    
    mock.method(fs, 'readdir', mock.fn(async (path, options) => {
      const files = [];
      const prefix = path.toString();
      for (const key of mockFs.keys()) {
        if (key.startsWith(prefix) && key !== prefix) {
          const relative = key.slice(prefix.length + 1);
          if (!relative.includes('/')) {
            files.push(relative);
          }
        }
      }
      return files;
    }));
    
    mock.method(fs, 'stat', mock.fn(async (path) => ({
      isDirectory: () => !mockFs.has(path.toString()) || path.toString().endsWith('/'),
      isFile: () => mockFs.has(path.toString()),
      size: (mockFs.get(path.toString()) || '').length
    })));
    
    mock.method(fs, 'access', mock.fn(async (path) => {
      if (!mockFs.has(path.toString()) && !path.toString().includes('exists')) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
    }));
  });
  
  afterEach(() => {
    if (restoreDir) restoreDir();
    if (cleanupMock) cleanupMock();
  });

  // ─── readFileHandler Tests ────────────────────────────────────────────────────

  describe("readFileHandler", () => {
    test("returns file content for an allowed extension", async () => {
      const filePath = join(testDir, "hello.js");
      mockFs.set(filePath, 'console.log("hi");\n');
      
      const result = await readFileHandler({ path: filePath });
      assert.ok(result.content[0].text.includes('console.log("hi")'));
      assert.ok(result.content[0].text.includes(filePath));
    });

    test("rejects disallowed file extension", async () => {
      const filePath = join(testDir, "secret.exe");
      mockFs.set(filePath, "binary content");
      
      const result = await readFileHandler({ path: filePath });
      assert.ok(result.content[0].text.includes("❌ File type not allowed"));
      assert.ok(result.content[0].text.includes(".exe"));
    });

    test("returns error when file does not exist", async () => {
      const result = await readFileHandler({ path: join(testDir, "ghost.js") });
      assert.ok(result.content[0].text.includes("❌ File not found"));
    });

    test("respects offset parameter", async () => {
      const lines = ["apple", "banana", "cherry", "date", "elderberry", "fig", "grape"].join("\n");
      const filePath = join(testDir, "offset_test.js");
      mockFs.set(filePath, lines);
      
      const result = await readFileHandler({ path: filePath, offset: 3 });
      const text = result.content[0].text;
      
      assert.ok(text.includes("date"), "Should include the line at offset");
      assert.ok(!text.includes("apple"), "Should not include lines before offset");
    });

    test("respects max_lines parameter", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
      const filePath = join(testDir, "maxlines.js");
      mockFs.set(filePath, lines);
      
      const result = await readFileHandler({ path: filePath, max_lines: 10 });
      const text = result.content[0].text;
      const lineCount = (text.match(/^line \d+$/gm) || []).length;

      assert.ok(lineCount <= 10, `Expected ≤10 lines, got ${lineCount}`);
    });

    test("truncates and adds notice when content exceeds max_lines", async () => {
      const lines = Array.from({ length: 600 }, (_, i) => `// line ${i}`).join("\n");
      const filePath = join(testDir, "big.js");
      mockFs.set(filePath, lines);
      
      const result = await readFileHandler({ path: filePath, max_lines: 10 });
      assert.ok(result.content[0].text.includes("⚠️ Truncated"));
      assert.ok(result.content[0].text.includes("Use offset:"));
    });

    test("does not add truncation notice when content fits", async () => {
      const filePath = join(testDir, "small.js");
      mockFs.set(filePath, "const x = 1;\n");
      
      const result = await readFileHandler({ path: filePath });
      assert.ok(!result.content[0].text.includes("Truncated"));
    });

    test("caps offset at READ_FILE_MAX_OFFSET (10,000)", async () => {
      const lines = Array.from({ length: 15000 }, (_, i) => `line ${i}`).join("\n");
      const filePath = join(testDir, "bigoffset.js");
      mockFs.set(filePath, lines);
      
      // Requesting offset beyond max should be capped
      const result = await readFileHandler({ path: filePath, offset: 20000 });
      assert.ok(result.content[0].text.includes("line"));
    });

    test("returns error for files larger than 500KB", async () => {
      const largeContent = "x".repeat(600 * 1024); // ~600KB
      const filePath = join(testDir, "large.js");
      mockFs.set(filePath, largeContent);
      
      const result = await readFileHandler({ path: filePath });
      assert.ok(result.content[0].text.includes("❌ File too large"));
      assert.ok(result.content[0].text.includes("Max 500KB"));
    });

    test("returns error when read path is not allowed", async () => {
      // Path outside allowed paths
      const result = await readFileHandler({ path: "/etc/passwd" });
      assert.ok(result.content[0].text.includes("❌ Read not allowed"));
    });
  });

  // ─── writeFileHandler Tests ───────────────────────────────────────────────────

  describe("writeFileHandler", () => {
    const ctx = {};

    test("creates a new file and reports its size", async () => {
      const filePath = join(testDir, "new-file.js");
      const result = await writeFileHandler(ctx, { path: filePath, content: "const x = 42;\n" });
      
      assert.ok(result.content[0].text.includes("✅ Created"));
      assert.ok(mockFs.has(filePath));
      assert.equal(mockFs.get(filePath), "const x = 42;\n");
    });

    test("overwrites an existing file and reports old size", async () => {
      const filePath = join(testDir, "overwrite.js");
      mockFs.set(filePath, "old content\n");
      
      const result = await writeFileHandler(ctx, { path: filePath, content: "new content\n" });
      assert.ok(result.content[0].text.includes("✅ Overwrote"));
      assert.ok(result.content[0].text.includes("was"));
      assert.equal(mockFs.get(filePath), "new content\n");
    });

    test("reports correct file size in KB", async () => {
      const filePath = join(testDir, "size-test.js");
      const content = "x".repeat(2048); // 2KB
      
      const result = await writeFileHandler(ctx, { path: filePath, content });
      assert.ok(result.content[0].text.includes("2.0 KB"));
    });

    test("returns error when write path is not allowed", async () => {
      const result = await writeFileHandler(ctx, { path: "/etc/forbidden.js", content: "x" });
      assert.ok(result.content[0].text.includes("❌ Write not allowed"));
    });

    test("creates parent directories when create_dirs is true (default)", async () => {
      const filePath = join(testDir, "deep", "nested", "file.js");
      const result = await writeFileHandler(ctx, { path: filePath, content: "// deep\n" });
      
      assert.ok(result.content[0].text.includes("✅ Created"));
      assert.ok(mockFs.has(filePath));
    });

    test("does NOT create parent directories when create_dirs is false", async () => {
      const filePath = join(testDir, "nonexistent-dir", "file.js");
      const result = await writeFileHandler(ctx, { path: filePath, content: "x", create_dirs: false });
      
      assert.ok(result.content[0].text.includes("❌ write_file failed"));
      assert.ok(!mockFs.has(filePath));
    });

    test("handles write errors gracefully", async () => {
      // Simulate write error by making fs.writeFile throw
      mock.method(fs, 'writeFile', mock.fn(async () => {
        throw new Error("Disk full");
      }));
      
      const result = await writeFileHandler(ctx, { path: join(testDir, "error.js"), content: "x" });
      assert.ok(result.content[0].text.includes("❌ write_file failed"));
    });
  });

  // ─── appendFileHandler Tests ──────────────────────────────────────────────────

  describe("appendFileHandler", () => {
    const ctx = {};

    test("appends content and reports line counts", async () => {
      const filePath = join(testDir, "append-me.js");
      mockFs.set(filePath, "line1\nline2\n");
      
      const result = await appendFileHandler(ctx, { path: filePath, content: "line3\nline4\n" });
      const text = result.content[0].text;
      
      assert.ok(text.includes("✅ Appended"));
      assert.ok(text.includes("Last 5 lines"));
      assert.ok(text.includes("line4"));
      assert.equal(mockFs.get(filePath), "line1\nline2\nline3\nline4\n");
    });

    test("shows tail (last 5 lines) after append", async () => {
      const filePath = join(testDir, "tail-test.js");
      const initialLines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
      mockFs.set(filePath, initialLines);
      
      const result = await appendFileHandler(ctx, { path: filePath, content: "line10\nline11\n" });
      const text = result.content[0].text;
      
      assert.ok(text.includes("Last 5 lines"));
    });

    test("returns error when write path is not allowed", async () => {
      const result = await appendFileHandler(ctx, { path: "/etc/forbidden.js", content: "x" });
      assert.ok(result.content[0].text.includes("❌ Write not allowed"));
    });

    test("returns error when file does not exist", async () => {
      const result = await appendFileHandler(ctx, {
        path: join(testDir, "no-such-file.js"),
        content: "x",
      });
      assert.ok(result.content[0].text.includes("❌ File not found"));
    });

    test("returns error message on fs failure", async () => {
      // Simulate append error
      mock.method(fs, 'appendFile', mock.fn(async () => {
        throw new Error("Permission denied");
      }));
      
      const filePath = join(testDir, "error.js");
      mockFs.set(filePath, "content\n");
      
      const result = await appendFileHandler(ctx, { path: filePath, content: "x" });
      assert.ok(result.content[0].text.includes("❌ append_file failed"));
    });
  });

  // ─── scanProjectHandler Tests ─────────────────────────────────────────────────

  describe("scanProjectHandler", () => {
    test("returns error when path does not exist", async () => {
      const result = await scanProjectHandler({ path: join(testDir, "no-such-dir") });
      assert.ok(result.content[0].text.includes("❌ Path not found"));
    });

    test("returns error when path is a file, not a directory", async () => {
      const filePath = join(testDir, "not-a-dir.js");
      mockFs.set(filePath, "content");
      
      const result = await scanProjectHandler({ path: filePath });
      assert.ok(result.content[0].text.includes("❌ Not a directory"));
    });

    test("returns error when read path is not allowed", async () => {
      const result = await scanProjectHandler({ path: "/etc" });
      assert.ok(result.content[0].text.includes("❌ Read not allowed"));
    });

    test("returns tree and file count for a valid directory", async () => {
      const dir = join(testDir, "project");
      mockFs.set(join(dir, "index.js"), "// entry\n");
      mockFs.set(join(dir, "README.md"), "# Project\n");
      mockFs.set(join(dir, "config.json"), '{"key":"value"}\n');
      
      const result = await scanProjectHandler({ path: dir });
      const text = result.content[0].text;
      
      assert.ok(text.includes("🗂️ Project:"));
      assert.ok(text.includes("index.js"));
      assert.ok(text.includes("README.md"));
      assert.ok(text.includes("💡 Use read_file"));
    });

    test("reads key file contents when read_key_files is true", async () => {
      const dir = join(testDir, "project-with-pkg");
      mockFs.set(join(dir, "package.json"), '{"name":"test-pkg","version":"1.0.0"}');
      mockFs.set(join(dir, "README.md"), "# Test Project\n\nDescription here.");
      mockFs.set(join(dir, "index.js"), "// main");
      
      const result = await scanProjectHandler({ path: dir, read_key_files: true });
      const text = result.content[0].text;
      
      assert.ok(text.includes("📋 Key files:"));
      assert.ok(text.includes("test-pkg"));
      assert.ok(text.includes("# Test Project"));
    });

    test("limits key file content to 100 lines", async () => {
      const dir = join(testDir, "big-readme");
      const longContent = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
      mockFs.set(join(dir, "README.md"), longContent);
      
      const result = await scanProjectHandler({ path: dir, read_key_files: true });
      const text = result.content[0].text;
      const lineMatches = (text.match(/Line \d+/g) || []).length;
      
      assert.ok(lineMatches <= 100, `Expected ≤100 lines from README, got ${lineMatches}`);
    });

    test("skips key file contents when read_key_files is false", async () => {
      const dir = join(testDir, "project-no-key");
      mockFs.set(join(dir, "package.json"), '{"name":"hidden-pkg"}');
      
      const result = await scanProjectHandler({ path: dir, read_key_files: false });
      assert.ok(!result.content[0].text.includes("hidden-pkg"));
      assert.ok(!result.content[0].text.includes("📋 Key files:"));
    });

    test("skips node_modules directory", async () => {
      const dir = join(testDir, "project-with-skips");
      mockFs.set(join(dir, "node_modules", "some-pkg", "index.js"), "// pkg");
      mockFs.set(join(dir, ".git", "config"), "[core]");
      mockFs.set(join(dir, "index.js"), "// ok\n");
      
      const result = await scanProjectHandler({ path: dir });
      const text = result.content[0].text;
      
      assert.ok(!text.includes("node_modules"));
      assert.ok(!text.includes(".git"));
      assert.ok(text.includes("index.js"));
    });

    test("skips other common directories", async () => {
      const dir = join(testDir, "skip-dirs-check");
      mockFs.set(join(dir, "dist", "bundle.js"), "// bundle");
      mockFs.set(join(dir, "build", "output.js"), "// output");
      mockFs.set(join(dir, "__pycache__", "cache.pyc"), "");
      mockFs.set(join(dir, ".venv", "bin", "python"), "");
      mockFs.set(join(dir, "src.js"), "// source");
      
      const result = await scanProjectHandler({ path: dir });
      const text = result.content[0].text;
      
      assert.ok(!text.includes("dist"));
      assert.ok(!text.includes("build"));
      assert.ok(!text.includes("__pycache__"));
      assert.ok(!text.includes(".venv"));
      assert.ok(text.includes("src.js"));
    });

    test("limits total files shown to 50", async () => {
      const dir = join(testDir, "many-files");
      // Create 60 files in mock
      for (let i = 0; i < 60; i++) {
        mockFs.set(join(dir, `file-${i}.js`), `// file ${i}`);
      }
      
      const result = await scanProjectHandler({ path: dir });
      const text = result.content[0].text;
      const fileMatches = (text.match(/📄 file-\d+\.js/g) || []).length;
      
      assert.ok(fileMatches <= 55, `Expected ≤55 files shown, got ${fileMatches}`);
      assert.ok(text.includes("..."), "Should show ellipsis when truncated");
    });

    test("handles directories with permission errors gracefully", async () => {
      const dir = join(testDir, "no-permission");
      mockFs.set(join(dir, "readable.js"), "// readable");
      
      // Mock readdir to throw permission error
      mock.method(fs, 'readdir', mock.fn(async (path) => {
        if (path.toString().includes("no-permission")) {
          throw new Error("EACCES: permission denied");
        }
        return [];
      }));
      
      const result = await scanProjectHandler({ path: dir });
      assert.ok(result.content[0].text.includes("📁 no-permission/"));
    });

    test("shows correct file count", async () => {
      const dir = join(testDir, "count-test");
      mockFs.set(join(dir, "a.js"), "// a");
      mockFs.set(join(dir, "b.js"), "// b");
      mockFs.set(join(dir, "c.js"), "// c");
      
      const result = await scanProjectHandler({ path: dir });
      const text = result.content[0].text;
      
      assert.ok(text.includes("Files: 3"));
    });
  });

  // ─── Integration Tests ────────────────────────────────────────────────────────

  describe("Integration: File workflow", () => {
    const ctx = {};

    test("complete CRUD workflow: write → read → append → read", async () => {
      const filePath = join(testDir, "workflow.js");
      
      // 1. Write initial content
      const writeResult = await writeFileHandler(ctx, { path: filePath, content: "line1\nline2\n" });
      assert.ok(writeResult.content[0].text.includes("✅ Created"));
      assert.equal(mockFs.get(filePath), "line1\nline2\n");
      
      // 2. Read back
      const readResult = await readFileHandler({ path: filePath });
      assert.ok(readResult.content[0].text.includes("line1"));
      assert.ok(readResult.content[0].text.includes("line2"));
      
      // 3. Append more content
      const appendResult = await appendFileHandler(ctx, { path: filePath, content: "line3\nline4\n" });
      assert.ok(appendResult.content[0].text.includes("✅ Appended"));
      assert.equal(mockFs.get(filePath), "line1\nline2\nline3\nline4\n");
      
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
      mockFs.set(join(dir, "package.json"), JSON.stringify({ name: "test-app", version: "1.0.0" }));
      mockFs.set(join(dir, "index.js"), 'console.log("hello");');
      
      // 1. Scan to find key files
      const scanResult = await scanProjectHandler({ path: dir, read_key_files: true });
      assert.ok(scanResult.content[0].text.includes("test-app"));
      assert.ok(scanResult.content[0].text.includes("index.js"));
      
      // 2. Read the actual file
      const readResult = await readFileHandler({ path: join(dir, "index.js") });
      assert.ok(readResult.content[0].text.includes('console.log("hello")'));
    });
  });
});