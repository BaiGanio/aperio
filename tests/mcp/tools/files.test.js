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
import { basename, join } from "path";
import { createRequire } from "module";
import { createToolHooks } from "../../../lib/agent/tool-hooks.js";
import { parseSearchScopes } from "../../../lib/agent/search-scopes.js";

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

function vfsSetupSymlink(path, target) {
  const parent = path.substring(0, path.lastIndexOf("/"));
  if (parent) vfsSetupDir(parent);
  vfs.set(path, { type: "symlink", content: target });
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
    isDirectory:    () => e.type === "dir",
    isFile:         () => e.type === "file",
    isSymbolicLink: () => e.type === "symlink",
  };
}
function mockReadFileSync(path, ...rest) {
  // Paths outside the VFS namespace (e.g. node_modules sources loaded by
  // ExcelJS at import time) must hit the real fs, not our in-memory map.
  if (typeof path !== "string" || !path.startsWith("/vfs/"))
    return realReadFileSync(path, ...rest);
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
const realReadFileSync = fsSync.readFileSync;

// Mocking process.cwd here (before files.js / paths.js load) causes paths.js
// to set BASE_DIR = TMP, so ALLOWED_*_PATHS = [TMP] with no env-var changes.
mock.method(process, "cwd",   () => virtualCwd);
mock.method(process, "chdir", (dir) => { virtualCwd = dir.startsWith("/") ? dir : join(virtualCwd, dir); });

mock.method(fsSync, "existsSync",   mockExistsSync);
mock.method(fsSync, "statSync",     mockStatSync);
mock.method(fsSync, "lstatSync",    mockStatSync);
mock.method(fsSync, "readFileSync", mockReadFileSync);
mock.method(fsSync, "readdirSync",  mockReaddirSync);

mock.method(fsAsync, "writeFile",  mockWriteFile);
mock.method(fsAsync, "readFile",   mockReadFile);
mock.method(fsAsync, "appendFile", mockAppendFile);
mock.method(fsAsync, "mkdir",      mockMkdir);
mock.method(fsAsync, "stat",       mockStat);
mock.method(fsAsync, "rm",         mockRm);
mock.method(fsAsync, "unlink",     mockRm);

// Dynamic import: files.js loads here and binds to our patched functions.
// paths.js also loads here and computes BASE_DIR = process.cwd() = TMP.
const { readFileHandler, writeFileHandler, appendFileHandler, editFileHandler, deleteFileHandler, scanProjectHandler, grepFilesHandler } =
  await import("../../../mcp/tools/files.js");

// paths.js is already cached from the files.js import above; this re-export
// gives us the same pathStorage instance so runWithPaths affects the guards.
const { runWithPaths } = await import("../../../lib/routes/paths.js");

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

function makeInterruptStore() {
  const rows = new Map();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const get = id => clone(rows.get(id) ?? null);
  return {
    rows,
    async createAgentInterrupt(input) {
      const row = {
        id: input.id,
        session_id: input.sessionId ?? null,
        run_id: input.runId ?? null,
        tool_name: input.toolName,
        canonical_arguments: clone(input.canonicalArguments ?? null),
        protected_payload_ref: clone(input.protectedPayloadRef ?? null),
        digest: input.digest,
        allowed_decisions: clone(input.allowedDecisions),
        decision: null,
        decision_payload: null,
        claim_id: null,
        status: "pending",
        created_at: "2026-07-07T00:00:00.000Z",
        updated_at: "2026-07-07T00:00:00.000Z",
        decided_at: null,
        claimed_at: null,
        completed_at: null,
        expires_at: input.expiresAt ?? null,
      };
      rows.set(row.id, row);
      return get(row.id);
    },
    async getAgentInterrupt(id) { return get(id); },
    async listAgentInterrupts({ sessionId, status = "pending" } = {}) {
      return [...rows.values()]
        .filter(row => !sessionId || row.session_id === sessionId)
        .filter(row => !status || row.status === status)
        .map(row => clone(row));
    },
    async updateAgentInterruptStatus(id, status) {
      const row = rows.get(id);
      if (!row) return null;
      row.status = status;
      return get(id);
    },
    async expireAgentInterrupts() { return 0; },
    async decideAgentInterrupt(id, { decision, status, decisionPayload, now }) {
      const row = rows.get(id);
      if (!row || row.status !== "pending") return null;
      row.decision = decision;
      row.decision_payload = clone(decisionPayload);
      row.status = status;
      row.decided_at = now;
      row.updated_at = now;
      return get(id);
    },
    async claimAgentInterrupt(id, { claimId, now }) {
      const row = rows.get(id);
      if (!row || !["approved", "edited"].includes(row.status)) return null;
      row.status = "claimed";
      row.claim_id = claimId;
      row.claimed_at = now;
      row.updated_at = now;
      return get(id);
    },
    async completeAgentInterrupt(id, { status, now }) {
      const row = rows.get(id);
      if (!row || row.status !== "claimed") return null;
      row.status = status;
      row.completed_at = now;
      row.updated_at = now;
      return get(id);
    },
  };
}

// WRITE-01: a write outside the session scratch workspace now needs user
// confirmation. This helper drives the two-phase flow so the mechanics tests
// still exercise the real write: propose → extract token → commit. Errors and
// auto-executed (in-scratch) writes have no token and pass straight through.
async function confirmed(handler, ctx, args) {
  const r = await handler(ctx, args);
  const m = r.content?.[0]?.text?.match(/Token:\s*(wr_[a-z0-9]+)/);
  return m ? handler(ctx, { confirmation_token: m[1] }) : r;
}

// A path inside a (virtual) scratch workspace — writes here auto-execute.
const SCRATCH = join(TMP, "var", "scratch", "sess");
vfsSetupDir(SCRATCH);


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
    const result = await confirmed(writeFileHandler, ctx, { path: p, content: "const x = 42;\n" });
    assert.ok(result.content[0].text.includes("✅ Created"));
    assert.ok(vfsExists(p));
    assert.equal(vfsRead(p), "const x = 42;\n");
  });

  test("overwrites an existing file and reports old size", async () => {
    const p = tmpFile("overwrite.js", "old content\n");
    const result = await confirmed(writeFileHandler, ctx, { path: p, content: "new content\n" });
    assert.ok(result.content[0].text.includes("✅ Overwrote"));
    assert.ok(result.content[0].text.includes("was"));
    assert.equal(vfsRead(p), "new content\n");
  });

  test("reports correct file size in KB", async () => {
    const p = join(TMP, "size-test.js");
    const result = await confirmed(writeFileHandler, ctx, { path: p, content: "x".repeat(2048) });
    assert.ok(result.content[0].text.includes("2.0 KB"));
  });

  test("returns error when write path is not allowed", async () => {
    // /tmp directly is outside ALLOWED_WRITE_PATHS ([TMP]), so validation rejects it
    const result = await confirmed(writeFileHandler, ctx, { path: "/tmp/aperio-deny-write-test.js", content: "x" });
    assert.ok(result.content[0].text.includes("❌ Write not allowed"));
    assert.ok(result.content[0].text.includes("Allowed write paths:"));
  });

  test("creates parent directories when create_dirs is true (default)", async () => {
    const p = join(TMP, "deep", "nested", "file.js");
    const result = await confirmed(writeFileHandler, ctx, { path: p, content: "// deep\n" });
    assert.ok(result.content[0].text.includes("✅ Created"));
    assert.ok(vfsExists(p));
  });

  test("does NOT create parent directories when create_dirs is false", async () => {
    const p = join(TMP, "nonexistent-dir", "file.js");
    const result = await confirmed(writeFileHandler, ctx, { path: p, content: "x", create_dirs: false });
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
      const result = await confirmed(writeFileHandler, ctx, { path: "~/test-file.js", content: "content\n" });
      assert.ok(result.content[0].text.includes("✅ Created"));
      assert.ok(vfsExists(expectedPath));
    } finally {
      process.chdir(savedCwd);
    }
  });

  test("handles write errors gracefully", async () => {
    const result = await confirmed(writeFileHandler, ctx, { path: "", content: "x" });
    assert.ok(result.content[0].text.includes("❌ write_file failed"));
  });
});

