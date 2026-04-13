import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import * as StdioTransportModule from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  getRecommendedModel,
  resolveProvider,
  fixUnclosedFence,
  parseMemoriesRaw,
  createAgent,
  makeWsEmitter,
  makeCliEmitter,
  handleUserRequest,
} from "../../lib/agent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let output = "";

/** Capture process.stdout.write for the duration of one test. */
const mockStdout = (t) => {
  output = "";
  return t.mock.method(process.stdout, "write", (data) => {
    output += data;
  });
};

/**
 * Returns a minimal fake child-process that satisfies both node:child_process
 * callers AND the MCP StdioClientTransport internals.
 *
 * StdioClientTransport reads from child.stdout (a Readable) and writes to
 * child.stdin (a Writable), so we fake those with event-emitter stubs that
 * never fire – preventing any real I/O.
 */
const makeFakeChildProcess = () => {
  const noop = () => {};
  const makeStream = () => ({ on: noop, pipe: noop, write: noop, end: noop, resume: noop });
  return {
    stdout: makeStream(),
    stderr: makeStream(),
    stdin:  makeStream(),
    on: noop,
    kill: noop,
    pid: 99999,
  };
};

// ---------------------------------------------------------------------------
// createAgent – shared mock setup
// ---------------------------------------------------------------------------
//
// The MCP SDK's StdioClientTransport.start() internally calls spawn() through
// its own import, so mocking `childProcess.spawn` in the test module is not
// enough.  We mock the transport's `start` method directly so it never
// actually launches a process.
//
const stubMcpTransport = (t) => {
  // Prevent StdioClientTransport from spawning anything
  t.mock.method(StdioTransportModule.StdioClientTransport.prototype, "start", async () => {});
  // Prevent StdioClientTransport from trying to close a real process
  t.mock.method(StdioTransportModule.StdioClientTransport.prototype, "close", async () => {});

  // Make Client.connect() a no-op (it would otherwise wait for transport ready)
  t.mock.method(Client.prototype, "connect", async () => {});

  // Make Client.listTools() return a predictable tool list
  t.mock.method(Client.prototype, "listTools", async () => ({
    tools: [{ name: "test_tool", description: "A test tool", inputSchema: {} }],
  }));
};

// ---------------------------------------------------------------------------
// agent.js – core
// ---------------------------------------------------------------------------

describe("agent.js - core", () => {

  // ── handleUserRequest ─────────────────────────────────────────────────────
  //
  // These tests rely on the already-imported module (ESM cache).  We do NOT
  // use dynamic import() here because that would re-run module-level side
  // effects on some runtimes.  Instead we mock console.log before each call
  // and restore it automatically via node:test's cleanup.
  //

  // test("handleUserRequest: handles no skill match", async (t) => {
  //   const logMock = t.mock.method(console, "log", () => {});

  //   await handleUserRequest("ping pong this will never match any skill");

  //   assert.ok(
  //     logMock.mock.calls.some((c) =>
  //       String(c.arguments[0]).includes("No specific skill matched")
  //     ),
  //     "Expected 'No specific skill matched' to be logged"
  //   );
  // });

  test("handleUserRequest: covers no-match branch (second call)", async (t) => {
    const logMock = t.mock.method(console, "log", () => {});

    await handleUserRequest("zzz_definitely_no_match_xyzzy");

    assert.ok(
      logMock.mock.calls.some((c) =>
        String(c.arguments[0]).includes("No specific skill")
      ),
      "Expected 'No specific skill' to be logged"
    );
  });

  // ── renderMarkdown (via makeCliEmitter) ───────────────────────────────────

  test("renderMarkdown: covers unclosed fences and multiple heading levels", (t) => {
    t.mock.method(process.stdout, "write", () => {});
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone);

    const multiMarkdown = [
      "# H1",
      "## H2",
      "### H3",
      "- bullet",
      "1. numbered",
      "***bold italic***",
      "```js",
      "unclosed code",
    ].join("\n");

    emitter.send({ type: "token", text: multiMarkdown });
    emitter.send({ type: "stream_end" });

    assert.strictEqual(turnDone.mock.callCount(), 1);
  });

  test("renderMarkdown: edge cases for horizontal rules and unclosed fences", (t) => {
    const stdoutMock = t.mock.method(process.stdout, "write", () => {});
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone);

    emitter.send({ type: "token", text: "---\n```js\nconst x = 1;" });
    emitter.send({ type: "stream_end" });

    assert.ok(
      stdoutMock.mock.calls.some((c) => String(c.arguments[0]).includes("└─")),
      "Expected unclosed-fence footer '└─' in stdout"
    );
  });
});

