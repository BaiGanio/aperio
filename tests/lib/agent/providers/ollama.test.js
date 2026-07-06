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

  test("a timed-out probe is reported as loading, not 'not running'", async () => {
    let probes = 0;
    mock.method(globalThis, "fetch", async (url) => {
      if (String(url).includes("/api/tags")) {
        probes++;
        throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
      }
      return { ok: true, status: 200, body: null, text: async () => "" };
    });

    const result = await runOllamaLoop(
      [{ role: "user", content: "Hello" }], { send: makeEmittersend() }, {}, undefined, () => {}, baseCtx("gemma4:e4b"));

    assert.ok(!result.includes("Ollama is not running"), "should not blame a missing server on a timeout");
    assert.match(result, /still be loading/);
    assert.equal(probes, 2, "should retry once with a longer timeout before giving up");
  });

  // Regression: the health probe is a one-time preflight, not a per-turn gate.
  // After a successful tool turn, a transient `/api/tags` failure (e.g. server
  // busy serving a large model) must NOT abort the conversation with a bogus
  // "Ollama is not running" message — we already know it's running.
  test("does not re-probe health after first contact; survives a transient /api/tags blip", async () => {
    let tagProbes = 0;
    let chatCalls = 0;
    const TOOLS = [{ type: "function", function: { name: "db_schema" } }];
    const TOOL_SSE = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"t1","function":{"name":"db_schema","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":10,"output_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ];
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/api/tags")) {
        tagProbes++;
        if (tagProbes > 1) throw new Error("Connection refused"); // transient blip on later turns
        return { ok: true, status: 200, text: async () => JSON.stringify({ models: [] }) };
      }
      if (tag.includes("/chat/completions")) {
        chatCalls++;
        const chunks = chatCalls === 1 ? TOOL_SSE : [
          'data: {"choices":[{"index":0,"delta":{"content":"Final answer."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":3}}\n\n',
          'data: [DONE]\n\n',
        ];
        return { ok: true, status: 200, text: async () => "", body: sseStream(chunks) };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const ctx = baseCtx("gemma4:12b", {
      getOllamaTools: () => TOOLS,
      callTool: mock.fn(async () => "ok"),
    });
    const result = await runOllamaLoop(
      [{ role: "user", content: "list tables" }], { send: makeEmittersend() }, {}, undefined, () => {}, ctx);

    assert.equal(tagProbes, 1, "health probe should run once as a preflight, not per turn");
    assert.equal(chatCalls, 2, "tool turn + final answer turn");
    assert.equal(result, "Final answer.");
  });

  // Regression for the screenshot bug: a model that just answered must not be
  // re-probed on the NEXT user message. runOllamaLoop is called fresh per turn,
  // so the "ever connected" flag lives on the shared session `state` rather than
  // a function-local — otherwise a transient slow `/api/tags` on turn 2 falsely
  // reports "may still be loading" right after a 32 tok/s answer.
  test("does not re-probe on a subsequent user turn sharing one session state", async () => {
    let tagProbes = 0;
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/api/tags")) {
        tagProbes++;
        if (tagProbes > 1) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        return { ok: true, status: 200, text: async () => JSON.stringify({ models: [] }) };
      }
      if (tag.includes("/chat/completions")) {
        return { ok: true, status: 200, text: async () => "", body: sseStream([
          'data: {"choices":[{"index":0,"delta":{"content":"Answer."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ]) };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    // One ctx/state object reused across two turns, mirroring a live session.
    const ctx = baseCtx("phi4-mini:3.8b");
    const r1 = await runOllamaLoop(
      [{ role: "user", content: "good at tool calling?" }], { send: makeEmittersend() }, {}, undefined, () => {}, ctx);
    const r2 = await runOllamaLoop(
      [{ role: "user", content: "what happened?" }], { send: makeEmittersend() }, {}, undefined, () => {}, ctx);

    assert.equal(tagProbes, 1, "second turn must reuse the connected state, not re-probe");
    assert.equal(r1, "Answer.");
    assert.equal(r2, "Answer.", "turn 2 should answer, not report 'still loading'");
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

  test("returns the VLM answer directly for a standalone image request", async () => {
    mock.method(globalThis, "fetch", async () => {
      assert.fail("the main model API must not be called for a standalone visual answer");
    });
    const messages = [{ role: "user", content: [
      { type: "text", text: "Describe this image" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } },
    ]}];
    const emitter = { send: makeEmittersend() };
    const callTool = mock.fn(async (name, input) => {
      assert.equal(name, "describe_image");
      assert.match(input.prompt, /Describe this image/);
      return "A red bicycle beside a brick wall.";
    });

    const result = await runOllamaLoop(
      messages, emitter, {}, undefined, () => {},
      baseCtx("gemma4:e4b", { callTool }),
    );

    assert.equal(result, "A red bicycle beside a brick wall.");
    assert.equal(messages.at(-1).role, "assistant");
    assert.equal(messages.at(-1).content[0].text, result);
    assert.ok(emitter.send.mock.calls.some(c => c.arguments[0]?.type === "stream_end"));
  });

  test("passes VLM evidence to the tool-capable main model for action requests", async () => {
    let requestBody;
    mock.method(globalThis, "fetch", async (url, opts) => {
      const tag = String(url);
      if (tag.includes("/api/tags")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ models: [] }) };
      }
      requestBody = JSON.parse(opts.body);
      return {
        ok: true, status: 200, text: async () => "",
        body: sseStream([
          'data: {"choices":[{"index":0,"delta":{"content":"I found two matching documents."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":4}}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    });
    const tools = [{ type: "function", function: { name: "doc_search", parameters: {} } }];
    const messages = [{ role: "user", content: [
      { type: "text", text: "Read this image and find similar documents in my indexed files" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } },
    ]}];
    const callTool = mock.fn(async () => "Invoice field: Customer ID 42");

    const result = await runOllamaLoop(
      messages, { send: makeEmittersend() }, {}, undefined, () => {},
      baseCtx("qwen3.5:9b", {
        callTool,
        getOllamaTools: () => tools,
      }),
    );

    assert.equal(result, "I found two matching documents.");
    assert.deepEqual(requestBody.tools, tools);
    const wireText = requestBody.messages.map(m =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    ).join("\n");
    assert.match(wireText, /Customer ID 42/);
    assert.doesNotMatch(wireText, /data:image\/png;base64,pixels/);
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
// test: tool-call leakage retry
// =============================================================================
describe("runOllamaLoop — tool-call leakage", () => {
  afterEach(() => { reset(); });

  // Model printed a tool call as plain text instead of issuing a real one.
  const LEAK_SSE = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"<execute_tool>\\ncall(recall, query=\\"exam\\")\\n</execute_tool>"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":8}}\n\n',
    'data: [DONE]\n\n',
  ];

  test("retracts, retries once with a nudge, then renders the recovered answer", async () => {
    let chatCalls = 0;
    const bodies = [];
    mock.method(globalThis, "fetch", async (url, opts) => {
      const tag = String(url);
      if (tag.includes("/api/tags")) return { ok: true, status: 200, text: async () => JSON.stringify({ models: [] }) };
      if (tag.includes("/chat/completions")) {
        bodies.push(JSON.parse(opts.body));
        chatCalls++;
        const chunks = chatCalls === 1 ? LEAK_SSE : [
          'data: {"choices":[{"index":0,"delta":{"content":"Here is what I found."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":4}}\n\n',
          'data: [DONE]\n\n',
        ];
        return { ok: true, status: 200, text: async () => "", body: sseStream(chunks) };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const emitter = { send: makeEmittersend() };
    const result = await runOllamaLoop(
      [{ role: "user", content: "check your memories for exam" }], emitter, {}, undefined, () => {}, baseCtx("gemma4:e4b"));

    assert.equal(chatCalls, 2, "should retry exactly once");
    assert.equal(result, "Here is what I found.");
    // The leaked text was wiped before the user saw it.
    assert.ok(emitter.send.mock.calls.some(c => c.arguments[0]?.type === "retract"), "should retract leaked text");
    // The retry carried the nudge in the system prompt.
    assert.match(bodies[1].messages[0].content, /printed a tool call as plain text/i);
  });

  test("surfaces an honest error when leakage persists after the retry", async () => {
    let chatCalls = 0;
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/api/tags")) return { ok: true, status: 200, text: async () => JSON.stringify({ models: [] }) };
      if (tag.includes("/chat/completions")) { chatCalls++; return { ok: true, status: 200, text: async () => "", body: sseStream(LEAK_SSE) }; }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const result = await runOllamaLoop(
      [{ role: "user", content: "check your memories for exam" }], { send: makeEmittersend() }, {}, undefined, () => {}, baseCtx("gemma4:e4b"));

    assert.equal(chatCalls, 2, "one original + one retry, then give up");
    assert.match(result, /couldn't issue the call correctly/i);
  });
});

// =============================================================================
// test: corrupted native tool-call name recovery
// =============================================================================
describe("runOllamaLoop — corrupted tool name", () => {
  afterEach(() => { reset(); });

  const TOOLS = [{ type: "function", function: { name: "db_schema" } }];

  // gemma wrapped its call in hallucinated channel markup; Ollama dumped the raw
  // text into function.name. The real tool ("db_schema") is still embedded.
  const CORRUPT_TC_SSE = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"t1","function":{"name":"thought <|channel>thought <channel|><|tool_call>call:db_schema","arguments":"{\\"connection\\":\\"aperio\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":10,"output_tokens":8}}\n\n',
    'data: [DONE]\n\n',
  ];

  test("recovers the embedded tool name and dispatches the real tool", async () => {
    const calledNames = [];
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/api/tags")) return { ok: true, status: 200, text: async () => JSON.stringify({ models: [] }) };
      if (tag.includes("/chat/completions")) return { ok: true, status: 200, text: async () => "", body: sseStream(CORRUPT_TC_SSE) };
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const ctx = baseCtx("gemma4:12b", {
      getOllamaTools: () => TOOLS,
      callTool: mock.fn(async (name) => { calledNames.push(name); return "ok"; }),
    });
    // One turn issues the (recovered) tool call; stop the loop after by aborting.
    let turns = 0;
    const getAbort = () => ({ signal: { aborted: turns++ > 0 } });

    await runOllamaLoop(
      [{ role: "user", content: "list tables" }], { send: makeEmittersend() }, {}, getAbort, () => {}, ctx);

    assert.deepEqual(calledNames, ["db_schema"], "should dispatch the recovered tool name");
    assert.ok(warnCalls.some(c => /recovered corrupted tool name/i.test(String(c[0]))), "should log the recovery");
  });

  test("treats an unrecoverable corrupted name as a leak (retract + honest error)", async () => {
    const BAD_SSE = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"t1","function":{"name":"<|tool_call>call:totally_made_up","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":10,"output_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ];
    let chatCalls = 0;
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/api/tags")) return { ok: true, status: 200, text: async () => JSON.stringify({ models: [] }) };
      if (tag.includes("/chat/completions")) { chatCalls++; return { ok: true, status: 200, text: async () => "", body: sseStream(BAD_SSE) }; }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const emitter = { send: makeEmittersend() };
    const result = await runOllamaLoop(
      [{ role: "user", content: "list tables" }], emitter, {}, undefined, () => {}, baseCtx("gemma4:12b", { getOllamaTools: () => TOOLS }));

    assert.equal(chatCalls, 2, "one original + one retry, then give up");
    assert.ok(emitter.send.mock.calls.some(c => c.arguments[0]?.type === "retract"), "should retract the bad call");
    assert.match(result, /couldn't issue the call correctly/i);
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
