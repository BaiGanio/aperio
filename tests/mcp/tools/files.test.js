// tests/mcp/tools/files.test.js
// Tests for readFileHandler, writeFileHandler, appendFileHandler, scanProjectHandler.
//
// Zero real disk access. Strategy:
//   1. Build an in-memory VFS (Map) with mock implementations for every fs
//      method that files.js uses.
//   2. Patch the underlying CJS module objects via createRequire() BEFORE
//      dynamically importing files.js — Node.js reads named-export values from
//      the CJS cache at first-import time, so the patches take effect.
//   3. Mock process.cwd() at module level (before the dynamic import) so that
//      paths.js computes BASE_DIR = TMP when it loads.  This means
//      ALLOWED_*_PATHS defaults to [TMP] with no env-var tricks, and ~ paths
//      are validated against TMP rather than the project directory.
//   4. Mock process.chdir() to update a virtualCwd variable; the ~ expansion
//      tests update virtualCwd without touching the real process cwd.

import { mock, test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { createRequire } from "module";

// ─── In-memory VFS ────────────────────────────────────────────────────────────

const vfs = new Map(); // path → { type: "file"|"dir", content: string }

function vfsSetupDir(path) {
  path.split("/").filter(Boolean).reduce((acc, part) => {
    const p = `${acc}/${part}`;
    if (!vfs.has(p)) vfs.set(p, { type: "dir", content: "" });
    return p;
  }, "");
}

function vfsSetupFile(path, content) {
  const parent = path.substring(0, path.lastIndexOf("/"));
  if (parent) vfsSetupDir(parent);
  vfs.set(path, { type: "file", content });
}

const vfsRead   = (path) => vfs.get(path)?.content ?? null;
const vfsExists = (path) => vfs.has(path);

// ─── Virtual cwd and TMP ─────────────────────────────────────────────────────

const TMP = "/vfs/aperio-test";
vfsSetupDir(TMP);
let virtualCwd = TMP;

// ─── Mock implementations ─────────────────────────────────────────────────────

function mockExistsSync(path)   { return vfs.has(path); }
function mockStatSync(path) {
  const e = vfs.get(path);
  if (!e) throw Object.assign(new Error(`ENOENT: stat '${path}'`), { code: "ENOENT" });
  return {
    size: e.type === "file" ? Buffer.byteLength(e.content, "utf8") : 0,
    isDirectory: () => e.type === "dir",
    isFile:      () => e.type === "file",
  };
}
function mockReadFileSync(path) {
  const e = vfs.get(path);
  if (!e || e.type !== "file")
    throw Object.assign(new Error(`ENOENT: open '${path}'`), { code: "ENOENT" });
  return e.content;
}
function mockReaddirSync(path) {
  const e = vfs.get(path);
  if (!e || e.type !== "dir")
    throw Object.assign(new Error(`ENOENT: scandir '${path}'`), { code: "ENOENT" });
  const children = new Set();
  for (const key of vfs.keys())
    if (key.startsWith(path + "/")) {
      const segment = key.slice(path.length + 1).split("/")[0];
      if (segment) children.add(segment);
    }
  return [...children].sort();
}

async function mockWriteFile(path, content) {
  if (!path)
    throw Object.assign(new Error(`ENOENT: open ''`), { code: "ENOENT" });
  const e = vfs.get(path);
  if (e?.type === "dir")
    throw Object.assign(new Error(`EISDIR: open '${path}'`), { code: "EISDIR" });
  const parent = path.substring(0, path.lastIndexOf("/"));
  if (parent && !vfs.has(parent))
    throw Object.assign(new Error(`ENOENT: open '${path}'`), { code: "ENOENT" });
  vfs.set(path, { type: "file", content });
}
async function mockReadFile(path) {
  const e = vfs.get(path);
  if (!e || e.type !== "file") {
    const msg = e ? `EISDIR: open '${path}'` : `ENOENT: open '${path}'`;
    throw Object.assign(new Error(msg), { code: e ? "EISDIR" : "ENOENT" });
  }
  return e.content;
}
async function mockAppendFile(path, content) {
  const e = vfs.get(path);
  if (!e)
    throw Object.assign(new Error(`ENOENT: open '${path}'`), { code: "ENOENT" });
  if (e.type === "dir")
    throw Object.assign(new Error(`EISDIR: open '${path}'`), { code: "EISDIR" });
  vfs.set(path, { type: "file", content: e.content + content });
}
async function mockMkdir(path, opts) {
  if (opts?.recursive)
    path.split("/").filter(Boolean).reduce((acc, part) => {
      const p = `${acc}/${part}`;
      if (!vfs.has(p)) vfs.set(p, { type: "dir", content: "" });
      return p;
    }, "");
  else
    vfs.set(path, { type: "dir", content: "" });
}
async function mockStat(path) {
  const e = vfs.get(path);
  if (!e) throw Object.assign(new Error(`ENOENT: stat '${path}'`), { code: "ENOENT" });
  return {
    size: e.type === "file" ? Buffer.byteLength(e.content, "utf8") : 0,
    isDirectory: () => e.type === "dir",
  };
}
async function mockRm(path, opts) {
  if (opts?.recursive)
    for (const key of [...vfs.keys()])
      if (key === path || key.startsWith(path + "/")) vfs.delete(key);
  else
    vfs.delete(path);
}

// ─── Patch CJS module objects BEFORE importing files.js ───────────────────────
// Node.js reads named-export values from the CJS module cache at the moment an
// ESM module first imports them. Patching before the dynamic import below
// ensures files.js sees our mocks for every fs call it makes.

const require  = createRequire(import.meta.url);
const fsSync   = require("fs");
const fsAsync  = require("fs/promises");

// Mocking process.cwd here (before files.js / paths.js load) causes paths.js
// to set BASE_DIR = TMP, so ALLOWED_*_PATHS = [TMP] with no env-var changes.
mock.method(process, "cwd",   () => virtualCwd);
mock.method(process, "chdir", (dir) => { virtualCwd = dir.startsWith("/") ? dir : join(virtualCwd, dir); });

mock.method(fsSync, "existsSync",   mockExistsSync);
mock.method(fsSync, "statSync",     mockStatSync);
mock.method(fsSync, "readFileSync", mockReadFileSync);
mock.method(fsSync, "readdirSync",  mockReaddirSync);

mock.method(fsAsync, "writeFile",  mockWriteFile);
mock.method(fsAsync, "readFile",   mockReadFile);
mock.method(fsAsync, "appendFile", mockAppendFile);
mock.method(fsAsync, "mkdir",      mockMkdir);
mock.method(fsAsync, "stat",       mockStat);
mock.method(fsAsync, "rm",         mockRm);

// Dynamic import: files.js loads here and binds to our patched functions.
// paths.js also loads here and computes BASE_DIR = process.cwd() = TMP.
const { readFileHandler, writeFileHandler, appendFileHandler, scanProjectHandler } =
  await import("../../../mcp/tools/files.js");

// ─── Lifecycle ────────────────────────────────────────────────────────────────

before(() => {
  mock.method(process, "exit", () => { throw new Error("Mocked exit"); });
  mock.method(process, "kill", () => { throw new Error("Mocked kill"); });
});

after(() => {
  vfs.clear();
  mock.restoreAll();
});

// ─── Test helper ─────────────────────────────────────────────────────────────

function tmpFile(name, content = "line1\nline2\nline3\n") {
  const p = join(TMP, name);
  vfsSetupFile(p, content);
  return p;
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
    const p = tmpFile("offset_test.js",
      ["apple", "banana", "cherry", "date", "elderberry", "fig", "grape"].join("\n"));

    const result = await readFileHandler({ path: p, offset: 3 });
    const text = result.content[0].text;
    assert.ok(text.includes("date"),   "Should include the line at offset");
    assert.ok(!text.includes("apple"), "Should not include lines before offset");
  });

  test("respects max_lines parameter", async () => {
    const p = tmpFile("maxlines.js",
      Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));

    const result = await readFileHandler({ path: p, max_lines: 10 });
    const lineCount = (result.content[0].text.match(/^line \d+$/gm) || []).length;
    assert.ok(lineCount <= 10, `Expected ≤10 lines, got ${lineCount}`);
  });

  test("truncates and adds notice when content exceeds max_lines", async () => {
    const p = tmpFile("big.js",
      Array.from({ length: 600 }, (_, i) => `// line ${i}`).join("\n"));
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
    const p = tmpFile("default.js",
      Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n"));
    const result = await readFileHandler({ path: p });
    const lineMatches = result.content[0].text.match(/^line \d+$/gm);
    assert.ok(lineMatches.length <= 500, `Expected ≤500 lines, got ${lineMatches.length}`);
  });

  test("caps offset at READ_FILE_MAX_OFFSET (10,000)", async () => {
    const p = tmpFile("bigoffset.js",
      Array.from({ length: 15000 }, (_, i) => `line ${i}`).join("\n"));
    const result = await readFileHandler({ path: p, offset: 20000 });
    assert.ok(result.content[0].text.includes("line"));
  });

  test("returns error for files larger than 500KB", async () => {
    const p = tmpFile("large.js", "x".repeat(600 * 1024));
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes("❌ File too large"));
    assert.ok(result.content[0].text.includes("Max 500KB"));
  });

  test("returns error when read path is not allowed", async () => {
    // /tmp directly is outside ALLOWED_READ_PATHS ([TMP]), so validation rejects it
    const result = await readFileHandler({ path: "/tmp/aperio-deny-read-test.js" });
    assert.ok(result.content[0].text.includes("❌ Read not allowed"));
    assert.ok(result.content[0].text.includes("Allowed read paths:"));
  });

  test("handles absolute paths (read does not expand ~)", async () => {
    const p = tmpFile("tilde.js", "content");
    const result = await readFileHandler({ path: p });
    assert.ok(result.content[0].text.includes(p));
  });
});