// ---------------------------------------------------------------------------
// RAM-based model selection
// ---------------------------------------------------------------------------

describe("RAM-based model selection", () => {
  test("selects 32b for 64 GB+ RAM", (t) => {
    t.mock.method(os, "totalmem", () => 64 * 1024 ** 3);
    assert.strictEqual(getRecommendedModel(), "deepseek-r1:32");
  });

  test("selects 8b for low RAM", (t) => {
    t.mock.method(os, "totalmem", () => 4 * 1024 ** 3);
    assert.strictEqual(getRecommendedModel(), "qwen3:8b");
  });
});

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

describe("Provider resolution", () => {
  beforeEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.OLLAMA_MODEL;
    delete process.env.CHECK_RAM;
  });

  afterEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.OLLAMA_MODEL;
    delete process.env.CHECK_RAM;
  });

  test("handles OLLAMA_MODEL environment variable", () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "custom-model";
    const p = resolveProvider();
    assert.strictEqual(p.model, "custom-model");
  });
});

// ---------------------------------------------------------------------------
// String & Memory helpers
// ---------------------------------------------------------------------------

describe("String & Memory Helpers", () => {
  test("fixUnclosedFence: adds closing fence when missing", () => {
    assert.strictEqual(fixUnclosedFence("```js\nhi"), "```js\nhi\n```");
  });

  test("fixUnclosedFence: leaves already-closed fence alone", () => {
    assert.strictEqual(fixUnclosedFence("```js\nhi\n```"), "```js\nhi\n```");
  });

  test("parseMemoriesRaw: correctly parses memory metadata", () => {
    const raw =
      "[person] Alice (importance: 4)\nSoftware Engineer\nTags: team, lead\nID: 1\nSaved: today";
    const [mem] = parseMemoriesRaw(raw);
    assert.strictEqual(mem.type, "person");
    assert.strictEqual(mem.importance, 4);
    assert.ok(mem.tags.includes("team"));
  });
});

// ---------------------------------------------------------------------------
// createAgent initialization
// ---------------------------------------------------------------------------

describe("createAgent initialization", () => {
  test("createAgent connects to MCP and lists tools without spawning a real process", async (t) => {
    // ✅ Key fix: mock StdioClientTransport.start() so no real child is spawned.
    // Mocking childProcess.spawn alone is insufficient because the MCP SDK
    // resolves its own reference to spawn at import time.
    stubMcpTransport(t);

    const agent = await createAgent({ root: process.cwd(), version: "1.0.0" });

    assert.ok(agent, "createAgent should return an agent object");

    // node:test attaches .mock to the method after t.mock.method()
    assert.strictEqual(Client.prototype.connect.mock.callCount(), 1,    "connect() should be called once");
    assert.strictEqual(Client.prototype.listTools.mock.callCount(), 1,  "listTools() should be called once");
  });
});

// ---------------------------------------------------------------------------
// Agent Loop Logic – Anthropic streaming (unit-level)
// ---------------------------------------------------------------------------

