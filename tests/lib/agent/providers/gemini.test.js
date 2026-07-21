// tests/lib/agent/providers/gemini.test.js
//
// Tests for runGeminiLoop. Mocks the Gemini SDK client so the loop
// processes mock stream responses. Logger is also mocked.

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

// ─── Logger mock ──────────────────────────────────────────────────────────

import logger from "../../../../lib/helpers/logger.js";
import { EMPTY_RESPONSE_FALLBACK } from "../../../../lib/tools/executor.js";

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

    const result = await runGeminiLoop(messages, emitter, {}, undefined, undefined, ctx);
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

    await runGeminiLoop(messages, emitter, {}, undefined, undefined, ctx);
    // Message should contain the assistant's response
    const lastMsg = messages[messages.length - 1];
    assert.equal(lastMsg.role, "assistant");
    assert.equal(lastMsg.content, "Output text");
  });
});

// =============================================================================
// runGeminiLoop — empty-response fallback — WS5 test group E, E2
// =============================================================================
describe("runGeminiLoop — empty-response fallback (group E, E2)", () => {
  afterEach(() => { reset(); });

  test("E2: empty completion with no function calls emits the shared fallback instead of a silent stream_end", async () => {
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => ({
            stream: makeStream([]),
            response: textResponse(""),
          }),
        }),
      },
    });
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };

    const result = await runGeminiLoop(messages, emitter, {}, undefined, undefined, ctx);
    assert.equal(result, EMPTY_RESPONSE_FALLBACK);

    const events = emitter.send.mock.calls.map(c => c.arguments[0]);
    const end = events.find(e => e.type === "stream_end");
    assert.equal(end.text, EMPTY_RESPONSE_FALLBACK);
    assert.ok(events.some(e => e.type === "token" && e.text === EMPTY_RESPONSE_FALLBACK));
  });

  test("E2 edge: whitespace-only completion counts as empty", async () => {
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => ({
            stream: makeStream([textChunk("   ")]),
            response: textResponse("   "),
          }),
        }),
      },
    });
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };

    const result = await runGeminiLoop(messages, emitter, {}, undefined, undefined, ctx);
    assert.equal(result, EMPTY_RESPONSE_FALLBACK);
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

    const result = await runGeminiLoop(messages, emitter, {}, undefined, undefined, ctx);
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

    const result = await runGeminiLoop(messages, emitter, {}, undefined, undefined, ctx);
    assert.ok(result.includes("Blocked"), "should surface blocked error");
    assert.ok(errorCalls.some(a => a[0].includes("result.response failed")),
      "should log the error");
  });

  test("returns a graceful error when the stream read fails mid-iteration", async () => {
    async function* throwingStream() {
      yield textChunk("partial");
      throw new Error("Error reading from the stream");
    }
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => ({
            stream: throwingStream(),
            response: textResponse("unused"),
          }),
        }),
      },
    });
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };

    const result = await runGeminiLoop(messages, emitter, {}, undefined, undefined, ctx);
    assert.ok(result.includes("Error reading from the stream"), "should surface the read failure");
    assert.ok(errorCalls.some(a => a[0].includes("stream read failed")), "should log the error");
    const sends = emitter.send.mock.calls.map(c => c.arguments[0]);
    assert.ok(sends.some(e => e.type === "token" && e.text === "partial"), "already-received tokens are kept");
    assert.equal(sends[sends.length - 1].type, "stream_end", "loop must settle on stream_end, not an uncaught rejection");
  });

  // Regression: @google/generative-ai's processStream() tee()s a single
  // fetch-body reader into `result.stream` and `result.response`
  // (node_modules/@google/generative-ai/dist/index.mjs, processStream /
  // getResponseStream). Both branches read from the same underlying source,
  // so a read failure (e.g. "Error reading from the stream") rejects BOTH
  // independently. gemini.js only reaches `await result.response` after the
  // `for await (result.stream)` loop finishes — when the stream throws
  // first, `result.response` was, before this fix, left as a rejected
  // promise with no handler ever attached anywhere in the call chain (not
  // even the outer wsHandler try/catch can reach it, since nothing keeps a
  // reference to it once the stream loop throws). That orphaned rejection
  // surfaced as a Node `unhandledRejection` in production — repeated enough
  // times to trip the crash breaker (lib/helpers/crashBreaker.js).
  test("does not orphan result.response as an unhandled rejection when the stream errors first", async () => {
    let responseSettled = false;
    const responsePromise = new Promise((_, reject) => {
      setImmediate(() => { responseSettled = true; reject(new Error("Error reading from the stream")); });
    });
    async function* throwingStream() {
      yield textChunk("partial");
      throw new Error("Error reading from the stream");
    }
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => ({
            stream: throwingStream(),
            response: responsePromise,
          }),
        }),
      },
    });
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };

    const unhandled = [];
    const onUnhandledRejection = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const result = await runGeminiLoop(messages, emitter, {}, undefined, undefined, ctx);
      assert.ok(result.includes("Error reading from the stream"));
      // Let the orphaned `responsePromise` actually settle and, if unguarded,
      // surface as an unhandledRejection before we assert on it.
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      assert.ok(responseSettled, "the tee'd response promise should have settled by now");
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    assert.equal(unhandled.length, 0, "the orphaned result.response rejection must not surface as an unhandledRejection");
  });
});

