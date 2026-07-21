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

  test("emits tool activity for command and MCP items with canonical names", async () => {
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
            { type: "item.started", item: { id: "item_0", type: "command_execution", command: "npm test" } },
            { type: "item.started", item: { id: "item_1", type: "mcp_tool_call", tool: "recall", server: "aperio" } },
            { type: "item.completed", item: { type: "agent_message", text: "Done" } },
          ],
        }),
      }),
    );

    // Surface #10 fix: the shell item's legacy label uses the canonical tool
    // name, not the raw command text (that lives in tool_start.arg instead).
    const tools = emitter.send.mock.calls
      .filter(c => c.arguments[0].type === "tool")
      .map(c => c.arguments[0].name);
    assert.deepEqual(tools, ["run_shell", "recall"]);
  });

  // ─── WS3 / group C — tool_start/tool_result card synthesis ────────────────

  describe("tool card synthesis (group C)", () => {
    test("C1: shell, mcp, and web_search items yield a resolving tool_start/tool_result pair", async () => {
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
              { type: "item.started", item: { id: "item_0", type: "command_execution", command: "echo hi", status: "in_progress", exit_code: null, aggregated_output: "" } },
              { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "echo hi", status: "completed", exit_code: 0, aggregated_output: "hi\n" } },
              { type: "item.started", item: { id: "item_1", type: "mcp_tool_call", tool: "recall", server: "aperio", status: "in_progress" } },
              { type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", tool: "recall", server: "aperio", status: "completed" } },
              { type: "item.started", item: { id: "item_2", type: "web_search", query: "aperio docs", status: "in_progress" } },
              { type: "item.completed", item: { id: "item_2", type: "web_search", query: "aperio docs", status: "completed" } },
              { type: "item.completed", item: { type: "agent_message", text: "Done" } },
            ],
          }),
        }),
      );

      const starts = emitter.send.mock.calls.map(c => c.arguments[0]).filter(m => m.type === "tool_start");
      const results = emitter.send.mock.calls.map(c => c.arguments[0]).filter(m => m.type === "tool_result");

      assert.equal(starts.length, 3);
      assert.equal(results.length, 3);

      // seq: unique, monotonically increasing, and shared between start/result pairs
      const seqs = starts.map(s => s.seq);
      assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b), "seqs must be unique");
      assert.deepEqual(seqs, [1, 2, 3]);
      assert.deepEqual(results.map(r => r.seq), seqs);

      const shellStart = starts[0];
      assert.equal(shellStart.name, "run_shell");
      assert.equal(shellStart.arg, "echo hi");
      const shellResult = results[0];
      assert.equal(shellResult.ok, true);
      assert.equal(shellResult.summary, "hi");
      assert.equal(typeof shellResult.ms, "number");

      const mcpStart = starts[1];
      assert.equal(mcpStart.name, "recall");
      const mcpResult = results[1];
      assert.equal(mcpResult.ok, true);
      // The codex item stream carries no result text for mcp_tool_call — never
      // fabricate one.
      assert.equal("summary" in mcpResult, false);

      const searchStart = starts[2];
      assert.equal(searchStart.name, "web_search");
      assert.equal(searchStart.arg, '"aperio docs"');
    });

    test("C1 edge: a failed shell command resolves ok:false without inventing a timing/summary it never reported", async () => {
      const emitter = { send: mock.fn() };
      await runCodexLoop(
        [{ role: "user", content: "Run a failing command" }],
        emitter,
        {},
        null,
        () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: {},
            stdoutLines: [
              { type: "item.started", item: { id: "item_0", type: "command_execution", command: "false", status: "in_progress" } },
              { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "false", status: "failed", exit_code: 1, aggregated_output: "" } },
              { type: "item.completed", item: { type: "agent_message", text: "It failed" } },
            ],
          }),
        }),
      );

      const result = emitter.send.mock.calls.map(c => c.arguments[0]).find(m => m.type === "tool_result");
      assert.equal(result.ok, false);
      assert.equal("summary" in result, false);
    });

    test("C1 edge: item.completed without a matching item.started does not throw or emit a card", async () => {
      const emitter = { send: mock.fn() };
      const result = await runCodexLoop(
        [{ role: "user", content: "Hi" }],
        emitter,
        {},
        null,
        () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: {},
            stdoutLines: [
              { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "echo hi", status: "completed", exit_code: 0 } },
              { type: "item.completed", item: { type: "agent_message", text: "Done" } },
            ],
          }),
        }),
      );

      assert.equal(result, "Done");
      assert.equal(emitter.send.mock.calls.some(c => c.arguments[0].type === "tool_result"), false);
    });

    test("C1 edge: unknown item types emit no tool_start/tool_result/tool card", async () => {
      const emitter = { send: mock.fn() };
      await runCodexLoop(
        [{ role: "user", content: "Hi" }],
        emitter,
        {},
        null,
        () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: {},
            stdoutLines: [
              { type: "item.started", item: { id: "item_0", type: "reasoning" } },
              { type: "item.completed", item: { id: "item_0", type: "reasoning" } },
              { type: "item.completed", item: { type: "agent_message", text: "Done" } },
            ],
          }),
        }),
      );

      const types = emitter.send.mock.calls.map(c => c.arguments[0].type);
      assert.equal(types.includes("tool"), false);
      assert.equal(types.includes("tool_start"), false);
      assert.equal(types.includes("tool_result"), false);
    });

    test("C1 edge: a declined item (approval policy rejected it) resolves ok:false, not a fabricated success", async () => {
      const emitter = { send: mock.fn() };
      await runCodexLoop(
        [{ role: "user", content: "Run something risky" }],
        emitter,
        {},
        null,
        () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: {},
            stdoutLines: [
              { type: "item.started", item: { id: "item_0", type: "command_execution", command: "rm -rf /", status: "in_progress" } },
              { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "rm -rf /", status: "declined" } },
              { type: "item.completed", item: { type: "agent_message", text: "Declined" } },
            ],
          }),
        }),
      );

      const result = emitter.send.mock.calls.map(c => c.arguments[0]).find(m => m.type === "tool_result");
      assert.equal(result.ok, false);
    });

    test("a card left pending when the process exits without item.completed resolves as failed, not stuck running", async () => {
      const emitter = { send: mock.fn() };
      await runCodexLoop(
        [{ role: "user", content: "Run a slow command" }],
        emitter,
        {},
        null,
        () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: {},
            // No item.completed for item_0 at all — process just exits (e.g. crash).
            stdoutLines: [
              { type: "item.started", item: { id: "item_0", type: "command_execution", command: "sleep 100" } },
            ],
          }),
        }),
      );

      const results = emitter.send.mock.calls.map(c => c.arguments[0]).filter(m => m.type === "tool_result");
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, false);
      assert.equal(typeof results[0].ms, "number");
    });

    test("a card left pending when the turn is aborted resolves as failed, not stuck running", async () => {
      const controller = new AbortController();
      const emitter = { send: mock.fn() };
      await runCodexLoop(
        [{ role: "user", content: "Stop mid-tool" }],
        emitter,
        {},
        () => controller,
        () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: {},
            stdoutLines: [
              { type: "item.started", item: { id: "item_0", type: "command_execution", command: "sleep 100" } },
            ],
            beforeClose: () => { controller.abort(); },
          }),
        }),
      );

      const results = emitter.send.mock.calls.map(c => c.arguments[0]).filter(m => m.type === "tool_result");
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, false);
    });

    // C3 — chip label sanity: every name the codex bridge can emit is short
    // and tool-like, never a raw command dump.
    test("C3: emitted tool names stay short and tool-like, never a raw command line", async () => {
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
              { type: "item.started", item: { id: "item_0", type: "command_execution", command: "git log --oneline -n 50 --all --source --graph" } },
              { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "git log --oneline -n 50 --all --source --graph", status: "completed", exit_code: 0 } },
              { type: "item.completed", item: { type: "agent_message", text: "Done" } },
            ],
          }),
        }),
      );

      const names = emitter.send.mock.calls
        .map(c => c.arguments[0])
        .filter(m => m.type === "tool_start" || m.type === "tool")
        .map(m => m.name);
      for (const name of names) {
        assert.ok(name.length <= 40, `name "${name}" should be <=40 chars`);
        assert.ok(!/\s/.test(name), `name "${name}" should not contain whitespace`);
      }
    });
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

  // ─── WS4 / group D — reasoning parity ──────────────────────────────────────
  // Verified live (2026-07-21): `--json` never emits a `reasoning` item unless
  // `-c model_reasoning_summary=<auto|concise|detailed>` is passed — the CLI's
  // own config.toml default only applies to the interactive TUI, not `codex
  // exec`. `reasoning_output_tokens` in turn.completed.usage is unaffected
  // either way (already correctly wired pre-WS4, see the D2 assertion in
  // "returns final agent message and stores thread id" above).
  describe("reasoning parity (group D)", () => {
    afterEach(() => { delete process.env.CODEX_REASONING_SUMMARY; });

    test("D1: passes model_reasoning_summary=auto by default", async () => {
      const capture = {};
      await runCodexLoop(
        [{ role: "user", content: "Hi" }],
        { send: mock.fn() }, {}, null, () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture,
            stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
          }),
        }),
      );
      assert.ok(capture.args.includes('model_reasoning_summary="auto"'));
    });

    test("D1: honors CODEX_REASONING_SUMMARY override, falls back to auto on an invalid value", async () => {
      process.env.CODEX_REASONING_SUMMARY = "detailed";
      const capture = {};
      await runCodexLoop(
        [{ role: "user", content: "Hi" }],
        { send: mock.fn() }, {}, null, () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture,
            stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
          }),
        }),
      );
      assert.ok(capture.args.includes('model_reasoning_summary="detailed"'));

      process.env.CODEX_REASONING_SUMMARY = "bogus";
      const capture2 = {};
      await runCodexLoop(
        [{ role: "user", content: "Hi" }],
        { send: mock.fn() }, {}, null, () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: capture2,
            stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
          }),
        }),
      );
      assert.ok(capture2.args.includes('model_reasoning_summary="auto"'));
    });

    test("D1: a completed reasoning item (no item.started) emits reasoning_start -> reasoning_token -> reasoning_done before the answer token", async () => {
      const emitter = { send: mock.fn() };
      await runCodexLoop(
        [{ role: "user", content: "Think about it" }],
        emitter, {}, null, () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: {},
            stdoutLines: [
              { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Planning the answer**" } },
              { type: "item.completed", item: { type: "agent_message", text: "42" } },
            ],
          }),
        }),
      );

      const events = emitter.send.mock.calls.map(c => c.arguments[0]);
      const types = events.map(e => e.type);
      const startIdx = types.indexOf("reasoning_start");
      const tokenIdx = types.indexOf("reasoning_token");
      const doneIdx = types.indexOf("reasoning_done");
      const firstAnswerTokenIdx = events.findIndex(e => e.type === "token" && e.text === "42");

      assert.ok(startIdx !== -1 && tokenIdx !== -1 && doneIdx !== -1, "all three reasoning events must fire");
      assert.ok(startIdx < tokenIdx && tokenIdx < doneIdx, "reasoning_start -> reasoning_token -> reasoning_done");
      assert.ok(doneIdx < firstAnswerTokenIdx, "reasoning_done must precede the first answer token");
      assert.equal(events[tokenIdx].text, "**Planning the answer**");
      // No plain `token` event may carry reasoning text.
      assert.ok(!events.some(e => e.type === "token" && e.text.includes("Planning the answer")));
    });

    test("D1: an item.started+item.completed reasoning pair still yields exactly one reasoning_start/done pair (no double bubble)", async () => {
      const emitter = { send: mock.fn() };
      await runCodexLoop(
        [{ role: "user", content: "Think about it" }],
        emitter, {}, null, () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: {},
            stdoutLines: [
              { type: "item.started", item: { id: "item_0", type: "reasoning" } },
              { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
              { type: "item.completed", item: { type: "agent_message", text: "Done" } },
            ],
          }),
        }),
      );
      const types = emitter.send.mock.calls.map(c => c.arguments[0].type);
      assert.equal(types.filter(t => t === "reasoning_start").length, 1);
      assert.equal(types.filter(t => t === "reasoning_done").length, 1);
    });

    test("D1: multiple reasoning items across a turn each get their own start/token/done triplet", async () => {
      const emitter = { send: mock.fn() };
      await runCodexLoop(
        [{ role: "user", content: "Use a tool then think again" }],
        emitter, {}, null, () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: {},
            stdoutLines: [
              { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "first thought" } },
              { type: "item.started", item: { id: "item_1", type: "command_execution", command: "echo hi", status: "in_progress" } },
              { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "echo hi", status: "completed", exit_code: 0 } },
              { type: "item.completed", item: { id: "item_2", type: "reasoning", text: "second thought" } },
              { type: "item.completed", item: { type: "agent_message", text: "Done" } },
            ],
          }),
        }),
      );
      const events = emitter.send.mock.calls.map(c => c.arguments[0]);
      assert.equal(events.filter(e => e.type === "reasoning_start").length, 2);
      assert.equal(events.filter(e => e.type === "reasoning_done").length, 2);
      assert.deepEqual(events.filter(e => e.type === "reasoning_token").map(e => e.text), ["first thought", "second thought"]);
    });

    test("D1 edge: a reasoning item with no text still opens and closes the bubble without emitting an empty reasoning_token", async () => {
      const emitter = { send: mock.fn() };
      await runCodexLoop(
        [{ role: "user", content: "Hi" }],
        emitter, {}, null, () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: {},
            stdoutLines: [
              { type: "item.completed", item: { id: "item_0", type: "reasoning" } },
              { type: "item.completed", item: { type: "agent_message", text: "Done" } },
            ],
          }),
        }),
      );
      const types = emitter.send.mock.calls.map(c => c.arguments[0].type);
      assert.equal(types.filter(t => t === "reasoning_start").length, 1);
      assert.equal(types.filter(t => t === "reasoning_done").length, 1);
      assert.equal(types.includes("reasoning_token"), false);
    });

    test("D1 edge: a reasoning item still open when the process exits (aborted mid-turn) closes the bubble instead of leaving it stuck", async () => {
      const emitter = { send: mock.fn() };
      await runCodexLoop(
        [{ role: "user", content: "Hi" }],
        emitter, {}, null, () => {},
        baseCtx({
          codexSpawn: mockChild({
            capture: {},
            stdoutLines: [{ type: "item.started", item: { id: "item_0", type: "reasoning" } }],
          }),
        }),
      );
      const types = emitter.send.mock.calls.map(c => c.arguments[0].type);
      assert.equal(types.filter(t => t === "reasoning_start").length, 1);
      assert.equal(types.filter(t => t === "reasoning_done").length, 1);
    });
  });
});