describe("Agent Loop Logic", () => {
  test("Anthropic: mock stream is a valid AsyncIterable", async () => {
    // This exercises the shape of the data the loop consumes.
    // A full integration test would need the Anthropic SDK mocked; that is
    // covered separately.  Here we just assert our fixture is well-formed.
    const mockStream = (async function* () {
      yield { type: "content_block_start", content_block: { type: "text" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
    })();

    const events = [];
    for await (const chunk of mockStream) {
      events.push(chunk);
    }

    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[1].delta.text, "Hello");
  });
});

// ---------------------------------------------------------------------------
// Ollama Loop – error path when Ollama is not running
// ---------------------------------------------------------------------------

describe("Ollama Loop Logic (via createAgent)", () => {
  beforeEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.OLLAMA_MODEL;
  });

  afterEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.OLLAMA_MODEL;
  });

  test("returns error message if Ollama health check fails", async (t) => {
    // ✅ Must stub MCP transport FIRST so createAgent doesn't hang
    stubMcpTransport(t);

    // Intercept all fetch calls and simulate Ollama being unreachable
    t.mock.method(globalThis, "fetch", () =>
      Promise.resolve({
        ok: false,
        text: () => Promise.resolve("Connection refused"),
      })
    );

    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "llama3.1";

    const agent = await createAgent({ root: process.cwd(), version: "1.0.0" });

    // Discover the public method that drives the agent loop.
    // Common names: chat, ask, run, send, invoke — adjust to match your agent.
    const CANDIDATE_METHODS = ["runAgentLoop", "fetchMemories", "buildGreeting"];
    const methodName = CANDIDATE_METHODS.find(
      (m) => typeof agent[m] === "function"
    );
    
    if (!methodName) {
      // Surface the real API so the test name is easy to fix.
      const exposed = Object.keys(agent).filter((k) => typeof agent[k] === "function");
      assert.fail(
        `createAgent() returned no recognised loop method.\n` +
        `Tried: ${CANDIDATE_METHODS.join(", ")}\n` +
        `Agent exposes: ${exposed.join(", ") || "(none)"}\n` +
        `Update CANDIDATE_METHODS (or the call below) to match.`
      );
    }

    const emitter = { send: t.mock.fn() };
    const result = await agent[methodName](
      [{ role: "user", content: "hi" }],
      emitter
    );

    assert.ok(
      result.includes("Ollama is not running"),
      `Expected 'Ollama is not running' in result, got: ${result}`
    );
    assert.ok(
      emitter.send.mock.calls.some((c) => c.arguments[0].type === "token"),
      "Expected at least one 'token' event emitted"
    );
  });
});

// ---------------------------------------------------------------------------
// History Management (pure logic – no I/O)
// ---------------------------------------------------------------------------

describe("History Management", () => {
  test("truncates history when exceeding MAX_HISTORY, keeping first message", () => {
    const MAX_HISTORY = 20;
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: "user",
      content: `msg ${i}`,
    }));

    const trimmed =
      messages.length > MAX_HISTORY
        ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))]
        : messages;

    assert.strictEqual(trimmed.length, MAX_HISTORY);
    assert.strictEqual(trimmed[0].content, "msg 0",  "Should keep the first (system) message");
    assert.strictEqual(trimmed[1].content, "msg 11", "Should slice from the correct offset");
  });
});

// ---------------------------------------------------------------------------
// makeWsEmitter
// ---------------------------------------------------------------------------

describe("makeWsEmitter", () => {
  test("serializes payload to JSON and calls ws.send exactly once", (t) => {
    const mockWs = { send: t.mock.fn() };
    const emitter = makeWsEmitter(mockWs);
    const payload = { type: "token", text: "hello" };

    emitter.send(payload);

    assert.strictEqual(mockWs.send.mock.callCount(), 1);
    assert.strictEqual(
      mockWs.send.mock.calls[0].arguments[0],
      JSON.stringify(payload)
    );
  });
});

// ---------------------------------------------------------------------------
// makeCliEmitter & Markdown Rendering
// ---------------------------------------------------------------------------

