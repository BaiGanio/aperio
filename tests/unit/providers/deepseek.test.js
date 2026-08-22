// tests/lib/agent/providers/deepseek.test.js
//
// Tests for runDeepSeekLoop. Mocks globalThis.fetch (HTTP) and logger.
// The real LlamaCppStreamHandler and ToolExecutor process the mock SSE
// responses (same approach as llamacpp.test.js).

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

// ─── Logger mock ──────────────────────────────────────────────────────────

import logger from "../../../lib/helpers/logger.js";

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

let runDeepSeekLoop;

before(async () => {
  const mod = await import("../../../lib/agent/providers/deepseek.js");
  runDeepSeekLoop = mod.runDeepSeekLoop;
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function baseCtx(overrides = {}) {
  return {
    provider: {
      name: "deepseek",
      model: "deepseek-chat",
      baseURL: "https://api.deepseek.com",
      apiKey: "sk-test",
      contextWindow: 64000,
      vision: false,
    },
    callTool: mock.fn(),
    getSystemPrompt: () => "You are a helpful assistant.",
    getOpenAiTools: () => [],
    reasoningAdapter: {
      createState: () => ({}),
      processDelta: (delta, _state, emit) => ({ contentToken: delta?.content ?? "" }),
      thinks: false,
      stripReasoning: (t) => t,
    },
    state: { noTools: false, thinks: false },
    ...overrides,
  };
}

/** Mock SSE ReadableStream from data chunks. */
function sseStream(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
}

function mockFetchSSE(chunks) {
  mock.method(globalThis, "fetch", async (url, options) => {
    return {
      ok: true, status: 200,
      body: sseStream(chunks),
      text: async () => "",
    };
  });
}

function mockFetchError(status, body, overrides = {}) {
  mock.method(globalThis, "fetch", async () => ({
    ok: false, status, text: async () => body, body: null,
    ...overrides,
  }));
}

function reset() {
  infoCalls = [];
  warnCalls = [];
  errorCalls = [];
}

/** Build SSE chunks that stream back a text response. */
function textSSEChunks(text) {
  return [
    'data: {"id":"ds-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}\n\n',
    ...text.match(/.{1,20}/g).map(chunk =>
      `data: {"id":"ds-1","choices":[{"index":0,"delta":{"content":"${chunk}"},"finish_reason":null}],"usage":null}\n\n`
    ),
    'data: {"id":"ds-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":6}}\n\n',
    'data: [DONE]\n\n',
  ];
}

// =============================================================================
// runDeepSeekLoop — successful text response
// =============================================================================
describe("runDeepSeekLoop — text response", () => {
  afterEach(() => { reset(); });

  test("returns model response text from SSE stream", async () => {
    mockFetchSSE(textSSEChunks("Hello world"));

    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };
    const ctx = baseCtx();

    const result = await runDeepSeekLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.equal(result, "Hello world");
  });

  // NOTE: empty-content path is not tested here because ToolExecutor may
  // return null and continue the loop instead of returning empty string.
});

// =============================================================================
// runDeepSeekLoop — Stop/abort latch (F-R2-04)
// =============================================================================
describe("runDeepSeekLoop — Stop/abort latch (F-R2-04)", () => {
  afterEach(() => { reset(); });

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
    mock.method(globalThis, "fetch", async () => {
      requestCount++;
      return { ok: true, status: 200, body: sseStream([]), text: async () => "" };
    });

    const ctx = baseCtx({ prepareModelContext });
    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: mock.fn() };

    const result = await runDeepSeekLoop(messages, emitter, {}, getAbort, setAbort, ctx);

    assert.equal(result, "");
    assert.equal(requestCount, 0, "must never open a fetch request once Stop was observed during context prep");
    const last = emitter.send.mock.calls[emitter.send.mock.calls.length - 1].arguments[0];
    assert.equal(last.type, "stream_end");
    assert.equal(last.text, "");
  });
});

