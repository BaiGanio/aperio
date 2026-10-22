// tests/lib/tools/validateWrittenFile.test.js
//
// Mock strategy (proven by tests/mcp/tools/files.test.js):
//
// 1. Use createRequire() to get CJS module references for "fs" and
//    "child_process" — the same objects that ESM live bindings read.
// 2. Save REAL function references before any mocking.
// 3. Call mock.method() at TOP LEVEL with smart mocks that fall through
//    to the real function for any path NOT under /tmp/.  This lets
//    module-level imports (winston etc.) read their real files while
//    the test controls what validateWrittenFile sees.
// 4. Test-level mutable closures control per-scenario behaviour.
// 5. mock.restoreAll() is called ONCE in after(), never between tests.

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("fs");
const cp = require("child_process");

// ─── Real function references (saved BEFORE mocking) ────────────────────────
const REAL = {
  readFileSync: fs.readFileSync,
  existsSync:   fs.existsSync,
};

// ─── Mock child process factory ──────────────────────────────────────────────
function createMockChild({ exitCode = 0, stderr = "", stdout = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

// ─── Mutable closures (per-test control — only affect /tmp/ paths) ─────────
let _existsSync   = () => true;
let _readFileSync = () => "";
let _spawn        = () => createMockChild({ exitCode: 0 });

function isTestPath(path) {
  return typeof path === "string" && path.startsWith("/tmp/");
}

function setExistsSync(fn)   { _existsSync = fn; }
function setReadFileSync(fn) { _readFileSync = fn; }
function setSpawn(fn)        { _spawn = fn; }

// ─── Top-level mocks (BEFORE the dynamic import) ─────────────────────────────

mock.method(fs, "existsSync", (path) => {
  if (isTestPath(path)) return _existsSync(path);
  return REAL.existsSync(path);
});

mock.method(fs, "readFileSync", (...args) => {
  const path = args[0];
  if (isTestPath(path)) return _readFileSync(path, ...args.slice(1));
  return REAL.readFileSync(...args);
});

mock.method(cp, "spawn", (...args) => _spawn(...args));

// Dynamic import — the ESM module's live bindings now point to our mocks.
// The mocks only intercept /tmp/ paths, so the module-level imports work.
let validateWrittenFile;

before(async () => {
  const mod = await import("../../../lib/tools/validateWrittenFile.js");
  validateWrittenFile = mod.validateWrittenFile;
});

after(() => {
  mock.restoreAll();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("validateWrittenFile", () => {

  // ── Guard clauses ─────────────────────────────────────────────────────────

  describe("guard clauses", () => {
    test("returns { ok: true } for non-string targetPath", async () => {
      assert.deepEqual(await validateWrittenFile(undefined), { ok: true });
      assert.deepEqual(await validateWrittenFile(null), { ok: true });
      assert.deepEqual(await validateWrittenFile(123), { ok: true });
    });

    test("returns { ok: true } for empty string", async () => {
      assert.deepEqual(await validateWrittenFile(""), { ok: true });
    });

    test("returns { ok: true } for non-existent file", async () => {
      setExistsSync(() => false);
      assert.deepEqual(await validateWrittenFile("/nonexistent/file.js"), { ok: true });
      setExistsSync(() => true);
    });
  });

  // ── JavaScript (.js) ──────────────────────────────────────────────────────

  describe("JavaScript validation (.js)", () => {
    test("valid syntax returns { ok: true, lang: \"JavaScript\" }", async () => {
      setSpawn(() => createMockChild({ exitCode: 0 }));
      const result = await validateWrittenFile("/tmp/valid.js");
      assert.deepEqual(result, { ok: true, lang: "JavaScript" });
    });

    test("spawn was called with node --check and the target path", async () => {
      let spawnArgs = null;
      setSpawn((...args) => { spawnArgs = args; return createMockChild({ exitCode: 0 }); });
      await validateWrittenFile("/tmp/test.js");
      assert.ok(spawnArgs, "spawn should have been called");
      assert.equal(spawnArgs[0], "node");
      assert.deepEqual(spawnArgs[1], ["--check", "/tmp/test.js"]);
    });

    test("reports error from stderr on non-zero exit", async () => {
      setSpawn(() => createMockChild({ exitCode: 1, stderr: "SyntaxError: Unexpected token" }));
      const result = await validateWrittenFile("/tmp/bad.js");
      assert.equal(result.ok, false);
      assert.equal(result.lang, "JavaScript");
      assert.equal(result.message, "SyntaxError: Unexpected token");
    });

    test("falls back to generic message when stderr is empty on non-zero exit", async () => {
      setSpawn(() => createMockChild({ exitCode: 1 }));
      const result = await validateWrittenFile("/tmp/bad.js");
      assert.equal(result.ok, false);
      assert.equal(result.lang, "JavaScript");
      assert.equal(result.message, "node --check exited 1");
    });

    test("stderr message is truncated to 600 characters", async () => {
      const longError = "E".repeat(1000);
      setSpawn(() => createMockChild({ exitCode: 1, stderr: longError }));
      const result = await validateWrittenFile("/tmp/long.js");
      assert.equal(result.message.length, 600);
      assert.equal(result.message, longError.slice(0, 600));
    });
  });

  // ── JavaScript (.mjs / .cjs) ──────────────────────────────────────────────

  describe("JavaScript validation (.mjs / .cjs)", () => {
    test("validates .mjs files", async () => {
      setSpawn(() => createMockChild({ exitCode: 0 }));
      const result = await validateWrittenFile("/tmp/mod.mjs");
      assert.deepEqual(result, { ok: true, lang: "JavaScript" });
    });

    test("validates .cjs files", async () => {
      setSpawn(() => createMockChild({ exitCode: 0 }));
      const result = await validateWrittenFile("/tmp/mod.cjs");
      assert.deepEqual(result, { ok: true, lang: "JavaScript" });
    });
  });

  // ── spawn failure (fail-open) ─────────────────────────────────────────────

  describe("spawn failure (fail-open)", () => {
    test("returns { ok: true } when spawn throws synchronously", async () => {
      setSpawn(() => { throw new Error("spawn ENOENT"); });
      const result = await validateWrittenFile("/tmp/test.js");
      assert.deepEqual(result, { ok: true });
    });

    test("returns { ok: true } when child emits an error event", async () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => child.emit("error", new Error("ENOENT")));
      setSpawn(() => child);
      const result = await validateWrittenFile("/tmp/test.js");
      assert.deepEqual(result, { ok: true });
    });
  });

  // ── JSON (.json) ──────────────────────────────────────────────────────────

  describe("JSON validation (.json)", () => {
    test("valid JSON returns { ok: true, lang: \"JSON\" }", async () => {
      setReadFileSync(() => '{"name": "test", "value": 42}');
      const result = await validateWrittenFile("/tmp/config.json");
      assert.deepEqual(result, { ok: true, lang: "JSON" });
    });

    test("invalid JSON returns { ok: false } with error message", async () => {
      setReadFileSync(() => "{broken json}");
      const result = await validateWrittenFile("/tmp/bad.json");
      assert.equal(result.ok, false);
      assert.equal(result.lang, "JSON");
      assert.ok(typeof result.message === "string");
      assert.ok(result.message.length > 0);
    });

    test("reports readFileSync error in JSON message", async () => {
      setReadFileSync(() => { throw new Error("ENOENT: no such file or directory"); });
      const result = await validateWrittenFile("/tmp/missing.json");
      assert.equal(result.ok, false);
      assert.equal(result.lang, "JSON");
      assert.ok(result.message.includes("ENOENT"));
    });
  });

  // ── XML (.xml / .rels) ────────────────────────────────────────────────────

  describe("XML validation (.xml / .rels)", () => {
    test("valid XML returns { ok: true, lang: \"XML\" }", async () => {
      setReadFileSync(() => "<root><item>value</item></root>");
      const result = await validateWrittenFile("/tmp/data.xml");
      assert.deepEqual(result, { ok: true, lang: "XML" });
    });

    test("reports errors for malformed XML", async () => {
      setReadFileSync(() => "<root><item>value</item></root");
      const result = await validateWrittenFile("/tmp/bad.xml");
      assert.equal(result.ok, false);
      assert.equal(result.lang, "XML");
      assert.ok(result.message.length > 0);
    });

    test("validates .rels files as XML", async () => {
      setReadFileSync(() =>
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
      );
      const result = await validateWrittenFile("/tmp/doc.rels");
      assert.deepEqual(result, { ok: true, lang: "XML" });
    });

    test("reports read errors for XML files", async () => {
      setReadFileSync(() => { throw new Error("EACCES: permission denied"); });
      const result = await validateWrittenFile("/tmp/protected.xml");
      assert.equal(result.ok, false);
      assert.equal(result.lang, "XML");
      assert.ok(result.message.includes("EACCES"));
    });
  });

  // ── Unknown extensions ────────────────────────────────────────────────────

  describe("unknown extensions", () => {
    test("returns { ok: true } for .txt files", async () => {
      const result = await validateWrittenFile("/tmp/readme.txt");
      assert.deepEqual(result, { ok: true });
    });

    test("returns { ok: true } for .md files", async () => {
      const result = await validateWrittenFile("/tmp/readme.md");
      assert.deepEqual(result, { ok: true });
    });

    test("returns { ok: true } for files without extension", async () => {
      const result = await validateWrittenFile("/tmp/Makefile");
      assert.deepEqual(result, { ok: true });
    });
  });
});