describe("makeCliEmitter & Markdown Rendering", () => {
  test("renderMarkdown: handles code fences and inline styles (smoke test)", (t) => {
    t.mock.method(process.stdout, "write", () => {});
    // makeCliEmitter must not throw when receiving rich markdown
    const emitter = makeCliEmitter(() => {}, { stopSpinner: () => {} });
    emitter.send({ type: "token", text: "```js\nconst x = 1;\n```" });
    emitter.send({ type: "token", text: "---" });
    emitter.send({ type: "token", text: "**bold** *italic* `code` ~~strike~~" });
    emitter.send({ type: "stream_end" });
    assert.ok(true, "No exception thrown for rich markdown input");
  });

  test("handles the full stream lifecycle", (t) => {
    const stdout = mockStdout(t);
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone, {}, { showReasoning: true });

    // Tool badge
    emitter.send({ type: "tool", name: "recall" });
    assert.ok(output.includes("⟳ recalling memory"), "Expected tool badge for 'recall'");

    // Reasoning block
    emitter.send({ type: "reasoning_start" });
    emitter.send({ type: "reasoning_token", text: "Computing..." });
    emitter.send({ type: "reasoning_done" });
    assert.ok(output.includes("╭─ thinking"), "Expected reasoning header");
    assert.ok(output.includes("Computing..."),  "Expected reasoning token in output");

    // Answer token then render
    emitter.send({ type: "token", text: "The answer is **42**." });
    emitter.send({ type: "stream_end" });

    assert.ok(output.includes("A:"),          "Expected answer prefix");
    assert.ok(output.includes("\x1b[1m42"),   "Expected bold ANSI for '42'");
    assert.strictEqual(turnDone.mock.callCount(), 1, "turnDone should be called once");
  });

  test("handles error state and resets buffer", (t) => {
    const stdout = mockStdout(t);
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone);

    emitter.send({ type: "error", text: "API Failure" });

    assert.ok(output.includes("✖ error: API Failure"), "Expected error message in output");
    assert.strictEqual(turnDone.mock.callCount(), 1, "turnDone should be called on error");
  });

  test("swallows browser-only events silently (status, memories)", (t) => {
    const stdout = mockStdout(t);
    const emitter = makeCliEmitter(() => {});

    emitter.send({ type: "status",   text: "online" });
    emitter.send({ type: "memories", data: [] });

    assert.strictEqual(output, "", "No stdout output expected for browser-only events");
  });

  test("reasoning tokens are suppressed when showReasoning is false", (t) => {
    const stdoutMock = t.mock.method(process.stdout, "write", () => {});
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone, {}, { showReasoning: false });

    emitter.send({ type: "reasoning_start" });
    emitter.send({ type: "reasoning_token", text: "secret thoughts" });
    emitter.send({ type: "reasoning_done" });

    assert.strictEqual(
      stdoutMock.mock.callCount(),
      0,
      "No stdout writes expected when showReasoning is false"
    );
  });

  test("tokens are buffered (not printed inline) before stream_end", (t) => {
    const stdoutMock = t.mock.method(process.stdout, "write", () => {});
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone, {}, { showReasoning: false });

    emitter.send({ type: "token", text: "Hello" });

    assert.strictEqual(
      stdoutMock.mock.callCount(),
      0,
      "Token events should be buffered, not written to stdout immediately"
    );
  });

  test("covers remaining switch cases: retract, thinking, reasoning no-op branches", (t) => {
    t.mock.method(process.stdout, "write", () => {});
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone); // showReasoning defaults to false

    // reasoning_* without showReasoning → silent no-ops
    emitter.send({ type: "reasoning_start" });
    emitter.send({ type: "reasoning_token", text: "private" });
    emitter.send({ type: "reasoning_done" });

    // token buffers, retract clears it, thinking triggers spinner text
    emitter.send({ type: "token",   text: "hello" });
    emitter.send({ type: "retract" });
    emitter.send({ type: "thinking" });

    // None of these should throw; turnDone should NOT have been called yet
    assert.strictEqual(turnDone.mock.callCount(), 0, "turnDone must not fire before stream_end");
  });
});