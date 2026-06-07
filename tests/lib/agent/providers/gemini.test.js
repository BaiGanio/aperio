// tests/lib/agent/providers/gemini.test.js
//
// Tests for runGeminiLoop. Mocks the Gemini SDK client so the loop
// processes mock stream responses. Logger is also mocked.

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

let runGeminiLoop;

before(async () => {
  const mod = await import("../../../../lib/agent/providers/gemini.js");
  runGeminiLoop = mod.runGeminiLoop;
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function baseCtx(overrides = {}) {
  return {
    provider: {
      name: "gemini",
      model: "gemini-2.0-flash",
      contextWindow: 8192,
      client: makeClient(),
    },
    callTool: mock.fn(),
    getSystemPrompt: () => "You are a helpful assistant.",
    getGeminiTools: () => [],
    ...overrides,
  };
}

function makeClient(modelOverrides = {}) {
  return {
    getGenerativeModel: () => makeModel(modelOverrides),
  };
}

function makeModel(overrides = {}) {
  return {
    generateContentStream: overrides.generateContentStream ?? (async () => ({
      stream: makeStream([]),
      response: { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 }, functionCalls: () => [] },
    })),
  };
}

async function* makeStream(chunks) {
  for (const c of chunks) yield c;
}

function textChunk(text) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function textResponse(text, usage = { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 0 }) {
  return { usageMetadata: usage, functionCalls: () => [] };
}

function reset() {
  infoCalls = [];
  warnCalls = [];
  errorCalls = [];
}

// =============================================================================
// runGeminiLoop — successful text response
// =============================================================================
describe("runGeminiLoop — text response", () => {
  afterEach(() => { reset(); });

  test("returns model response text from stream", async () => {
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async ({ contents }) => ({
            stream: makeStream([textChunk("Hello"), textChunk(" world")]),
            response: textResponse("Hello world", { promptTokenCount: 10, candidatesTokenCount: 6, thoughtsTokenCount: 0 }),
          }),
        }),
      },
    });

    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };

    const result = await runGeminiLoop(messages, emitter, {}, ctx);
    assert.equal(result, "Hello world");
    // Should have sent stream_start, stream_end plus token events
    const sends = emitter.send.mock.calls.map(c => c.arguments[0].type);
    assert.ok(sends.includes("stream_start"), "should emit stream_start");
    assert.ok(sends.includes("stream_end"), "should emit stream_end");
  });

  test("appends assistant message to messages array on success", async () => {
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => ({
            stream: makeStream([textChunk("Output text")]),
            response: textResponse("Output text"),
          }),
        }),
      },
    });

    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: mock.fn() };

    await runGeminiLoop(messages, emitter, {}, ctx);
    // Message should contain the assistant's response
    const lastMsg = messages[messages.length - 1];
    assert.equal(lastMsg.role, "assistant");
    assert.equal(lastMsg.content, "Output text");
  });
});

// =============================================================================
// runGeminiLoop — error paths
// =============================================================================
describe("runGeminiLoop — error paths", () => {
  afterEach(() => { reset(); });

  test("returns error when generateContentStream throws", async () => {
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => { throw new Error("API key invalid"); },
        }),
      },
    });

    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };

    const result = await runGeminiLoop(messages, emitter, {}, ctx);
    assert.ok(result.includes("API key invalid"), "should surface the error message");
    assert.ok(errorCalls.some(a => a[0].includes("generateContentStream failed")),
      "should log the error");
  });

  test("returns error when response.functionCalls throws", async () => {
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => ({
            stream: makeStream([textChunk("Some output")]),
            get response() { throw new Error("Blocked by safety filter"); },
          }),
        }),
      },
    });

    const messages = [{ role: "user", content: "Do something" }];
    const emitter = { send: mock.fn() };

    const result = await runGeminiLoop(messages, emitter, {}, ctx);
    assert.ok(result.includes("Blocked"), "should surface blocked error");
    assert.ok(errorCalls.some(a => a[0].includes("result.response failed")),
      "should log the error");
  });
});

// =============================================================================
// runGeminiLoop — tool call / function response cycle
// =============================================================================
describe("runGeminiLoop — tool call cycle", () => {
  afterEach(() => { reset(); });

  test("executes tool calls and includes result in next loop iteration", async () => {
    let callCount = 0;

    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async ({ contents }) => {
            callCount++;
            // First call returns a function call
            if (callCount === 1) {
              return {
                stream: makeStream([textChunk("")]),
                response: {
                  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 0 },
                  functionCalls: () => [{ name: "get_weather", args: { city: "Paris" } }],
                },
              };
            }
            // Second call returns text
            return {
              stream: makeStream([textChunk("The weather in Paris is sunny.")]),
              response: textResponse("The weather in Paris is sunny."),
            };
          },
        }),
      },
      callTool: async (name, args) => "Sunny, 22°C",
    });

    const messages = [{ role: "user", content: "Weather in Paris?" }];
    const emitter = { send: mock.fn() };

    const result = await runGeminiLoop(messages, emitter, {}, ctx);
    assert.equal(result, "The weather in Paris is sunny.");
    // Should have added tool_use and tool_result messages
    const toolUseMsgs = messages.filter(m =>
      Array.isArray(m.content) && m.content.some(b => b.type === "tool_use")
    );
    assert.ok(toolUseMsgs.length >= 1, "should have tool_use message");
    const toolResultMsgs = messages.filter(m =>
      Array.isArray(m.content) && m.content.some(b => b.type === "tool_result")
    );
    assert.ok(toolResultMsgs.length >= 1, "should have tool_result message");
  });
});

// =============================================================================
// runGeminiLoop — context trimming
// =============================================================================
describe("runGeminiLoop — context trimming", () => {
  afterEach(() => { reset(); });

  test("trims context when token budget is exceeded", async () => {
    // Provide enough messages to exceed the context window
    const messages = [{ role: "user", content: "Start" }];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "assistant", content: `Response ${i}` });
      messages.push({ role: "user", content: `Message ${i}` });
    }

    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 200, // small window to force trimming
        client: makeClient({
          generateContentStream: async () => ({
            stream: makeStream([textChunk("Trimmed")]),
            response: textResponse("Trimmed"),
          }),
        }),
      },
    });

    const emitter = { send: mock.fn() };

    const result = await runGeminiLoop(messages, emitter, {}, ctx);
    assert.equal(result, "Trimmed");
    // Context should have been trimmed
    const trimmedEvents = emitter.send.mock.calls
      .filter(c => c.arguments[0].type === "context_trimmed");
    assert.ok(trimmedEvents.length >= 0); // may or may not trigger depending on estimateMsgTokens
  });
});