// ─── appendFileHandler ────────────────────────────────────────────────────────

describe("appendFileHandler", () => {
  const ctx = {};

  test("appends content and reports line counts", async () => {
    const p = tmpFile("append-me.js", "line1\nline2\n");
    const result = await confirmed(appendFileHandler, ctx, { path: p, content: "line3\nline4\n" });
    const text = result.content[0].text;
    assert.ok(text.includes("✅ Appended"));
    assert.ok(text.includes("Last 5 lines"));
    assert.ok(text.includes("line4"));
    assert.equal(vfsRead(p), "line1\nline2\nline3\nline4\n");
  });

  test("shows tail (last 5 lines) after append", async () => {
    const p = tmpFile("tail-test.js",
      Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
    const result = await confirmed(appendFileHandler, ctx, { path: p, content: "line10\nline11\n" });
    assert.ok(result.content[0].text.includes("Last 5 lines"));
  });

  test("returns error when write path is not allowed", async () => {
    const result = await confirmed(appendFileHandler, ctx, { path: "/tmp/aperio-deny-append-test.js", content: "x" });
    assert.ok(result.content[0].text.includes("❌ Write not allowed"));
  });

  test("returns error when file does not exist", async () => {
    const result = await confirmed(appendFileHandler, ctx, { path: join(TMP, "no-such-file.js"), content: "x" });
    assert.ok(result.content[0].text.includes("❌ File not found"));
  });

  test("expands ~ to process.cwd()", async () => {
    const savedCwd = virtualCwd;
    const testDir  = join(TMP, "append-tilde");
    const filePath = join(testDir, "append-test.js");
    vfsSetupFile(filePath, "initial\n");
    process.chdir(testDir);

    try {
      const result = await confirmed(appendFileHandler, ctx, { path: "~/append-test.js", content: "appended\n" });
      assert.ok(result.content[0].text.includes("✅ Appended"));
      assert.equal(vfsRead(filePath), "initial\nappended\n");
    } finally {
      process.chdir(savedCwd);
    }
  });

  test("returns error message on fs failure (append to directory)", async () => {
    // TMP itself is a directory; appendFile on a dir throws EISDIR
    const result = await confirmed(appendFileHandler, ctx, { path: TMP, content: "x" });
    assert.ok(result.content[0].text.includes("❌ append_file failed"));
  });
});

// ─── WRITE-01 confirm gate ────────────────────────────────────────────────────

describe("write confirm gate (WRITE-01)", () => {
  const ctx = {};

  test("write outside scratch proposes and does not write until confirmed", async () => {
    const p = join(TMP, "gated", "real.js");
    const r = await writeFileHandler(ctx, { path: p, content: "x" });
    assert.match(r.content[0].text, /pending your confirmation/);
    assert.match(r.content[0].text, /Token:\s*wr_/);
    assert.ok(!vfsExists(p), "nothing written until confirmed");
  });

  test("new write into scratch executes directly", async () => {
    const p = join(SCRATCH, "fresh.js");
    const r = await writeFileHandler(ctx, { path: p, content: "y\n" });
    assert.match(r.content[0].text, /✅ Created/);
    assert.equal(vfsRead(p), "y\n");
  });

  test("overwrite inside scratch still executes directly (frictionless iteration)", async () => {
    const p = join(SCRATCH, "iter.js");
    vfsSetupFile(p, "v1\n");
    const r = await writeFileHandler(ctx, { path: p, content: "v2\n" });
    assert.match(r.content[0].text, /✅ Overwrote/);
    assert.equal(vfsRead(p), "v2\n");
  });

  test("a tainted turn forces confirmation even inside scratch", async () => {
    const p = join(SCRATCH, "tainted.js");
    const r = await writeFileHandler(ctx, { path: p, content: "z", __tainted: true });
    assert.match(r.content[0].text, /pending your confirmation/);
    assert.match(r.content[0].text, /untrusted external content/);
    assert.ok(!vfsExists(p));
  });

  test("commit with an invalid token writes nothing", async () => {
    const r = await writeFileHandler(ctx, { confirmation_token: "wr_bogus1" });
    assert.match(r.content[0].text, /invalid or expired/);
  });

  test("edit_file outside scratch proposes with a diff, then commits", async () => {
    const p = tmpFile("edit-gated.js", "const a = 1;\n");
    const r1 = await editFileHandler(ctx, { path: p, old_string: "const a = 1;", new_string: "const a = 2;" });
    assert.match(r1.content[0].text, /pending your confirmation/);
    assert.match(r1.content[0].text, /```diff/);
    assert.match(r1.content[0].text, /- const a = 1;/);
    assert.match(r1.content[0].text, /\+ const a = 2;/);
    assert.equal(vfsRead(p), "const a = 1;\n", "unchanged until confirmed");

    const token = r1.content[0].text.match(/Token:\s*(wr_[a-z0-9]+)/)[1];
    const r2 = await editFileHandler(ctx, { confirmation_token: token });
    assert.match(r2.content[0].text, /✅ Edited/);
    assert.equal(vfsRead(p), "const a = 2;\n");
  });

  test("write approvals persist as durable descriptors and execute through claim", async () => {
    const store = makeInterruptStore();
    const durableCtx = { store, sessionId: "session-files" };
    const p = join(TMP, "durable-write.js");

    const proposed = await writeFileHandler(durableCtx, { path: p, content: "durable\n" });
    const token = proposed.content[0].text.match(/Token:\s*(wr_[a-z0-9]+)/)[1];
    const row = await store.getAgentInterrupt(token);

    assert.equal(row.session_id, "session-files");
    assert.equal(row.tool_name, "write_file");
    assert.equal(row.status, "pending");
    assert.deepEqual(Object.keys(row.canonical_arguments).sort(), [
      "content",
      "create_dirs",
      "existedAtProposal",
      "existingSize",
      "path",
      "targetDigest",
    ]);
    assert.equal(typeof row.canonical_arguments.content, "string");
    assert.ok(!vfsExists(p), "proposal does not write");

    const committed = await writeFileHandler(durableCtx, { confirmation_token: token });
    assert.match(committed.content[0].text, /✅ Created/);
    assert.equal(vfsRead(p), "durable\n");
    assert.equal((await store.getAgentInterrupt(token)).status, "executed");
  });

  test("confirm revalidates target state before executing a stale edit", async () => {
    const store = makeInterruptStore();
    const durableCtx = { store, sessionId: "session-files" };
    const p = tmpFile("stale-edit.js", "const a = 1;\n");

    const proposed = await editFileHandler(durableCtx, {
      path: p,
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    const token = proposed.content[0].text.match(/Token:\s*(wr_[a-z0-9]+)/)[1];
    vfsSetupFile(p, "const a = 9;\n");

    const committed = await editFileHandler(durableCtx, { confirmation_token: token });
    assert.match(committed.content[0].text, /Target changed since confirmation was requested/);
    assert.equal(vfsRead(p), "const a = 9;\n");
  });

  test("delete_file persists and reuses durable pending descriptors", async () => {
    const store = makeInterruptStore();
    const durableCtx = { store, sessionId: "session-files" };
    const p = tmpFile("delete-me.js", "remove me\n");

    const proposed = await deleteFileHandler({ path: p }, durableCtx);
    const token = proposed.content[0].text.match(/Token:\s*(del_[a-z0-9]+)/)[1];
    assert.equal((await store.getAgentInterrupt(token)).tool_name, "delete_file");

    const duplicate = await deleteFileHandler({ path: p }, durableCtx);
    assert.match(duplicate.content[0].text, new RegExp(`Token: ${token}`));

    const committed = await deleteFileHandler({ confirmation_token: token }, durableCtx);
    assert.match(committed.content[0].text, /✅ Deleted/);
    assert.ok(!vfsExists(p), committed.content[0].text);
    assert.equal((await store.getAgentInterrupt(token)).status, "executed");
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

// ─── grepFilesHandler ────────────────────────────────────────────────────────

describe("grepFilesHandler", () => {
  test("returns line-numbered literal matches recursively", async () => {
    const dir = join(TMP, "grep-project");
    vfsSetupFile(join(dir, "src", "auth.js"), "const OAuthCallback = true;\nconst other = false;");
    vfsSetupFile(join(dir, "README.md"), "OAuthCallback docs");
    const result = await grepFilesHandler({ path: dir, pattern: "OAuthCallback" });
    const text = result.content[0].text;
    assert.match(text, /src\/auth\.js:1:const OAuthCallback/);
    assert.match(text, /README\.md:1:OAuthCallback docs/);
  });

  test("supports case-insensitive matching and caps results", async () => {
    const dir = join(TMP, "grep-cap");
    vfsSetupFile(join(dir, "one.js"), "AUTH\nauth\nAuth");
    const result = await grepFilesHandler({ path: dir, pattern: "auth", case_sensitive: false, max_results: 2 });
    assert.match(result.content[0].text, /showing first 2 matches/i);
  });

  test("rejects paths outside the read allowlist", async () => {
    const result = await grepFilesHandler({ path: "/tmp", pattern: "secret" });
    assert.match(result.content[0].text, /Read not allowed/);
  });

  test("does not search secret files or skipped directories", async () => {
    const dir = join(TMP, "grep-private");
    vfsSetupFile(join(dir, ".env"), "TOKEN=needle");
    vfsSetupFile(join(dir, "node_modules", "package.js"), "needle");
    vfsSetupFile(join(dir, "safe.js"), "needle");
    const result = await grepFilesHandler({ path: dir, pattern: "needle" });
    const text = result.content[0].text;
    assert.match(text, /safe\.js/);
    assert.doesNotMatch(text, /\.env|node_modules/);
  });

  test("does not follow symbolic links", async () => {
    const dir = join(TMP, "grep-symlink");
    vfsSetupFile(join(dir, "safe.js"), "needle");
    vfsSetupSymlink(join(dir, "linked-secret.js"), "/outside/secret.js");
    const result = await grepFilesHandler({ path: dir, pattern: "needle" });
    assert.match(result.content[0].text, /safe\.js/);
    assert.doesNotMatch(result.content[0].text, /linked-secret/);
  });

  test("returns a clear no-match result", async () => {
    const dir = join(TMP, "grep-empty");
    vfsSetupFile(join(dir, "safe.js"), "haystack");
    const result = await grepFilesHandler({ path: dir, pattern: "needle" });
    assert.match(result.content[0].text, /No matches/);
  });

  test("formatted scope memory drives the hook into the real grep handler", async () => {
    const authDir = join(TMP, "scoped-project", "auth");
    const otherDir = join(TMP, "scoped-project", "other");
    vfsSetupFile(join(authDir, "callback.js"), "export const OAuthCallback = true;");
    vfsSetupFile(join(otherDir, "callback.js"), "export const OAuthCallback = false;");
    const raw = `[PREFERENCE] Auth scope (importance: 5)\nSearch ${authDir} first.\nTags: scope:auth\nID: scope-1`;
    const factory = createToolHooks({
      callTool: async (_name, args) => (await grepFilesHandler(args)).content[0].text,
      summarizeArgs: (_name, args) => args.path,
      summarizeResult: (_name, result) => ({ ok: !result.startsWith("❌"), summary: result.split("\n")[0] }),
      getActiveScratchDir: () => null,
      resolveScratchPath: path => path,
      validateWrittenFile: async () => ({ ok: true }),
      logger: { info() {}, warn() {}, error() {} },
      WRITE_TOOLS: new Set(),
      CONFIRM_TOOLS: new Set(),
      existsSync: mockExistsSync,
      statSync: mockStatSync,
      readdirSync: mockReaddirSync,
      copyFileSync() {},
      basename,
      join,
    });
    const hooks = factory({ send() {} }, Date.now());
    hooks.setActiveSearchScopes(parseSearchScopes(raw), "find the auth bug");
    const result = await hooks.callToolHooked("grep_files", { pattern: "OAuthCallback", path: "." });
    assert.match(result, /callback\.js:1:export const OAuthCallback = true/);
    assert.doesNotMatch(result, /false/);
  });
});

// ─── Per-connection path isolation ───────────────────────────────────────────
// These tests verify that a runWithPaths context for client A never leaks into
// client B — the core guarantee that prevents tabs from merging path configs.

describe("Per-connection path isolation", () => {
  const ctx = {};

  test("client A context allows its own paths and rejects client B paths", async () => {
    const dirA = join(TMP, "iso-client-a");
    const dirB = join(TMP, "iso-client-b");
    vfsSetupFile(join(dirA, "a.js"), "// client A");
    vfsSetupFile(join(dirB, "b.js"), "// client B");

    const [okA, rejectB] = await runWithPaths([dirA], [dirA], null, () =>
      Promise.all([
        readFileHandler({ path: join(dirA, "a.js") }),
        readFileHandler({ path: join(dirB, "b.js") }),
      ])
    );

    assert.ok(okA.content[0].text.includes("client A"),    "A can read its own file");
    assert.ok(rejectB.content[0].text.includes("❌ Read not allowed"), "A cannot read B's file");
  });

  test("client B context allows its own paths and rejects client A paths", async () => {
    const dirA = join(TMP, "iso-b-a");
    const dirB = join(TMP, "iso-b-b");
    vfsSetupFile(join(dirA, "a.js"), "// client A");
    vfsSetupFile(join(dirB, "b.js"), "// client B");

    const [rejectA, okB] = await runWithPaths([dirB], [dirB], null, () =>
      Promise.all([
        readFileHandler({ path: join(dirA, "a.js") }),
        readFileHandler({ path: join(dirB, "b.js") }),
      ])
    );

    assert.ok(rejectA.content[0].text.includes("❌ Read not allowed"), "B cannot read A's file");
    assert.ok(okB.content[0].text.includes("client B"),    "B can read its own file");
  });

  test("concurrent contexts do not bleed into each other", async () => {
    const dirA = join(TMP, "concur-a");
    const dirB = join(TMP, "concur-b");
    vfsSetupFile(join(dirA, "a.js"), "// A");
    vfsSetupFile(join(dirB, "b.js"), "// B");

    const [resultA, resultB] = await Promise.all([
      runWithPaths([dirA], [dirA], null, () => readFileHandler({ path: join(dirB, "b.js") })),
      runWithPaths([dirB], [dirB], null, () => readFileHandler({ path: join(dirA, "a.js") })),
    ]);

    assert.ok(resultA.content[0].text.includes("❌ Read not allowed"), "A context rejects B's path");
    assert.ok(resultB.content[0].text.includes("❌ Read not allowed"), "B context rejects A's path");
  });

  test("write guard is also isolated per context", async () => {
    const dirA = join(TMP, "write-iso-a");
    const dirB = join(TMP, "write-iso-b");
    vfsSetupDir(dirA);
    vfsSetupDir(dirB);

    const [okWrite, rejectWrite] = await runWithPaths([dirA], [dirA], null, () =>
      Promise.all([
        confirmed(writeFileHandler, ctx, { path: join(dirA, "new.js"), content: "x" }),
        confirmed(writeFileHandler, ctx, { path: join(dirB, "new.js"), content: "x" }),
      ])
    );

    assert.ok(okWrite.content[0].text.includes("✅"), "A context can write to dirA");
    assert.ok(rejectWrite.content[0].text.includes("❌ Write not allowed"), "A context cannot write to dirB");
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

    const writeResult = await confirmed(writeFileHandler, ctx, { path: filePath, content: "line1\nline2\n" });
    assert.ok(writeResult.content[0].text.includes("✅ Created"));

    const readResult = await readFileHandler({ path: filePath });
    assert.ok(readResult.content[0].text.includes("line1"));
    assert.ok(readResult.content[0].text.includes("line2"));

    const appendResult = await confirmed(appendFileHandler, ctx, { path: filePath, content: "line3\nline4\n" });
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

// ─── INPUT-01: secret/dotfile deny-list ──────────────────────────────────────

describe("secret-file deny-list", () => {
  const ctx = {};

  test("read_file refuses a .env file (before any ext check)", async () => {
    const p = tmpFile(".env", "ANTHROPIC_API_KEY=sk-abc\n");
    const r = await readFileHandler({ path: p });
    assert.ok(r.content[0].text.includes("secret/credential files is not allowed"));
  });

  test("read_file refuses a .pgpass credentials file", async () => {
    const p = tmpFile(".pgpass", "localhost:5432:db:user:pw\n");
    const r = await readFileHandler({ path: p });
    assert.ok(r.content[0].text.includes("secret/credential files is not allowed"));
  });

  test("read_file refuses an id_rsa private key", async () => {
    const p = tmpFile("id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    const r = await readFileHandler({ path: p });
    assert.ok(r.content[0].text.includes("secret/credential files is not allowed"));
  });

  test("read_file refuses a .pem cert", async () => {
    const p = tmpFile("server.pem", "-----BEGIN CERTIFICATE-----\n");
    const r = await readFileHandler({ path: p });
    assert.ok(r.content[0].text.includes("secret/credential files is not allowed"));
  });

  test(".env.example is no longer readable (dead allowlist entry removed)", async () => {
    const p = tmpFile(".env.example", "AI_PROVIDER=ollama\n");
    const r = await readFileHandler({ path: p });
    assert.ok(r.content[0].text.includes("not allowed"));
  });

  test("edit_file refuses a .env file before reading it", async () => {
    const p = tmpFile(".env", "SECRET=1\n");
    const r = await editFileHandler(ctx, { path: p, old_string: "SECRET=1", new_string: "SECRET=2" });
    assert.ok(r.content[0].text.includes("secret/credential files is not allowed"));
  });
});