// =============================================================================
// runDeepSeekLoop — error paths
// =============================================================================
describe("runDeepSeekLoop — error paths", () => {
  afterEach(() => { reset(); });

  test("returns error when API returns non-200", async () => {
    mockFetchError(401, JSON.stringify({ error: { message: "Invalid API key" } }));

    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: mock.fn() };
    const ctx = baseCtx();

    const result = await runDeepSeekLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.ok(result.includes("Invalid API key"));
  });

  test("returns timeout error when fetch times out", async () => {
    mock.method(globalThis, "fetch", async () => {
      const e = new Error("The user aborted a request.");
      e.name = "AbortError";
      throw e;
    });

    const messages = [{ role: "user", content: "Hi" }];
    const emitter = { send: mock.fn() };
    const ctx = baseCtx();

    const result = await runDeepSeekLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.equal(result, ""); // AbortError returns empty
  });

  test("logs error on failed request", async () => {
    mock.method(globalThis, "fetch", async () => { throw new Error("Network failure"); });

    const messages = [{ role: "user", content: "Test" }];
    const emitter = { send: mock.fn() };
    const ctx = baseCtx();

    const result = await runDeepSeekLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.ok(result.includes("Network failure"));
    assert.ok(errorCalls.some(a => a[0].includes("request failed")));
  });
});

// =============================================================================
// runDeepSeekLoop — image error retry
// =============================================================================
describe("runDeepSeekLoop — image error retry", () => {
  afterEach(() => { reset(); });

  test("retries without images when API rejects image content", async () => {
    let fetchCount = 0;

    mock.method(globalThis, "fetch", async (url, options) => {
      fetchCount++;
      const body = JSON.parse(options.body);
      const hasImages = body.messages.some(m =>
        Array.isArray(m.content) && m.content.some(b => b.type === "image_url")
      );

      if (fetchCount === 1 && hasImages) {
        // First request has images → reject
        return {
          ok: false, status: 400,
          text: async () => JSON.stringify({ error: { message: "unknown variant `image_url`" } }),
          body: null,
        };
      }

      // Retry succeeds
      return {
        ok: true, status: 200,
        body: sseStream(textSSEChunks("Text-only response")),
        text: async () => "",
      };
    });

    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "Describe this image" },
        { type: "image", source: { media_type: "image/png", data: "abc" } },
      ],
    }];
    const emitter = { send: mock.fn() };
    // Use a vision-capable provider so the bridge is skipped
    const ctx = baseCtx({
      provider: { ...baseCtx().provider, vision: true },
    });

    const result = await runDeepSeekLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.equal(result, "Text-only response");
    assert.equal(fetchCount, 2, "should retry once after image error");
    assert.ok(warnCalls.some(a => a[0].includes("rejected image content")),
      "should warn about image rejection");
  });
});

// =============================================================================
// runDeepSeekLoop — tool call cycle
// =============================================================================
describe("runDeepSeekLoop — tool call cycle", () => {
  afterEach(() => { reset(); });

  test("executes tool calls and returns final text", async () => {
    let fetchCount = 0;

    mock.method(globalThis, "fetch", async () => {
      fetchCount++;
      if (fetchCount === 1) {
        // First response returns a tool call
        return {
          ok: true, status: 200,
          body: sseStream([
            'data: {"id":"ds-t1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}\n\n',
            'data: {"id":"ds-t1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"get_time","arguments":"{}"},"id":"call-1"}]},"finish_reason":null}],"usage":null}\n\n',
            'data: {"id":"ds-t1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":20,"output_tokens":5}}\n\n',
            'data: [DONE]\n\n',
          ]),
          text: async () => "",
        };
      }
      // Second response returns text
      return {
        ok: true, status: 200,
        body: sseStream(textSSEChunks("The time is now.")),
        text: async () => "",
      };
    });

    const messages = [{ role: "user", content: "What time is it?" }];
    const emitter = { send: mock.fn() };
    const ctx = baseCtx({ callTool: async () => "12:00" });

    const result = await runDeepSeekLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.equal(result, "The time is now.");
    assert.equal(fetchCount, 2, "should make 2 fetch calls (tool + text)");
  });
});