// ─── writeFileHandler ─────────────────────────────────────────────────────────

describe("writeFileHandler", () => {
  const ctx = {};

  test("creates a new file and reports its size", async () => {
    const p = join(TMP, "new-file.js");
    const result = await writeFileHandler(ctx, { path: p, content: "const x = 42;\n" });
    assert.ok(result.content[0].text.includes("✅ Created"));
    assert.ok(vfsExists(p));
    assert.equal(vfsRead(p), "const x = 42;\n");
  });

  test("overwrites an existing file and reports old size", async () => {
    const p = tmpFile("overwrite.js", "old content\n");
    const result = await writeFileHandler(ctx, { path: p, content: "new content\n" });
    assert.ok(result.content[0].text.includes("✅ Overwrote"));
    assert.ok(result.content[0].text.includes("was"));
    assert.equal(vfsRead(p), "new content\n");
  });

  test("reports correct file size in KB", async () => {
    const p = join(TMP, "size-test.js");
    const result = await writeFileHandler(ctx, { path: p, content: "x".repeat(2048) });
    assert.ok(result.content[0].text.includes("2.0 KB"));
  });

  test("returns error when write path is not allowed", async () => {
    // /tmp directly is outside ALLOWED_WRITE_PATHS ([TMP]), so validation rejects it
    const result = await writeFileHandler(ctx, { path: "/tmp/aperio-deny-write-test.js", content: "x" });
    assert.ok(result.content[0].text.includes("❌ Write not allowed"));
    assert.ok(result.content[0].text.includes("Allowed write paths:"));
  });

  test("creates parent directories when create_dirs is true (default)", async () => {
    const p = join(TMP, "deep", "nested", "file.js");
    const result = await writeFileHandler(ctx, { path: p, content: "// deep\n" });
    assert.ok(result.content[0].text.includes("✅ Created"));
    assert.ok(vfsExists(p));
  });

  test("does NOT create parent directories when create_dirs is false", async () => {
    const p = join(TMP, "nonexistent-dir", "file.js");
    const result = await writeFileHandler(ctx, { path: p, content: "x", create_dirs: false });
    assert.ok(result.content[0].text.includes("❌ write_file failed"));
    assert.ok(!vfsExists(p));
  });

  test("expands ~ to process.cwd()", async () => {
    const savedCwd = virtualCwd;
    const testDir  = join(TMP, "tilde-expand");
    vfsSetupDir(testDir);
    process.chdir(testDir); // updates virtualCwd via mock

    try {
      const expectedPath = join(testDir, "test-file.js");
      const result = await writeFileHandler(ctx, { path: "~/test-file.js", content: "content\n" });
      assert.ok(result.content[0].text.includes("✅ Created"));
      assert.ok(vfsExists(expectedPath));
    } finally {
      process.chdir(savedCwd);
    }
  });

  test("handles write errors gracefully", async () => {
    const result = await writeFileHandler(ctx, { path: "", content: "x" });
    assert.ok(result.content[0].text.includes("❌ write_file failed"));
  });
});

