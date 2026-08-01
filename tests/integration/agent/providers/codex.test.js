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

function mockWriteFileSync(path, data) {
  vfsSetFile(path, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
}

function mockUnlinkSync(path) {
  if (!vfs.has(path)) throw Object.assign(new Error(`ENOENT: '${path}'`), { code: "ENOENT" });
  vfs.delete(path);
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
mock.method(fsSync, "writeFileSync", mockWriteFileSync);
mock.method(fsSync, "unlinkSync", mockUnlinkSync);

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
    delete process.env.CODEX_TURN_MAX_TOOL_CALLS;
    delete process.env.CODEX_TURN_MAX_STEPS;
    delete process.env.CODEX_TURN_TIMEOUT_MS;
    delete process.env.CODEX_TURN_MAX_PROCESSED_TOKENS;
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
    assert.equal(capture.args.at(-2), "--");
    assert.equal(capture.args.at(-1), "Hello");
    assert.ok(emitter.send.mock.calls.some(c => c.arguments[0].type === "stream_start"));
    const end = emitter.send.mock.calls.find(c => c.arguments[0].type === "stream_end").arguments[0];
    assert.equal(end.usage.input_tokens, 10);
    assert.equal(end.usage.input_tokens_kind, "aggregate");
    assert.equal(end.usage.cache_read_input_tokens, 4);
    assert.equal(end.usage.thinking_tokens, 2);
  });

  test("records deterministic turn metrics without confusing aggregate usage", async () => {
    const emitter = { send: mock.fn() };
    await runCodexLoop(
      [{ role: "user", content: "Use one tool" }],
      emitter, {}, null, () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture: {},
          stdoutLines: [
            { type: "item.started", item: { id: "item_0", type: "command_execution", command: "echo hi" } },
            { type: "item.completed", item: { id: "item_0", type: "command_execution", status: "completed", exit_code: 0 } },
            { type: "item.completed", item: { type: "agent_message", text: "Done" } },
            { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 3 } },
          ],
        }),
      }),
    );

    const end = emitter.send.mock.calls.find(c => c.arguments[0].type === "stream_end").arguments[0];
    assert.equal(end.usage.input_tokens, 120);
    assert.equal(end.usage.input_tokens_kind, "aggregate");
    assert.equal(end.usage.tool_calls, 1);
    assert.equal(typeof end.usage.elapsed_ms, "number");
    assert.equal(end.usage.guardrail, null);
  });

  test("interrupts a pathological tool loop at the configured tool-call budget", async () => {
    process.env.CODEX_TURN_MAX_TOOL_CALLS = "1";
    const emitter = { send: mock.fn() };
    const result = await runCodexLoop(
      [{ role: "user", content: "Keep investigating" }],
      emitter, {}, null, () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture: {},
          stdoutLines: [
            { type: "item.started", item: { id: "item_0", type: "command_execution", command: "echo one" } },
            { type: "item.completed", item: { id: "item_0", type: "command_execution", status: "completed", exit_code: 0 } },
            { type: "item.started", item: { id: "item_1", type: "command_execution", command: "echo two" } },
            { type: "item.completed", item: { id: "item_1", type: "command_execution", status: "completed", exit_code: 0 } },
          ],
        }),
      }),
    );

    assert.match(result, /turn limit reached/i);
    const end = emitter.send.mock.calls.find(c => c.arguments[0].type === "stream_end").arguments[0];
    assert.equal(end.usage.tool_calls, 2);
    assert.deepEqual(end.usage.guardrail, {
      kind: "tool_calls", limit: 1, value: 2,
      enforcement: "live", setting: "CODEX_TURN_MAX_TOOL_CALLS",
    });
    assert.equal(emitter.send.mock.calls.filter(c => c.arguments[0].type === "tool_start").length, 1);
  });

  test("interrupts distinct internal work at the configured step budget", async () => {
    process.env.CODEX_TURN_MAX_STEPS = "1";
    const emitter = { send: mock.fn() };
    const result = await runCodexLoop(
      [{ role: "user", content: "Think then act" }],
      emitter, {}, null, () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture: {},
          stdoutLines: [
            { type: "item.started", item: { id: "reason-1", type: "reasoning" } },
            { type: "item.completed", item: { id: "reason-1", type: "reasoning", text: "plan" } },
            { type: "item.started", item: { id: "tool-1", type: "command_execution", command: "echo work" } },
          ],
        }),
      }),
    );

    assert.match(result, /CODEX_TURN_MAX_STEPS/);
    const end = emitter.send.mock.calls.find(c => c.arguments[0].type === "stream_end").arguments[0];
    assert.deepEqual(end.usage.guardrail, {
      kind: "internal_steps", limit: 1, value: 2,
      enforcement: "live", setting: "CODEX_TURN_MAX_STEPS",
    });
    assert.equal(end.usage.internal_steps, 2);
  });

  test("reports processed-token exhaustion when Codex returns aggregate usage", async () => {
    process.env.CODEX_TURN_MAX_PROCESSED_TOKENS = "100";
    const emitter = { send: mock.fn() };
    const result = await runCodexLoop(
      [{ role: "user", content: "Answer" }],
      emitter, {}, null, () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture: {},
          stdoutLines: [
            { type: "item.completed", item: { type: "agent_message", text: "Too much work" } },
            { type: "turn.completed", usage: { input_tokens: 101, cached_input_tokens: 90, output_tokens: 5 } },
          ],
        }),
      }),
    );

    assert.match(result, /observed aggregate-token ceiling/i);
    assert.match(result, /Too much work/);
    const end = emitter.send.mock.calls.find(c => c.arguments[0].type === "stream_end").arguments[0];
    assert.deepEqual(end.usage.guardrail, {
      kind: "processed_tokens", limit: 100, value: 101,
      enforcement: "observed", setting: "CODEX_TURN_MAX_PROCESSED_TOKENS",
    });
  });

  test("interrupts a stalled Codex process at the configured elapsed-time budget", async () => {
    const emitter = { send: mock.fn() };
    let now = 0;
    const result = await runCodexLoop(
      [{ role: "user", content: "Wait" }],
      emitter, {}, null, () => {},
      baseCtx({
        codexSpawn: (command, args, options) => {
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          setImmediate(() => {
            child.stdout.push(null);
            child.stderr.push(null);
            child.emit("close", 0);
          });
          return child;
        },
        codexSetTimeout: callback => {
          now = 1;
          callback();
          return { unref() {} };
        },
        codexClearTimeout: () => {},
        codexClock: { now: () => now },
        codexTurnEnv: { CODEX_TURN_TIMEOUT_MS: "1" },
      }),
    );

    assert.match(result, /turn limit reached/i);
    const end = emitter.send.mock.calls.find(c => c.arguments[0].type === "stream_end").arguments[0];
    assert.equal(end.usage.guardrail.kind, "elapsed_ms");
    assert.ok(end.usage.elapsed_ms >= 1);
  });

  // ─── WS-A1 / group G — image passthrough ─────────────────────────────────
  describe("image passthrough (group G)", () => {
    const PNG_BASE64 = Buffer.from("fake-png-bytes").toString("base64");

    test("G1: one image block becomes one -i <tempfile> pair, file holds the decoded bytes, zero images means no -i arg", async () => {
      const scratch = "/fake/aperture-project/var/scratch/session-g1";
      const capture = {};
      let contentDuringRun;
      await runCodexLoop(
        [{ role: "user", content: [
          { type: "text", text: "What's in this image?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        ] }],
        { send: mock.fn() },
        {},
        null,
        () => {},
        baseCtx({
          getActiveScratchDir: () => scratch,
          codexSpawn: mockChild({
            capture,
            stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
            // Snapshot the temp file's content while codex is still "running",
            // before this turn's post-exit cleanup (group G2) removes it.
            beforeClose: () => {
              const imgArg = capture.args.find(arg => arg.startsWith("--image="));
              const imgPath = imgArg.slice("--image=".length);
              contentDuringRun = vfsGet(imgPath);
            },
          }),
        }),
      );

      const imgArg = capture.args.find(arg => arg.startsWith("--image="));
      assert.ok(imgArg, "expected an --image=<path> argument in codex args");
      const imgPath = imgArg.slice("--image=".length);
      assert.ok(imgPath.startsWith(scratch), "temp image path should live under the scratch dir");
      assert.ok(contentDuringRun, "temp image file should have existed while codex was running");
      assert.equal(contentDuringRun.content.toString("base64"), PNG_BASE64);

      // No image blocks at all → no --image arg (regression guard).
      const capture2 = {};
      await runCodexLoop(
        [{ role: "user", content: "Hello, no image here" }],
        { send: mock.fn() }, {}, null, () => {},
        baseCtx({
          getActiveScratchDir: () => scratch,
          codexSpawn: mockChild({
            capture: capture2,
            stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
          }),
        }),
      );
      assert.equal(capture2.args.some(arg => arg.startsWith("--image=")), false);
    });

    test("G1 edge: two images in one turn produce two distinct --image=<path> args", async () => {
      const scratch = "/fake/aperture-project/var/scratch/session-g1b";
      const capture = {};
      await runCodexLoop(
        [{ role: "user", content: [
          { type: "text", text: "Compare these" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG_BASE64 } },
        ] }],
        { send: mock.fn() }, {}, null, () => {},
        baseCtx({
          getActiveScratchDir: () => scratch,
          codexSpawn: mockChild({
            capture,
            stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
          }),
        }),
      );

      const paths = capture.args.reduce((acc, arg, i) => {
        if (arg.startsWith("--image=")) acc.push(arg.slice("--image=".length));
        return acc;
      }, []);
      assert.equal(paths.length, 2);
      assert.notEqual(paths[0], paths[1]);
      assert.match(capture.args.at(-1), /Compare these/);
    });

    test("G2: per-turn image temp files no longer exist once the codex child has exited", async () => {
      const scratch = "/fake/aperture-project/var/scratch/session-g2";
      const capture = {};
      await runCodexLoop(
        [{ role: "user", content: [
          { type: "text", text: "What's this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
        ] }],
        { send: mock.fn() }, {}, null, () => {},
        baseCtx({
          getActiveScratchDir: () => scratch,
          codexSpawn: mockChild({
            capture,
            stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
          }),
        }),
      );

      const imgArg = capture.args.find(arg => arg.startsWith("--image="));
      const imgPath = imgArg.slice("--image=".length);
      assert.equal(vfsGet(imgPath), undefined, "temp image file should be cleaned up after the turn");
    });
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

  // ─── WS-B / group I — skill matcher reuse ─────────────────────────────────
  // Deviation from the original plan text (noted at implementation time): the
  // plan called for codex to invoke the full `ctx.prepareModelContext`, but
  // that would fold Aperio's entire base identity/persona/memory-pointer
  // prompt into every codex turn on top of codex's own AGENTS.md-driven
  // identity — real, avoidable prompt bloat every turn. `ctx.getSkillsBlock`
  // is the same skill-content-only helper WS-B already specifies for
  // claude-code (to avoid a parallel identity conflict there); reusing it for
  // both keeps the "reuse Aperio's own skill matcher" objective without the
  // duplication cost.
  test("I1: calls ctx.getSkillsBlock once and its returned content reaches the constructed prompt", async () => {
    const getSkillsBlock = mock.fn(() => "## SKILL_CONTENT_MARKER\ndo the thing");
    const capture = {};
    await runCodexLoop(
      [{ role: "user", content: "Use the pptx skill" }],
      { send: mock.fn() },
      { lang: "en" },
      null,
      () => {},
      baseCtx({
        getSkillsBlock,
        codexSpawn: mockChild({
          capture,
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
        }),
      }),
    );

    assert.equal(getSkillsBlock.mock.calls.length, 1);
    assert.equal(getSkillsBlock.mock.calls[0].arguments[0], "Use the pptx skill");
    assert.equal(getSkillsBlock.mock.calls[0].arguments[1], "en");
    assert.match(capture.args.at(-1), /SKILL_CONTENT_MARKER/);
  });

  test("I1 edge: skill content and opts.extraSystem both reach the prompt without clobbering each other", async () => {
    const capture = {};
    await runCodexLoop(
      [{ role: "user", content: "Use the pptx skill" }],
      { send: mock.fn() },
      { extraSystem: "Session scratch workspace: /tmp/session-i1" },
      null,
      () => {},
      baseCtx({
        getSkillsBlock: () => "## SKILL_CONTENT_MARKER",
        codexSpawn: mockChild({
          capture,
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
        }),
      }),
    );

    assert.match(capture.args.at(-1), /SKILL_CONTENT_MARKER/);
    assert.match(capture.args.at(-1), /Session scratch workspace: \/tmp\/session-i1/);
  });

  test("I1 edge: an absent ctx.getSkillsBlock (e.g. an older ctx shape) doesn't throw", async () => {
    const capture = {};
    const result = await runCodexLoop(
      [{ role: "user", content: "Hello" }],
      { send: mock.fn() }, {}, null, () => {},
      baseCtx({
        codexSpawn: mockChild({
          capture,
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
        }),
      }),
    );
    assert.equal(result, "Done");
  });

  // ─── WS6/F2 superseded by WS-B (group I above) ────────────────────────────
  // provider-native-capabilities WS-B wires skill matching in via the narrow
  // ctx.getSkillsBlock (group I), not the full ctx.getSystemPrompt — codex
  // still never calls getSystemPrompt itself (that would duplicate Aperio's
  // whole base identity prompt on top of codex's own AGENTS.md-driven
  // identity). This guard now documents that permanent design choice rather
  // than a still-open gap.
  test("F2: never calls ctx.getSystemPrompt (skill content is injected via ctx.getSkillsBlock instead)", async () => {
    const getSystemPrompt = mock.fn(() => "should not be called");
    await runCodexLoop(
      [{ role: "user", content: "Hello" }],
      { send: mock.fn() },
      {},
      null,
      () => {},
      baseCtx({
        getSystemPrompt,
        codexSpawn: mockChild({
          capture: {},
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
        }),
      }),
    );

    assert.equal(getSystemPrompt.mock.calls.length, 0);
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
    assert.equal(capture.args[resumeAt + 2], "--");
    assert.equal(capture.args[resumeAt + 3], "Follow up");
  });

  test("protects a skill-frontmatter prompt from CLI option parsing", async () => {
    const capture = {};
    await runCodexLoop(
      [{ role: "user", content: "Write a helper" }],
      { send: mock.fn() },
      {},
      null,
      () => {},
      baseCtx({
        getSkillsBlock: () => "---\nname: code-simplification\n---\nSimplify safely.",
        codexSpawn: mockChild({
          capture,
          stdoutLines: [{ type: "item.completed", item: { type: "agent_message", text: "Done" } }],
        }),
      }),
    );

    assert.equal(capture.args.at(-2), "--");
    assert.match(capture.args.at(-1), /^---\nname: code-simplification/);
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
    assert.equal(capture.args.includes("--ephemeral"), true);
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