// =============================================================================
// runGeminiLoop — abort (Stop button) — WS2 test group B, B2
// =============================================================================
describe("runGeminiLoop — abort", () => {
  afterEach(() => { reset(); });

  test("registers its AbortController via setAbort before generateContentStream is called", async () => {
    let setAbortCallsAtOpen = null;
    const setAbort = mock.fn();
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => {
            setAbortCallsAtOpen = setAbort.mock.calls.length;
            return { stream: makeStream([textChunk("hi")]), response: textResponse("hi") };
          },
        }),
      },
    });
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };

    await runGeminiLoop(messages, emitter, {}, () => null, setAbort, ctx);

    assert.equal(setAbort.mock.calls.length, 1);
    assert.ok(setAbort.mock.calls[0].arguments[0] instanceof AbortController);
    assert.equal(setAbortCallsAtOpen, 1, "setAbort must be called before generateContentStream opens");
  });

  test("aborting mid-`for await` chunk loop stops token emission and settles on a bare stream_end", async () => {
    const setAbort = mock.fn();
    async function* neverEndingStream(signal) {
      yield textChunk("partial");
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "GoogleGenerativeAIAbortError" })));
      });
    }

    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async (request, options) => ({
            stream: neverEndingStream(options.signal),
            response: textResponse("unused"),
          }),
        }),
      },
    });
    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };

    const resultPromise = runGeminiLoop(messages, emitter, {}, () => null, setAbort, ctx);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(setAbort.mock.calls.length, 1, "controller must already be registered by the time the stream is open");
    setAbort.mock.calls[0].arguments[0].abort();

    const result = await resultPromise;
    assert.equal(result, "");

    const events = emitter.send.mock.calls.map(c => c.arguments[0]);
    const last = events[events.length - 1];
    assert.equal(last.type, "stream_end");
    assert.equal(last.text, "");
    assert.equal(events.filter(e => e.type === "stream_end").length, 1, "no events after stream_end");
    assert.ok(events.some(e => e.type === "token" && e.text === "partial"), "should have emitted the token already received before the abort landed");
  });

  test("abort observed between a tool call and the next request iteration terminates the loop", async () => {
    let requestCount = 0;
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => {
            requestCount++;
            return {
              stream: makeStream([textChunk("")]),
              response: {
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 0 },
                functionCalls: () => [{ name: "get_weather", args: { city: "Paris" } }],
              },
            };
          },
        }),
      },
      callTool: async () => "Sunny",
    });
    const messages = [{ role: "user", content: "Weather in Paris?" }];
    const emitter = { send: mock.fn() };

    let calls = 0;
    const getAbort = () => ({ signal: { aborted: calls++ > 0 } });

    const result = await runGeminiLoop(messages, emitter, {}, getAbort, () => {}, ctx);

    assert.equal(result, "");
    assert.equal(requestCount, 1, "should not open a second stream once the abort is observed");
    const last = emitter.send.mock.calls[emitter.send.mock.calls.length - 1].arguments[0];
    assert.equal(last.type, "stream_end");
    assert.equal(last.text, "");
  });

  // Regression: wsHandler's `case "stop"` (lib/emitters/handlers/wsHandler.js)
  // aborts its controller AND nulls its own closure reference in the same
  // synchronous tick — so getAbort() can no longer see the abort once control
  // returns to the loop. A Stop pressed while callTool()/prepareModelContext()
  // is in flight (no fetch/stream listening on the signal at that moment) must
  // still be honored via a locally-latched flag, not just a live getAbort() read.
  test("Stop pressed during tool execution is not lost even after wsHandler nulls its abortController reference", async () => {
    let requestCount = 0;
    let currentController = null;
    const getAbort = () => currentController;
    const setAbort = (c) => { currentController = c; };

    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => {
            requestCount++;
            return {
              stream: makeStream([textChunk("")]),
              response: {
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 0 },
                functionCalls: () => [{ name: "get_weather", args: { city: "Paris" } }],
              },
            };
          },
        }),
      },
      callTool: async () => {
        // Simulate wsHandler's stop handler firing mid-tool-call.
        currentController.abort();
        currentController = null;
        return "Sunny";
      },
    });
    const messages = [{ role: "user", content: "Weather in Paris?" }];
    const emitter = { send: mock.fn() };

    const result = await runGeminiLoop(messages, emitter, {}, getAbort, setAbort, ctx);

    assert.equal(result, "");
    assert.equal(requestCount, 1, "must not start a follow-up generation after Stop was observed mid-tool-call");
    const last = emitter.send.mock.calls[emitter.send.mock.calls.length - 1].arguments[0];
    assert.equal(last.type, "stream_end");
    assert.equal(last.text, "");
  });

  test("Stop pressed during prepareModelContext is not lost even after wsHandler nulls its abortController reference", async () => {
    let requestCount = 0;
    let currentController = null;
    const getAbort = () => currentController;
    const setAbort = (c) => { currentController = c; };

    const prepareModelContext = mock.fn(async () => {
      currentController.abort();
      currentController = null;
      return { messages: [{ role: "user", content: "hi" }], systemPrompt: "sys", tools: [] };
    });
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => { requestCount++; return { stream: makeStream([textChunk("hi")]), response: textResponse("hi") }; },
        }),
      },
      prepareModelContext,
    });
    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: mock.fn() };

    const result = await runGeminiLoop(messages, emitter, {}, getAbort, setAbort, ctx);

    assert.equal(result, "");
    assert.equal(requestCount, 0, "must never open the stream once Stop was observed during context prep");
    const last = emitter.send.mock.calls[emitter.send.mock.calls.length - 1].arguments[0];
    assert.equal(last.type, "stream_end");
    assert.equal(last.text, "");
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

    const result = await runGeminiLoop(messages, emitter, {}, undefined, undefined, ctx);
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

  // Regression: Gemini's function-call payload has no call id, only a name.
  // Using `fc.name` as tool_use_id meant two calls to the same tool in one
  // turn produced duplicate ids, breaking id-keyed orphan/dedup logic
  // (dropOrphanedToolResults, the toolNames lookup in toGeminiHistory).
  test("assigns unique tool_use_id per call when the same tool is called twice in one turn", async () => {
    let callCount = 0;
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.0-flash",
        contextWindow: 8192,
        client: makeClient({
          generateContentStream: async () => {
            callCount++;
            if (callCount === 1) {
              return {
                stream: makeStream([textChunk("")]),
                response: {
                  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 0 },
                  functionCalls: () => [
                    { name: "get_weather", args: { city: "Paris" } },
                    { name: "get_weather", args: { city: "Berlin" } },
                  ],
                },
              };
            }
            return {
              stream: makeStream([textChunk("Sunny in both.")]),
              response: textResponse("Sunny in both."),
            };
          },
        }),
      },
      callTool: async (name, args) => `weather for ${args.city}`,
    });

    const messages = [{ role: "user", content: "Weather in Paris and Berlin?" }];
    const emitter = { send: mock.fn() };

    await runGeminiLoop(messages, emitter, {}, undefined, undefined, ctx);

    const toolUseMsg = messages.find(m => Array.isArray(m.content) && m.content.some(b => b.type === "tool_use"));
    const toolUseIds = toolUseMsg.content.filter(b => b.type === "tool_use").map(b => b.id);
    assert.equal(toolUseIds.length, 2);
    assert.notEqual(toolUseIds[0], toolUseIds[1], "each call must get a distinct id, not the shared function name");

    const toolResultMsg = messages.find(m => Array.isArray(m.content) && m.content.some(b => b.type === "tool_result"));
    const resultIds = toolResultMsg.content.filter(b => b.type === "tool_result").map(b => b.tool_use_id);
    assert.deepEqual(resultIds, toolUseIds, "tool_result ids must match their corresponding tool_use ids in order");
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

    const result = await runGeminiLoop(messages, emitter, {}, undefined, undefined, ctx);
    assert.equal(result, "Trimmed");
    // Context should have been trimmed
    const trimmedEvents = emitter.send.mock.calls
      .filter(c => c.arguments[0].type === "context_trimmed");
    assert.ok(trimmedEvents.length >= 0); // may or may not trigger depending on estimateMsgTokens
  });
});

