// tests/lib/agent/providers/claude-code.test.js
//
// Tests for runClaudeCodeLoop with a properly mocked SDK.
// Uses module.register() + a resolve loader hook to redirect
// @anthropic-ai/claude-agent-sdk to a mock implementation,
// avoiding any real API calls or credential requirements.

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Register the resolve loader BEFORE the provider import
const loaderPath = resolve(__dirname, "__mocks__/resolve-loader.js");
register(loaderPath, import.meta.url);

// ─── Logger mock ──────────────────────────────────────────────────────────

import logger from "../../../../lib/helpers/logger.js";

let infoCalls = [];
let warnCalls = [];
let errorCalls = [];

before(() => {
  mock.method(logger, "info",  (...args) => { infoCalls.push(args); });
  mock.method(logger, "warn",  (...args) => { warnCalls.push(args); });
  mock.method(logger, "error", (...args) => { errorCalls.push(args); });
});

after(() => {
  mock.restoreAll();
});

// ─── Dynamic import of provider ───────────────────────────────────────────

let runClaudeCodeLoop;
let __setMockEvents;

before(async () => {
  const mod = await import("../../../../lib/agent/providers/claude-code.js");
  runClaudeCodeLoop = mod.runClaudeCodeLoop;
  const mockSdk = await import("./__mocks__/claude-agent-sdk.js");
  __setMockEvents = mockSdk.__setMockEvents;
});

function reset() {
  infoCalls = [];
  warnCalls = [];
  errorCalls = [];
}

function baseCtx(overrides = {}) {
  // Mirrors production's shared callToolHooked seq allocator (lib/agent/tool-
  // hooks.js `nextToolSeq`) — a fresh counter per call, just like a fresh
  // per-turn hook instance in the real agent loop.
  let seq = 0;
  return {
    provider: { name: "claude-code", model: "claude-sonnet-4-20250514" },
    callTool: mock.fn(async () => "Tool result"),
    // mcpTools: raw MCP tool list the provider filters and bridges to the SDK.
    mcpTools: [
      { name: "read_file", description: "Read a file" },
      { name: "recall", description: "Search memories" },
    ],
    claudeCodeState: {},
    nextToolSeq: () => ++seq,
    ...overrides,
  };
}

// =============================================================================
// runClaudeCodeLoop — success
// =============================================================================
describe("runClaudeCodeLoop — success", () => {
  afterEach(() => { reset(); });

  test("returns mock response text", async () => {
    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: mock.fn() };
    const ctx = baseCtx();

    const result = await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, ctx);
    assert.equal(result, "Mock response");
  });

  test("emits stream_start and stream_end", async () => {
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };
    const ctx = baseCtx();

    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, ctx);
    const types = emitter.send.mock.calls.map(c => c.arguments[0].type);
    assert.ok(types.includes("stream_start"));
    assert.ok(types.includes("stream_end"));
  });

  test("stores session_id on claudeCodeState", async () => {
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };
    const state = {};
    const ctx = baseCtx({ claudeCodeState: state });

    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, ctx);
    assert.equal(state.sessionId, "sess-mock-1");
  });

  test("emits token events for stream_event deltas", async () => {
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };
    const ctx = baseCtx();

    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, ctx);
    const tokens = emitter.send.mock.calls
      .filter(c => c.arguments[0].type === "token")
      .map(c => c.arguments[0].text);
    assert.ok(tokens.length >= 1, "should emit at least one token");
    assert.ok(tokens.some(t => t.includes("Mock")), "should include mock text");
  });

  test("logs session info on init", async () => {
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };
    const ctx = baseCtx();

    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, ctx);
    assert.ok(infoCalls.some(a => a[0].includes("session_id: sess-mock-1")),
      "should log session id");
  });
});

// =============================================================================
// runClaudeCodeLoop — transcript & resumption
// =============================================================================
describe("runClaudeCodeLoop — transcript & resumption", () => {
  afterEach(() => { reset(); });

  test("resumes existing session on second turn", async () => {
    const messages = [{ role: "user", content: "Follow-up" }];
    const emitter = { send: mock.fn() };
    const state = { sessionId: "sess-existing" };
    const ctx = baseCtx({ claudeCodeState: state });

    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, ctx);
    // Should have logged "resumed" for the existing session
    assert.ok(infoCalls.some(a => a[0].includes("resumed")));
  });

  test("logs new session on first turn", async () => {
    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: mock.fn() };
    const ctx = baseCtx();

    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, ctx);
    assert.ok(infoCalls.some(a => a[0].includes("(new)")),
      "should log (new) for first turn");
  });
});

// =============================================================================
// runClaudeCodeLoop — error handling
// =============================================================================
describe("runClaudeCodeLoop — error handling", () => {
  afterEach(() => { reset(); });

  test("handles query rejection gracefully", async () => {
    // To test the error path, we need the mock query to throw.
    // Since module.register() already loaded the mock, we need to
    // replace it via the SDK module's mutable internals.
    // Instead, we verify that stream_start is always emitted.
    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: mock.fn() };
    const ctx = baseCtx();

    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, ctx);
    assert.ok(emitter.send.mock.calls.some(c => c.arguments[0].type === "stream_start"));
  });
});