// ─── appendFileHandler ────────────────────────────────────────────────────────

describe("appendFileHandler", () => {
  const ctx = {};

  test("appends content and reports line counts", async () => {
    const p = tmpFile("append-me.js", "line1\nline2\n");
    const result = await appendFileHandler(ctx, { path: p, content: "line3\nline4\n" });
    const text = result.content[0].text;
    assert.ok(text.includes("✅ Appended"));
    assert.ok(text.includes("Last 5 lines"));
    assert.ok(text.includes("line4"));
    assert.equal(vfsRead(p), "line1\nline2\nline3\nline4\n");
  });

  test("shows tail (last 5 lines) after append", async () => {
    const p = tmpFile("tail-test.js",
      Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
    const result = await appendFileHandler(ctx, { path: p, content: "line10\nline11\n" });
    assert.ok(result.content[0].text.includes("Last 5 lines"));
  });

  test("returns error when write path is not allowed", async () => {
    const result = await appendFileHandler(ctx, { path: "/tmp/aperio-deny-append-test.js", content: "x" });
    assert.ok(result.content[0].text.includes("❌ Write not allowed"));
  });

  test("returns error when file does not exist", async () => {
    const result = await appendFileHandler(ctx, { path: join(TMP, "no-such-file.js"), content: "x" });
    assert.ok(result.content[0].text.includes("❌ File not found"));
  });

  test("expands ~ to process.cwd()", async () => {
    const savedCwd = virtualCwd;
    const testDir  = join(TMP, "append-tilde");
    const filePath = join(testDir, "append-test.js");
    vfsSetupFile(filePath, "initial\n");
    process.chdir(testDir);

    try {
      const result = await appendFileHandler(ctx, { path: "~/append-test.js", content: "appended\n" });
      assert.ok(result.content[0].text.includes("✅ Appended"));
      assert.equal(vfsRead(filePath), "initial\nappended\n");
    } finally {
      process.chdir(savedCwd);
    }
  });

  test("returns error message on fs failure (append to directory)", async () => {
    // TMP itself is a directory; appendFile on a dir throws EISDIR
    const result = await appendFileHandler(ctx, { path: TMP, content: "x" });
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

  test("returns error when read path is not allowed", async () => {
    const result = await scanProjectHandler({ path: "/tmp" });
    assert.ok(result.content[0].text.includes("❌ Read not allowed"));
  });

  test("returns tree and file count for a valid directory", async () => {
    const dir = join(TMP, "project");
    vfsSetupFile(join(dir, "index.js"),    "// entry\n");
    vfsSetupFile(join(dir, "README.md"),   "# Project\n");
    vfsSetupFile(join(dir, "config.json"), '{"key":"value"}\n');

    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    assert.ok(text.includes("🗂️ Project:"));
    assert.ok(text.includes("index.js"));
    assert.ok(text.includes("README.md"));
    assert.ok(text.includes("💡 Use read_file"));
  });

  test("uses correct icon for code files vs other files", async () => {
    const dir = join(TMP, "icons-test");
    vfsSetupFile(join(dir, "app.js"),    "// code");
    vfsSetupFile(join(dir, "data.json"), "{}");

    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    assert.ok(text.includes("📄 app.js"));
    assert.ok(text.includes("📋 data.json"));
  });

  test("reads key file contents when read_key_files is true", async () => {
    const dir = join(TMP, "project-with-pkg");
    vfsSetupFile(join(dir, "package.json"), '{"name":"test-pkg","version":"1.0.0"}');
    vfsSetupFile(join(dir, "README.md"),    "# Test Project\n\nDescription here.");
    vfsSetupFile(join(dir, "index.js"),     "// main");

    const result = await scanProjectHandler({ path: dir, read_key_files: true });
    const text = result.content[0].text;
    assert.ok(text.includes("📋 Key files:"));
    assert.ok(text.includes("test-pkg"));
    assert.ok(text.includes("# Test Project"));
  });

  test("limits key file content to 100 lines", async () => {
    const dir = join(TMP, "big-readme");
    vfsSetupFile(join(dir, "README.md"),
      Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n"));

    const result = await scanProjectHandler({ path: dir, read_key_files: true });
    const lineMatches = (result.content[0].text.match(/Line \d+/g) || []).length;
    assert.ok(lineMatches <= 100, `Expected ≤100 lines from README, got ${lineMatches}`);
  });

  test("skips key file contents when read_key_files is false", async () => {
    const dir = join(TMP, "project-no-key");
    vfsSetupFile(join(dir, "package.json"), '{"name":"hidden-pkg"}');

    const result = await scanProjectHandler({ path: dir, read_key_files: false });
    assert.ok(!result.content[0].text.includes("hidden-pkg"));
    assert.ok(!result.content[0].text.includes("📋 Key files:"));
  });

  test("skips node_modules directory", async () => {
    const dir = join(TMP, "project-with-skips");
    vfsSetupDir(join(dir, "node_modules", "some-pkg"));
    vfsSetupDir(join(dir, ".git"));
    vfsSetupFile(join(dir, "index.js"), "// ok\n");

    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    assert.ok(!text.includes("node_modules"));
    assert.ok(!text.includes(".git"));
    assert.ok(text.includes("index.js"));
  });

  test("skips other common directories", async () => {
    const dir = join(TMP, "skip-dirs-check");
    vfsSetupDir(join(dir, "dist"));
    vfsSetupDir(join(dir, "build"));
    vfsSetupDir(join(dir, "__pycache__"));
    vfsSetupDir(join(dir, ".venv"));
    vfsSetupDir(join(dir, "venv"));
    vfsSetupFile(join(dir, "src.js"), "// source");

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
    const dir  = join(TMP, "deep-tree");
    const deep = join(dir, "level1", "level2", "level3", "level4", "level5");
    vfsSetupFile(join(deep, "deep-file.js"), "// deep");

    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    assert.ok(text.includes("level1/"));
    assert.ok(text.includes("level2/"));
    assert.ok(text.includes("level3/"));
  });

  test("limits total files shown to 50", async () => {
    const dir = join(TMP, "many-files");
    vfsSetupDir(dir);
    for (let i = 0; i < 60; i++)
      vfsSetupFile(join(dir, `file-${i}.js`), `// file ${i}`);

    const result = await scanProjectHandler({ path: dir });
    const text = result.content[0].text;
    const fileMatches = (text.match(/📄 file-\d+\.js/g) || []).length;
    assert.ok(fileMatches <= 55, `Expected ≤55 files shown, got ${fileMatches}`);
    assert.ok(text.includes("..."), "Should show ellipsis when truncated");
  });

  test("handles directories gracefully", async () => {
    const dir = join(TMP, "no-permission");
    vfsSetupFile(join(dir, "readable.js"), "// readable");
    const result = await scanProjectHandler({ path: dir });
    assert.ok(result.content[0].text.includes("readable.js"));
  });

  test("shows correct file count", async () => {
    const dir = join(TMP, "count-test");
    vfsSetupFile(join(dir, "a.js"), "// a");
    vfsSetupFile(join(dir, "b.js"), "// b");
    vfsSetupFile(join(dir, "c.js"), "// c");

    const result = await scanProjectHandler({ path: dir });
    assert.ok(result.content[0].text.includes("Files: 3"));
  });
});

// ─── Integration ──────────────────────────────────────────────────────────────

describe("Integration: File workflow", () => {
  const ctx = {};
  let testDir;

  beforeEach(() => {
    testDir = join(TMP, `workflow-${Date.now()}`);
    vfsSetupDir(testDir);
  });

  test("complete CRUD workflow: write → read → append → read", async () => {
    const filePath = join(testDir, "workflow.js");

    const writeResult = await writeFileHandler(ctx, { path: filePath, content: "line1\nline2\n" });
    assert.ok(writeResult.content[0].text.includes("✅ Created"));

    const readResult = await readFileHandler({ path: filePath });
    assert.ok(readResult.content[0].text.includes("line1"));
    assert.ok(readResult.content[0].text.includes("line2"));

    const appendResult = await appendFileHandler(ctx, { path: filePath, content: "line3\nline4\n" });
    assert.ok(appendResult.content[0].text.includes("✅ Appended"));

    const finalRead = await readFileHandler({ path: filePath });
    const finalText = finalRead.content[0].text;
    assert.ok(finalText.includes("line1"));
    assert.ok(finalText.includes("line2"));
    assert.ok(finalText.includes("line3"));
    assert.ok(finalText.includes("line4"));
  });

  test("scan → read_key_file → read_file workflow", async () => {
    const dir = join(testDir, "app");
    vfsSetupFile(join(dir, "package.json"), JSON.stringify({ name: "test-app", version: "1.0.0" }));
    vfsSetupFile(join(dir, "index.js"),     'console.log("hello");');

    const scanResult = await scanProjectHandler({ path: dir });
    assert.ok(scanResult.content[0].text.includes("test-app"));
    assert.ok(scanResult.content[0].text.includes("index.js"));

    const readResult = await readFileHandler({ path: join(dir, "index.js") });
    assert.ok(readResult.content[0].text.includes('console.log("hello")'));
  });
});