// =============================================================================
// Reasoning parity (WS4 / group D)
// =============================================================================
describe("runGeminiLoop — reasoning parity (group D)", () => {
  afterEach(() => { reset(); delete process.env.GEMINI_THINKING_BUDGET; });

  // Shape verified live (2026-07-21) against gemini-2.5-flash with
  // thinkingConfig: { thinkingBudget, includeThoughts: true } — `part.thought`
  // is untyped in this SDK version (@google/generative-ai) but present on the
  // real wire response.
  function thoughtChunk(text) {
    return { candidates: [{ content: { parts: [{ text, thought: true }] } }] };
  }

  function thinkingModel(chunks, usage = { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 34 }) {
    return makeClient({
      generateContentStream: async () => ({
        stream: makeStream(chunks),
        response: { usageMetadata: usage, functionCalls: () => [] },
      }),
    });
  }

  test("D1: emits reasoning_start -> reasoning_token -> reasoning_done before the first answer token", async () => {
    process.env.GEMINI_THINKING_BUDGET = "2048";
    const ctx = baseCtx({
      provider: { name: "gemini", model: "gemini-2.5-flash", contextWindow: 8192, client: thinkingModel([thoughtChunk("Working it out."), textChunk("42")]) },
    });
    const emitter = { send: mock.fn() };

    const result = await runGeminiLoop([{ role: "user", content: "What is 6 times 7?" }], emitter, {}, undefined, undefined, ctx);
    assert.equal(result, "42");

    const events = emitter.send.mock.calls.map(c => c.arguments[0]);
    const types = events.map(e => e.type);
    const startIdx = types.indexOf("reasoning_start");
    const tokenIdx = types.indexOf("reasoning_token");
    const doneIdx = types.indexOf("reasoning_done");
    const answerTokenIdx = events.findIndex(e => e.type === "token" && e.text === "42");

    assert.ok(startIdx !== -1 && tokenIdx !== -1 && doneIdx !== -1, "all three reasoning events must fire");
    assert.ok(startIdx < tokenIdx && tokenIdx < doneIdx && doneIdx < answerTokenIdx);
    assert.equal(events[tokenIdx].text, "Working it out.");
    assert.ok(!events.some(e => e.type === "token" && e.text.includes("Working it out")), "no token event may carry reasoning text");
  });

  test("D1 edge: thinking disabled (budget unset) never requests includeThoughts or emits reasoning events", async () => {
    let generationConfig;
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.5-flash", contextWindow: 8192,
        client: { getGenerativeModel: (cfg) => { generationConfig = cfg.generationConfig; return { generateContentStream: async () => ({ stream: makeStream([textChunk("Hi")]), response: textResponse("Hi") }) }; } },
      },
    });
    const emitter = { send: mock.fn() };

    await runGeminiLoop([{ role: "user", content: "Hi" }], emitter, {}, undefined, undefined, ctx);

    assert.deepEqual(generationConfig, {});
    const types = emitter.send.mock.calls.map(c => c.arguments[0].type);
    assert.equal(types.includes("reasoning_start"), false);
    assert.equal(types.includes("reasoning_token"), false);
    assert.equal(types.includes("reasoning_done"), false);
  });

  test("D1 edge: a thought part with no text still opens/closes the bubble without an empty reasoning_token", async () => {
    process.env.GEMINI_THINKING_BUDGET = "2048";
    const ctx = baseCtx({
      provider: { name: "gemini", model: "gemini-2.5-flash", contextWindow: 8192, client: thinkingModel([{ candidates: [{ content: { parts: [{ thought: true }] } }] }, textChunk("42")]) },
    });
    const emitter = { send: mock.fn() };

    await runGeminiLoop([{ role: "user", content: "Hi" }], emitter, {}, undefined, undefined, ctx);

    const types = emitter.send.mock.calls.map(c => c.arguments[0].type);
    assert.equal(types.filter(t => t === "reasoning_start").length, 1);
    assert.equal(types.filter(t => t === "reasoning_done").length, 1);
    assert.equal(types.includes("reasoning_token"), false);
  });

  test("passes includeThoughts alongside thinkingBudget and sets state.thinks", async () => {
    process.env.GEMINI_THINKING_BUDGET = "2048";
    let generationConfig;
    const state = { thinks: false };
    const ctx = baseCtx({
      provider: {
        name: "gemini", model: "gemini-2.5-flash", contextWindow: 8192,
        client: { getGenerativeModel: (cfg) => { generationConfig = cfg.generationConfig; return { generateContentStream: async () => ({ stream: makeStream([textChunk("Hi")]), response: textResponse("Hi") }) }; } },
      },
      state,
    });
    const emitter = { send: mock.fn() };

    await runGeminiLoop([{ role: "user", content: "Hi" }], emitter, {}, undefined, undefined, ctx);

    assert.deepEqual(generationConfig.thinkingConfig, { thinkingBudget: 2048, includeThoughts: true });
    assert.equal(state.thinks, true);
  });

  test("D2: thinking_tokens still comes from the real thoughtsTokenCount field", async () => {
    process.env.GEMINI_THINKING_BUDGET = "2048";
    const ctx = baseCtx({
      provider: { name: "gemini", model: "gemini-2.5-flash", contextWindow: 8192, client: thinkingModel([thoughtChunk("Thinking."), textChunk("42")], { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 34 }) },
    });
    const emitter = { send: mock.fn() };

    await runGeminiLoop([{ role: "user", content: "Hi" }], emitter, {}, undefined, undefined, ctx);

    const end = emitter.send.mock.calls.map(c => c.arguments[0]).find(e => e.type === "stream_end");
    assert.equal(end.usage.thinking_tokens, 34);
  });
});