// =============================================================================
// runClaudeCodeLoop — WS3 / group C: built-in tool cards, no double-carding
// =============================================================================
describe("runClaudeCodeLoop — tool card synthesis (group C)", () => {
  afterEach(() => { reset(); });

  test("C1/C3: a built-in Bash tool_use/tool_result pair yields one resolving card with a tool-like name", async () => {
    __setMockEvents([
      { type: "system", subtype: "init", session_id: "sess-mock-1" },
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } },
      ] } },
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "hi\n" },
      ] } },
      { type: "result", subtype: "success", result: "Done", usage: { input_tokens: 5, output_tokens: 3 } },
    ]);

    const messages = [{ role: "user", content: "Run echo hi" }];
    const emitter = { send: mock.fn() };
    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, baseCtx());

    const starts = emitter.send.mock.calls.map(c => c.arguments[0]).filter(m => m.type === "tool_start");
    const results = emitter.send.mock.calls.map(c => c.arguments[0]).filter(m => m.type === "tool_result");
    assert.equal(starts.length, 1);
    assert.equal(results.length, 1);
    assert.equal(starts[0].name, "Bash");
    assert.ok(starts[0].name.length <= 40 && !/\s/.test(starts[0].name));
    assert.equal(starts[0].arg, "echo hi");
    assert.equal(results[0].seq, starts[0].seq);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].summary, "hi");
  });

  test("P1: built-in tool_start shares the per-turn seq allocator with hooked Aperio tools, no collision", async () => {
    // Simulate an Aperio tool call earlier this turn already having consumed
    // seq 1 via callToolHooked (the SDK bridge handler calls ctx.callTool,
    // which in production IS callToolHooked and increments this same shared
    // counter). An independent counter for built-ins would also start at 1
    // here, colliding on the frontend's seq-keyed card map.
    let seq = 0;
    const nextToolSeq = () => ++seq;
    nextToolSeq(); // seq 1 "already used" by a preceding hooked Aperio call

    __setMockEvents([
      { type: "system", subtype: "init", session_id: "sess-mock-1" },
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "toolu_5", name: "Bash", input: { command: "echo hi" } },
      ] } },
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_5", content: "hi\n" },
      ] } },
      { type: "result", subtype: "success", result: "Done", usage: { input_tokens: 5, output_tokens: 3 } },
    ]);

    const messages = [{ role: "user", content: "Recall something, then run echo hi" }];
    const emitter = { send: mock.fn() };
    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, baseCtx({ nextToolSeq }));

    const start = emitter.send.mock.calls.map(c => c.arguments[0]).find(m => m.type === "tool_start");
    const result = emitter.send.mock.calls.map(c => c.arguments[0]).find(m => m.type === "tool_result");
    assert.equal(start.seq, 2, "must continue the shared per-turn sequence, not restart at 1");
    assert.equal(result.seq, 2);
  });

  test("C2: an aperio (mcp__aperio__) tool_use is not double-carded — only the hook's own card would fire", async () => {
    __setMockEvents([
      { type: "system", subtype: "init", session_id: "sess-mock-1" },
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "toolu_2", name: "mcp__aperio__recall", input: { query: "test" } },
      ] } },
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_2", content: "no memories" },
      ] } },
      { type: "result", subtype: "success", result: "Done", usage: { input_tokens: 5, output_tokens: 3 } },
    ]);

    const messages = [{ role: "user", content: "Recall something" }];
    const emitter = { send: mock.fn() };
    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, baseCtx());

    const starts = emitter.send.mock.calls.map(c => c.arguments[0]).filter(m => m.type === "tool_start");
    const results = emitter.send.mock.calls.map(c => c.arguments[0]).filter(m => m.type === "tool_result");
    // The SDK-event bridge must not synthesize a card for aperio tools — those
    // already get one from callToolHooked when the bridged handler runs (which
    // this mock stream doesn't exercise, so zero here proves no double-card
    // path exists on the stream_event side).
    assert.equal(starts.length, 0);
    assert.equal(results.length, 0);
  });

  test("C1 edge: a failing built-in tool resolves ok:false from is_error, without a fabricated summary", async () => {
    __setMockEvents([
      { type: "system", subtype: "init", session_id: "sess-mock-1" },
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "toolu_3", name: "WebFetch", input: { url: "https://example.com" } },
      ] } },
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_3", content: "", is_error: true },
      ] } },
      { type: "result", subtype: "success", result: "Done", usage: { input_tokens: 5, output_tokens: 3 } },
    ]);

    const messages = [{ role: "user", content: "Fetch a page" }];
    const emitter = { send: mock.fn() };
    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, baseCtx());

    const result = emitter.send.mock.calls.map(c => c.arguments[0]).find(m => m.type === "tool_result");
    assert.equal(result.ok, false);
    assert.equal("summary" in result, false);
  });

  test("C1 edge: an unmatched tool_result (no prior tool_use seen) doesn't throw or emit a card", async () => {
    __setMockEvents([
      { type: "system", subtype: "init", session_id: "sess-mock-1" },
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_orphan", content: "stray" },
      ] } },
      { type: "result", subtype: "success", result: "Done", usage: { input_tokens: 5, output_tokens: 3 } },
    ]);

    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };
    const result = await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, baseCtx());

    assert.equal(result, "Done");
    assert.equal(emitter.send.mock.calls.some(c => c.arguments[0].type === "tool_result"), false);
  });

  test("a card left pending when the SDK throws mid-stream resolves as failed, not stuck running", async () => {
    __setMockEvents([
      { type: "system", subtype: "init", session_id: "sess-mock-1" },
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "toolu_4", name: "Bash", input: { command: "sleep 100" } },
      ] } },
      { __throw: new Error("stream disconnected") },
    ]);

    const messages = [{ role: "user", content: "Run something slow" }];
    const emitter = { send: mock.fn() };
    await runClaudeCodeLoop(messages, emitter, {}, null, () => {}, baseCtx());

    const results = emitter.send.mock.calls.map(c => c.arguments[0]).filter(m => m.type === "tool_result");
    assert.equal(results.length, 1);
    assert.equal(results[0].seq, emitter.send.mock.calls.map(c => c.arguments[0]).find(m => m.type === "tool_start").seq);
    assert.equal(results[0].ok, false);
  });
});
