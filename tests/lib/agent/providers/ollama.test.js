// tests/lib/agent/providers/ollama.test.js
//
// Tests for runOllamaLoop. Mocks fetch (global) and logger so the loop
// can process mock SSE responses without a real Ollama server.
// OllamaStreamHandler and ToolExecutor are NOT mocked — they process
// the mock HTTP responses normally.

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { estimateThinkingTokens } from "../../../../lib/agent/providers/ollama.js";

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

let runOllamaLoop;

before(async () => {
  process.env.OLLAMA_VLM_MODEL = "qwen2.5vl:7b";
  const mod = await import("../../../../lib/agent/providers/ollama.js");
  runOllamaLoop = mod.runOllamaLoop;
});

function reset() {
  infoCalls = [];
  warnCalls = [];
  errorCalls = [];
}

// ─── Common helpers ────────────────────────────────────────────────────────

function makeEmittersend() {
  return mock.fn();
}

function baseCtx(model = "qwen2.5vl:7b", overrides = {}) {
  return {
    provider: {
      name: "ollama",
      model,
      ollamaBaseURL: "http://localhost:11434",
      baseURL: "http://localhost:11434/v1",
      contextWindow: 8192,
      vision: true,
    },
    callTool: mock.fn(),
    getSystemPrompt: () => "You are a helpful assistant.",
    getOllamaTools: () => [],
    reasoningAdapter: {
      createState: () => ({}),
      processDelta: (delta, _state, emit) => {
        const text = delta?.content ?? "";
        return { contentToken: text };
      },
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

// =============================================================================
// test: health check failure
// =============================================================================
describe("runOllamaLoop — health check failure", () => {
  afterEach(() => {
    reset();
    mock.restoreAll();
    // Re-apply logger mocks after restoreAll
    mock.method(logger, "info",  (...args) => { infoCalls.push(args); });
    mock.method(logger, "warn",  (...args) => { warnCalls.push(args); });
    mock.method(logger, "error", (...args) => { errorCalls.push(args); });
  });

  test("returns health error when ollama not available", async () => {
    // Override fetch to make the health check fail
    mock.method(globalThis, "fetch", async (url) => {
      if (String(url).includes("/api/tags")) {
        throw new Error("Connection refused");
      }
      return { ok: true, status: 200, body: null, text: async () => "" };
    });

    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: makeEmittersend() };
    const ctx = baseCtx("llama3.1");

    const result = await runOllamaLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.ok(result.includes("Ollama is not running"));
  });
});

// =============================================================================
// test: successful response
// =============================================================================
describe("runOllamaLoop — successful response", () => {
  afterEach(() => {
    reset();
  });

  test("returns model response text from SSE stream", async () => {
    // Set up fetch mock
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/api/tags")) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ models: [] }),
        };
      }
      if (tag.includes("/chat/completions")) {
        return {
          ok: true, status: 200,
          body: sseStream([
            'data: {"id":"c1","object":"chat.completion.chunk",'
            + '"choices":[{"index":0,"delta":{"role":"assistant","content":""}}],"usage":null}\n\n',
            'data: {"id":"c1","object":"chat.completion.chunk",'
            + '"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}],"usage":null}\n\n',
            'data: {"id":"c1","object":"chat.completion.chunk",'
            + '"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}],"usage":null}\n\n',
            'data: {"id":"c1","object":"chat.completion.chunk",'
            + '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
            + '"usage":{"input_tokens":15,"output_tokens":6}}\n\n',
            'data: [DONE]\n\n',
          ]),
          text: async () => "",
        };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: makeEmittersend() };
    const ctx = baseCtx("qwen2.5vl:7b");

    const result = await runOllamaLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.equal(result, "Hello world");
  });

  test("returns error when API returns non-200", async () => {
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/api/tags")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ models: [] }) };
      }
      return {
        ok: false, status: 400,
        text: async () => JSON.stringify({ error: { message: "Invalid model" } }),
      };
    });

    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: makeEmittersend() };
    const ctx = baseCtx("qwen2.5vl:7b");

    const result = await runOllamaLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.ok(result.includes("Invalid model"));
  });
});

// =============================================================================
// test: empty-completion retry
// =============================================================================
describe("runOllamaLoop — empty-completion retry", () => {
  afterEach(() => { reset(); });

  const EMPTY_SSE = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}],'
    + '"usage":{"input_tokens":10,"output_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ];

  test("retries once with thinking suppressed when the model returns empty", async () => {
    let chatCalls = 0;
    const bodies = [];
    mock.method(globalThis, "fetch", async (url, opts) => {
      const tag = String(url);
      if (tag.includes("/api/tags")) return { ok: true, status: 200, text: async () => JSON.stringify({ models: [] }) };
      if (tag.includes("/chat/completions")) {
        bodies.push(JSON.parse(opts.body));
        chatCalls++;
        const chunks = chatCalls === 1 ? EMPTY_SSE : [
          'data: {"choices":[{"index":0,"delta":{"content":"Recovered"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ];
        return { ok: true, status: 200, text: async () => "", body: sseStream(chunks) };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const result = await runOllamaLoop(
      [{ role: "user", content: "Make a doc" }], { send: makeEmittersend() }, {}, undefined, () => {}, baseCtx("gemma4:12b"));

    assert.equal(chatCalls, 2, "should have retried exactly once");
    assert.equal(result, "Recovered");
    assert.equal(bodies[0].reasoning_effort, undefined, "first attempt keeps thinking");
    assert.equal(bodies[1].reasoning_effort, "none", "retry suppresses thinking");
  });

  test("gives up after one retry and returns the no-response fallback", async () => {
    let chatCalls = 0;
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/api/tags")) return { ok: true, status: 200, text: async () => JSON.stringify({ models: [] }) };
      if (tag.includes("/chat/completions")) { chatCalls++; return { ok: true, status: 200, text: async () => "", body: sseStream(EMPTY_SSE) }; }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const result = await runOllamaLoop(
      [{ role: "user", content: "Make a doc" }], { send: makeEmittersend() }, {}, undefined, () => {}, baseCtx("gemma4:12b"));

    assert.equal(chatCalls, 2, "one original + one retry, then give up");
    assert.match(result, /no response/i);
  });
});

// =============================================================================
// test: thinking-token attribution
// =============================================================================
describe("estimateThinkingTokens", () => {
  test("attributes all tokens to thinking when the answer is empty", () => {
    // The gemma failure case: model produced only reasoning, no answer text.
    assert.equal(estimateThinkingTokens(1522, 6000, 0), 1522);
  });

  test("splits the total by text length between thinking and answer", () => {
    // 75% reasoning chars → ~75% of the tokens counted as thinking.
    assert.equal(estimateThinkingTokens(1000, 750, 250), 750);
  });

  test("attributes nothing to thinking when there is no reasoning", () => {
    assert.equal(estimateThinkingTokens(500, 0, 500), 0);
  });

  test("falls back to a char-based estimate when the total is unknown", () => {
    // No usage reported (output 0) but reasoning text exists → ceil(len/4).
    assert.equal(estimateThinkingTokens(0, 40, 0), 10);
  });
});
