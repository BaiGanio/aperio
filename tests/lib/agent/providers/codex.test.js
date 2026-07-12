import { mock, test, describe, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "module";

// ─── In-memory VFS ────────────────────────────────────────────────────────────
// Zero real disk access. The VFS backs every fs call that codex.js makes
// (readdirSync, mkdirSync, renameSync, statSync).

const vfs = new Map(); // path → { type: "file"|"dir", content: "" }

function vfsGet(path) { return vfs.get(path); }

function vfsEnsureDir(path) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) { cur += "/" + p; if (!vfs.has(cur)) vfs.set(cur, { type: "dir" }); }
}

function vfsSetFile(path, content = "") {
  const parent = path.substring(0, path.lastIndexOf("/"));
  if (parent) vfsEnsureDir(parent);
  vfs.set(path, { type: "file", content });
}

// ─── Mock fs implementations ──────────────────────────────────────────────────

function mockReaddirSync(path, opts) {
  const e = vfs.get(path);
  if (!e || e.type !== "dir") {
    throw Object.assign(new Error(`ENOENT: no such directory, scandir '${path}'`), { code: "ENOENT" });
  }
  const prefix = path === "/" ? "/" : path + "/";
  const children = new Set();
  for (const key of vfs.keys()) {
    if (key.startsWith(prefix)) {
      const seg = key.slice(prefix.length).split("/")[0];
      if (seg) children.add(seg);
    }
  }
  const names = [...children].sort();
  if (opts?.withFileTypes) {
    return names.map(name => {
      const full = prefix + name;
      const entry = vfs.get(full);
      return {
        name,
        isFile: () => entry?.type === "file",
        isDirectory: () => entry?.type === "dir",
        isSymbolicLink: () => false,
      };
    });
  }
  return names;
}

function mockMkdirSync(path, opts) {
  if (opts?.recursive) { vfsEnsureDir(path); return; }
  if (vfs.has(path)) throw Object.assign(new Error(`EEXIST: '${path}'`), { code: "EEXIST" });
  vfs.set(path, { type: "dir" });
}

function mockRenameSync(oldPath, newPath) {
  const e = vfs.get(oldPath);
  if (!e) throw Object.assign(new Error(`ENOENT: '${oldPath}'`), { code: "ENOENT" });
  const newParent = newPath.substring(0, newPath.lastIndexOf("/"));
  if (newParent) vfsEnsureDir(newParent);
  // If destination exists and is a file, overwrite; codex.js checks statSync first
  vfs.delete(oldPath);
  vfs.set(newPath, e);
}

function mockStatSync(path) {
  const e = vfs.get(path);
  if (!e) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
  return {
    size: e.type === "file" ? Buffer.byteLength(e.content ?? "", "utf8") : 0,
    isDirectory: () => e.type === "dir",
    isFile: () => e.type === "file",
    isSymbolicLink: () => false,
  };
}

// ─── Patch CJS module objects BEFORE importing codex.js ───────────────────────
// Node.js reads named-export values from the CJS module cache at first-import
// time.  Patching before the dynamic import ensures codex.js sees our mocks.

const requireMod = createRequire(import.meta.url);
const fsSync = requireMod("fs");

const realReaddirSync = fsSync.readdirSync;
mock.method(fsSync, "readdirSync", mockReaddirSync);
mock.method(fsSync, "mkdirSync", mockMkdirSync);
mock.method(fsSync, "renameSync", mockRenameSync);
mock.method(fsSync, "statSync", mockStatSync);

// Dynamic import: codex.js loads here and binds to our patched functions.
const { runCodexLoop } = await import("../../../../lib/agent/providers/codex.js");

// ─── Spawn mock (unchanged from original) ─────────────────────────────────────

function mockChild({ stdoutLines = [], stderr = "", code = 0, error = null, capture, beforeClose }) {
  return function spawn(command, args, options) {
    capture.command = command;
    capture.args = args;
    capture.options = options;

    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    queueMicrotask(() => {
      for (const line of stdoutLines) child.stdout.push(`${JSON.stringify(line)}\n`);
      child.stdout.push(null);
      if (stderr) child.stderr.push(stderr);
      child.stderr.push(null);
      setImmediate(() => {
        beforeClose?.();
        if (error) child.emit("error", error);
        else child.emit("close", code);
      });
    });

    return child;
  };
}

// Synthetic root — never a real path on the user's machine.
const FAKE_ROOT = "/fake/aperture-project";