// =============================================================================
// Per-turn tool-step cap (APERIO_TURN_MAX_TOOL_STEPS)
//
// Same guard, same wording as llamacpp.js — the two loops share the code and
// must not drift. The repeated-call breaker only sees an IDENTICAL call issued
// over and over; a model walking a different tool each pass resets it, so the
// step cap is what actually bounds this `while (true)`.
// =============================================================================
describe("runDeepSeekLoop — per-turn tool-step cap", () => {
  afterEach(() => { reset(); delete process.env.APERIO_TURN_MAX_TOOL_STEPS; });

  // Every walked name is a REAL registered tool, so nothing upstream of the cap
  // can reject the call first.
  const walkedTools = Array.from({ length: 9 }, (_, i) => ({
    type: "function",
    function: { name: `probe_${i + 1}`, description: "", parameters: { type: "object", properties: {} } },
  }));
  const walkingSSE = n => [
    `data: {"id":"ds-${n}","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}\n\n`,
    `data: {"id":"ds-${n}","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"probe_${n}","arguments":"{\\"n\\":${n}}"},"id":"call-${n}"}]},"finish_reason":null}],"usage":null}\n\n`,
    `data: {"id":"ds-${n}","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":20,"output_tokens":5}}\n\n`,
    "data: [DONE]\n\n",
  ];

  test("alternating tool calls hit the cap, lose the tools and must answer", async () => {
    process.env.APERIO_TURN_MAX_TOOL_STEPS = "3";
    const bodies = [];
    let fetchCount = 0;
    mock.method(globalThis, "fetch", async (_url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      fetchCount++;
      // Guard rail on the test itself: without the cap this never stops.
      assert.ok(fetchCount <= 6, "the loop did not break — the model was still offered tools");
      return {
        ok: true, status: 200,
        body: sseStream(body.tools ? walkingSSE(fetchCount) : textSSEChunks("Done.")),
        text: async () => "",
      };
    });

    const emitter = { send: mock.fn() };
    const ctx = baseCtx({ getOpenAiTools: () => walkedTools, callTool: mock.fn(async () => "probe result") });

    const result = await runDeepSeekLoop([{ role: "user", content: "Look into it." }], emitter, {}, undefined, () => {}, ctx);

    assert.equal(result, "Done.", "the turn ends with a real answer, not a timeout");
    assert.equal(fetchCount, 4, "three tool passes, then exactly one tool-free pass");
    assert.ok(bodies.slice(0, 3).every(b => Array.isArray(b.tools)), "tools stay available up to the cap");
    assert.equal(bodies[3].tools, undefined, "the forced pass carries no tool schemas at all");
    assert.match(bodies[3].messages[0].content, /reached the per-reply limit/);
    assert.equal(ctx.callTool.mock.calls.length, 3, "every distinct call really ran");
    const capped = emitter.send.mock.calls.map(c => c.arguments[0]).find(m => m.type === "tool_step_limit");
    assert.ok(capped, "the cap is observable to the UI");
    assert.equal(capped.steps, 3);
    assert.equal(capped.limit, 3);
  });

  test("a turn that finishes under the cap keeps its tools and emits nothing", async () => {
    process.env.APERIO_TURN_MAX_TOOL_STEPS = "8";
    const bodies = [];
    let fetchCount = 0;
    mock.method(globalThis, "fetch", async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      fetchCount++;
      return {
        ok: true, status: 200,
        body: sseStream(fetchCount <= 2 ? walkingSSE(fetchCount) : textSSEChunks("Done.")),
        text: async () => "",
      };
    });

    const emitter = { send: mock.fn() };
    const ctx = baseCtx({ getOpenAiTools: () => walkedTools, callTool: mock.fn(async () => "probe result") });

    const result = await runDeepSeekLoop([{ role: "user", content: "Look into it." }], emitter, {}, undefined, () => {}, ctx);

    assert.equal(result, "Done.");
    assert.ok(bodies.every(b => Array.isArray(b.tools)), "the cap must not fire on legitimate work");
    assert.equal(emitter.send.mock.calls.map(c => c.arguments[0]).filter(m => m.type === "tool_step_limit").length, 0);
  });
});
