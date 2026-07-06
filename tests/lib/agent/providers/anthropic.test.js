// tests/lib/agent/providers/anthropic.test.js
//
// Tests for runAnthropicLoop. Mocks provider.client.messages.stream
// to return a mock async generator of SDK events, and mocks logger.

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

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

// ─── Dynamic import ───────────────────────────────────────────────────────

let runAnthropicLoop;

before(async () => {
  const mod = await import("../../../../lib/agent/providers/anthropic.js");
  runAnthropicLoop = mod.runAnthropicLoop;
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function testProvider(streamImpl) {
  return {
    name: "anthropic",
    model: "claude-sonnet-4-20250514",
    contextWindow: 64000,
    client: { messages: { stream: streamImpl } },
  };
}

function baseCtx(overrides = {}) {
  return {
    provider: testProvider(async function*() {}),
    callTool: mock.fn(async () => "Tool result"),
    getSystemPrompt: () => "You are a helpful assistant.",
    getAnthropicTools: () => [],
    ...overrides,
  };
}

// ─── Stream factories ─────────────────────────────────────────────────────

async function* textStream() {
  yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } };
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } };
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } };
  yield { type: "content_block_stop", index: 0 };
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } };
}

async function* toolStream() {
    yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } };
    yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check" } };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu-1", name: "get_time", input: {} } };
    yield { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } };
    yield { type: "content_block_stop", index: 1 };
    yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 15 } };
}

function reset() {
  infoCalls = [];
  warnCalls = [];
  errorCalls = [];
}

// =============================================================================
// Text response
// =============================================================================
describe("runAnthropicLoop — text response", () => {
  afterEach(() => { reset(); });

  test("returns model response text", async () => {
    const ctx = baseCtx({ provider: testProvider(textStream) });
    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: mock.fn() };

    const result = await runAnthropicLoop(messages, emitter, {}, ctx);
    assert.equal(result, "Hello world");
  });

  test("emits stream_start and stream_end", async () => {
    const ctx = baseCtx({ provider: testProvider(textStream) });
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };

    await runAnthropicLoop(messages, emitter, {}, ctx);
    const types = emitter.send.mock.calls.map(c => c.arguments[0].type);
    assert.ok(types.includes("stream_start"));
    assert.ok(types.includes("stream_end"));
  });

  test("appends assistant message to messages array", async () => {
    const ctx = baseCtx({ provider: testProvider(textStream) });
    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: mock.fn() };

    await runAnthropicLoop(messages, emitter, {}, ctx);
    const lastMsg = messages[messages.length - 1];
    assert.equal(lastMsg.role, "assistant");
    assert.equal(lastMsg.content[0].type, "text");
    assert.ok(lastMsg.content[0].text.includes("Hello world"));
  });

  test("uses prepared canonical context and serializes tools in the adapter", async () => {
    let wireRequest;
    const provider = testProvider(request => {
      wireRequest = request;
      return textStream();
    });
    const prepareModelContext = mock.fn(async () => ({
      messages: [{ role: "user", content: "prepared message" }],
      systemPrompt: "prepared system",
      tools: [{
        name: "recall",
        description: "Search memory",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }],
    }));
    const ctx = baseCtx({
      provider,
      prepareModelContext,
      getSystemPrompt: () => { throw new Error("legacy prompt path used"); },
      getAnthropicTools: () => { throw new Error("legacy tool path used"); },
    });

    await runAnthropicLoop([{ role: "user", content: "raw message" }], { send: mock.fn() }, {}, ctx);

    assert.equal(prepareModelContext.mock.callCount(), 1);
    assert.equal(wireRequest.system, "prepared system");
    assert.deepEqual(wireRequest.messages, [{ role: "user", content: "prepared message" }]);
    assert.deepEqual(wireRequest.tools, [{
      name: "recall",
      description: "Search memory",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }]);
  });
});

// =============================================================================
// Tool call cycle
// =============================================================================
describe("runAnthropicLoop — tool call cycle", () => {
  afterEach(() => { reset(); });

  test("executes tool calls and loops back for text response", async () => {
    let callCount = 0;
    const switchingStream = () => {
      callCount++;
      return callCount === 1 ? toolStream() : textStream();
    };

    const ctx = baseCtx({
      provider: testProvider(switchingStream),
      callTool: async () => "12:00",
    });

    const messages = [{ role: "user", content: "What time is it?" }];
    const emitter = { send: mock.fn() };

    const result = await runAnthropicLoop(messages, emitter, {}, ctx);
    assert.equal(result, "Hello world");

    assert.ok(messages.some(m =>
      m.role === "assistant" && Array.isArray(m.content) && m.content.some(b => b.type === "tool_use")
    ), "should have tool_use in assistant message");

    assert.ok(messages.some(m =>
      m.role === "user" && Array.isArray(m.content) && m.content.some(b => b.type === "tool_result")
    ), "should have tool_result in user message");
  });
});

// =============================================================================
// Error handling
// =============================================================================
describe("runAnthropicLoop — error handling", () => {
  afterEach(() => { reset(); });

  test("throws when stream creation fails", async () => {
    const ctx = baseCtx({
      provider: testProvider(() => { throw new Error("API connection failed"); }),
    });
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };

    await assert.rejects(
      () => runAnthropicLoop(messages, emitter, {}, ctx),
      { message: /API connection failed/ }
    );
  });

  test("throws when stream iteration errors", async () => {
    const throwingStream = async function*() {
      yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } };
      throw new Error("Stream interrupted");
    };

    const ctx = baseCtx({ provider: testProvider(throwingStream) });
    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: mock.fn() };

    await assert.rejects(
      () => runAnthropicLoop(messages, emitter, {}, ctx),
      { message: /Stream interrupted/ }
    );
  });
});

// =============================================================================
// Context trimming
// =============================================================================
describe("runAnthropicLoop — context trimming", () => {
  afterEach(() => { reset(); });

  test("handles large message history gracefully", async () => {
    const ctx = baseCtx({
      provider: {
        name: "anthropic", model: "claude-sonnet",
        contextWindow: 200,
        client: { messages: { stream: textStream } },
      },
    });

    const messages = [{ role: "user", content: "Start" }];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "assistant", content: `Response ${i}` });
      messages.push({ role: "user", content: `Message ${i}` });
    }

    const emitter = { send: mock.fn() };
    const result = await runAnthropicLoop(messages, emitter, {}, ctx);
    assert.equal(result, "Hello world");
  });
});