function baseCtx(overrides = {}) {
  return {
    provider: { name: "codex", model: "gpt-5.5" },
    root: FAKE_ROOT,
    codexState: {},
    ...overrides,
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

before(() => {
  // Ensure the fake root directory exists in the VFS so rootArtifactSnapshot
  // doesn't throw when it calls readdirSync on it.
  vfsEnsureDir(FAKE_ROOT);
});

after(() => {
  mock.restoreAll();
  vfs.clear();
});

// =============================================================================
// Tests
// =============================================================================

describe("runCodexLoop", () => {
  afterEach(() => {
    // Don't restoreAll — that would undo our fs mocks. Just clean env.
    delete process.env.CODEX_SANDBOX;
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_MCP_APPROVAL_MODE;
    delete process.env.CODEX_API_KEY;
  });

  test("returns final agent message and stores thread id", async () => {
    delete process.env.CODEX_SANDBOX;
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_MCP_APPROVAL_MODE;
    const capture = {};
    const emitter = { send: mock.fn() };
    const state = {};
    const result = await runCodexLoop(
      [{ role: "user", content: "Hello" }],
      emitter,
      {},
      null,
      () => {},
      baseCtx({
        codexState: state,
        codexSpawn: mockChild({
          capture,
          stdoutLines: [
            { type: "thread.started", thread_id: "thread-1" },
            { type: "item.completed", item: { type: "agent_message", text: "Codex response" } },
            { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2 } },
          ],
        }),
      }),
    );

    assert.equal(result, "Codex response");
    assert.equal(state.sessionId, "thread-1");
    assert.equal(capture.command, "codex");
    assert.ok(capture.args.includes("--json"));
    assert.ok(capture.args.includes("--ignore-user-config"));
    assert.equal(capture.args[capture.args.indexOf("--sandbox") + 1], "workspace-write");
    assert.ok(capture.args.includes('mcp_servers.aperio.default_tools_approval_mode="approve"'));
    assert.ok(emitter.send.mock.calls.some(c => c.arguments[0].type === "stream_start"));
    const end = emitter.send.mock.calls.find(c => c.arguments[0].type === "stream_end").arguments[0];
    assert.equal(end.usage.input_tokens, 10);
    assert.equal(end.usage.input_tokens_kind, "aggregate");
    assert.equal(end.usage.cache_read_input_tokens, 4);
    assert.equal(end.usage.thinking_tokens, 2);
  });

  test("falls back from invalid ambient CLI enum settings", async () => {
    process.env.CODEX_SANDBOX = "seatbelt";
    process.env.CODEX_APPROVAL_POLICY = "interactive";
    process.env.CODEX_MCP_APPROVAL_MODE = "invalid";
    const capture = {};
    await runCodexLoop(
      [{ role: "user", content: "Hello" }],
      { send: mock.fn() },
      {},
      null,
      () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture,
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
        }),
      }),
    );

    assert.equal(capture.args[capture.args.indexOf("--sandbox") + 1], "workspace-write");
    assert.ok(capture.args.includes('approval_policy="never"'));
    assert.ok(capture.args.includes('mcp_servers.aperio.default_tools_approval_mode="approve"'));
  });

  test("emits tool activity for command and MCP items", async () => {
    const emitter = { send: mock.fn() };
    await runCodexLoop(
      [{ role: "user", content: "Use tools" }],
      emitter,
      {},
      null,
      () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture: {},
          stdoutLines: [
            { type: "item.started", item: { type: "command_execution", command: "npm test" } },
            { type: "item.started", item: { type: "mcp_tool_call", tool: "recall", server: "aperio" } },
            { type: "item.completed", item: { type: "agent_message", text: "Done" } },
          ],
        }),
      }),
    );

    const tools = emitter.send.mock.calls
      .filter(c => c.arguments[0].type === "tool")
      .map(c => c.arguments[0].name);
    assert.deepEqual(tools, ["npm test", "recall"]);
  });

  test("separates multiple assistant message items", async () => {
    const emitter = { send: mock.fn() };
    await runCodexLoop(
      [{ role: "user", content: "Create a file" }],
      emitter,
      {},
      null,
      () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture: {},
          stdoutLines: [
            { type: "item.completed", item: { type: "agent_message", text: "Creating it now." } },
            { type: "item.started", item: { type: "file_change", path: "test.csv" } },
            { type: "item.completed", item: { type: "agent_message", text: "Saved the file." } },
          ],
        }),
      }),
    );

    const text = emitter.send.mock.calls
      .filter(c => c.arguments[0].type === "token")
      .map(c => c.arguments[0].text)
      .join("");
    assert.equal(text, "Creating it now.\n\nSaved the file.");
  });

  test("uses resume subcommand when a session id exists", async () => {
    const capture = {};
    await runCodexLoop(
      [{ role: "user", content: "Follow up" }],
      { send: mock.fn() },
      {},
      null,
      () => {},
      baseCtx({
        codexState: { sessionId: "thread-existing" },
        codexSpawn: mockChild({
          capture,
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Resumed" } }],
        }),
      }),
    );

    const resumeAt = capture.args.indexOf("resume");
    assert.ok(resumeAt > 0);
    assert.equal(capture.args[resumeAt + 1], "thread-existing");
    assert.equal(capture.args[resumeAt + 2], "Follow up");
  });

  test("bootstraps a new thread with compact local history", async () => {
    const capture = {};
    await runCodexLoop(
      [
        { role: "user", content: "Original question" },
        { role: "assistant", content: "[Conversation summary]\n- Important decision" },
        { role: "user", content: "Continue from there" },
      ],
      { send: mock.fn() },
      { aperioSessionId: "aperio-session-new" },
      null,
      () => {},
      baseCtx({
        getProviderSessionId: () => null,
        codexSpawn: mockChild({
          capture,
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
        }),
      }),
    );

    assert.equal(capture.args.includes("resume"), false);
    const prompt = capture.args.at(-1);
    assert.match(prompt, /Original question/);
    assert.match(prompt, /Important decision/);
    assert.match(prompt, /Current user request\nContinue from there/);
  });

  test("isolated turns neither resume nor replace the persisted chat thread", async () => {
    const capture = {};
    const updates = [];
    const state = { sessionId: "global-thread" };
    await runCodexLoop(
      [{ role: "user", content: "Summarize this" }],
      { send: mock.fn() },
      { aperioSessionId: "aperio-session-1", isolatedProviderSession: true },
      null,
      () => {},
      baseCtx({
        codexState: state,
        getProviderSessionId: () => "persisted-thread",
        updateProviderSessionId: (...args) => updates.push(args),
        codexSpawn: mockChild({
          capture,
          stdoutLines: [
            { type: "thread.started", thread_id: "isolated-thread" },
            { type: "item.completed", item: { type: "agent_message", text: "Summary" } },
          ],
        }),
      }),
    );

    assert.equal(capture.args.includes("resume"), false);
    assert.equal(state.sessionId, "global-thread");
    assert.deepEqual(updates, []);
  });

  test("passes CODEX_API_KEY through to codex exec", async () => {
    process.env.CODEX_API_KEY = "codex-test-key";
    const capture = {};
    await runCodexLoop(
      [{ role: "user", content: "Hello" }],
      { send: mock.fn() },
      {},
      null,
      () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture,
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
        }),
      }),
    );

    assert.equal(capture.options.env.CODEX_API_KEY, "codex-test-key");
  });

  test("loads and persists a thread id scoped to the Aperio session", async () => {
    const capture = {};
    const updates = [];
    await runCodexLoop(
      [{ role: "user", content: "Continue" }],
      { send: mock.fn() },
      { aperioSessionId: "aperio-session-1" },
      null,
      () => {},
      baseCtx({
        codexState: { sessionId: "global-thread-must-not-be-used" },
        getProviderSessionId: (id, key) => {
          assert.equal(id, "aperio-session-1");
          assert.equal(key, "codex");
          return "persisted-thread";
        },
        updateProviderSessionId: (...args) => updates.push(args),
        codexSpawn: mockChild({
          capture,
          stdoutLines: [
            { type: "thread.started", thread_id: "persisted-thread" },
            { type: "item.completed", item: { type: "agent_message", text: "Done" } },
          ],
        }),
      }),
    );

    const resumeAt = capture.args.indexOf("resume");
    assert.equal(capture.args[resumeAt + 1], "persisted-thread");
    assert.deepEqual(updates, [["aperio-session-1", "codex", "persisted-thread"]]);
  });

  test("treats an aborted child as a clean stopped turn", async () => {
    const controller = new AbortController();
    controller.abort();
    const emitter = { send: mock.fn() };
    const result = await runCodexLoop(
      [{ role: "user", content: "Stop" }],
      emitter,
      {},
      () => controller,
      () => {},
      baseCtx({
        codexSpawn: mockChild({ capture: {}, error: new Error("The operation was aborted") }),
      }),
    );

    assert.equal(result, "");
    assert.equal(
      emitter.send.mock.calls.some(c => c.arguments[0].text?.includes("provider error")),
      false,
    );
  });

  test("reports turn.failed even when the process exits zero", async () => {
    const result = await runCodexLoop(
      [{ role: "user", content: "Hello" }],
      { send: mock.fn() },
      {},
      null,
      () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture: {},
          stdoutLines: [{ type: "turn.failed", error: { message: "rate limited" } }],
        }),
      }),
    );
    assert.match(result, /Codex provider error: rate limited/);
  });

  test("reports a missing final response", async () => {
    const result = await runCodexLoop(
      [{ role: "user", content: "Hello" }],
      { send: mock.fn() },
      {},
      null,
      () => {},
      baseCtx({ codexSpawn: mockChild({ capture: {}, stdoutLines: [{ type: "turn.completed" }] }) }),
    );
    assert.match(result, /without a final response/);
  });

  test("passes the session workspace directive to Codex", async () => {
    const capture = {};
    await runCodexLoop(
      [{ role: "user", content: "Create report.csv" }],
      { send: mock.fn() },
      { extraSystem: "Session scratch workspace: /tmp/session-123" },
      null,
      () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture,
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
        }),
      }),
    );

    assert.match(capture.args.at(-1), /Session scratch workspace: \/tmp\/session-123/);
    assert.match(capture.args.at(-1), /Create report\.csv/);
  });

  test("routes GitHub issue URLs directly through the Aperio issue tools", async () => {
    const capture = {};
    await runCodexLoop(
      [{ role: "user", content: "check and follow https://github.com/owner/repo/issues/229" }],
      { send: mock.fn() }, {}, null, () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture,
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
        }),
      }),
    );
    const prompt = capture.args.at(-1);
    assert.match(prompt, /fetch_github_issue/);
    assert.match(prompt, /Do not try web search, curl, shell commands, repository grep/);
    assert.match(prompt, /update_github_issue/);
  });

  test("relocates new root artifacts but leaves source-code files in place", async () => {
    const root = "/fake/codex-session-root";
    const scratch = root + "/var/scratch/session-1";
    vfsEnsureDir(root);

    const emitter = { send: mock.fn() };
    const beforeSnapshot = new Set(); // empty root — nothing to snapshot

    await runCodexLoop(
      [{ role: "user", content: "Create report.csv and feature.js" }],
      emitter,
      { root, extraSystem: `Session scratch workspace: ${scratch}` },
      null,
      () => {},
      baseCtx({
        root,
        getActiveScratchDir: () => scratch,
        codexSpawn: mockChild({
          capture: {},
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Created files" } }],
          beforeClose: () => {
            // Simulate Codex writing files into the root directory
            vfsSetFile(root + "/report.csv", "name,score\nAda,95\n");
            vfsSetFile(root + "/feature.js", "export const feature = true;\n");
          },
        }),
      }),
    );

    // After relocation: artifact (.csv) moved to scratch, source-code (.js) stays
    const csvInRoot = vfsGet(root + "/report.csv");
    const csvInScratch = vfsGet(scratch + "/report.csv");
    const jsInRoot = vfsGet(root + "/feature.js");

    assert.equal(csvInRoot, undefined, "report.csv should have been moved out of root");
    assert.ok(csvInScratch, "report.csv should be in scratch dir");
    assert.ok(jsInRoot, "feature.js should remain in root (source code)");

    const card = emitter.send.mock.calls.find(c => c.arguments[0].type === "generated_file")?.arguments[0];
    assert.equal(card?.url, "/scratch/session-1/report.csv");
  });

  test("reports nonzero process exits as provider errors", async () => {
    const emitter = { send: mock.fn() };
    const result = await runCodexLoop(
      [{ role: "user", content: "Hello" }],
      emitter,
      {},
      null,
      () => {},
      baseCtx({
        codexSpawn: mockChild({ capture: {}, stderr: "auth failed", code: 1 }),
      }),
    );

    assert.match(result, /Codex provider error: auth failed/);
    assert.ok(emitter.send.mock.calls.some(c => c.arguments[0].type === "token" && c.arguments[0].text.includes("auth failed")));
  });
});
