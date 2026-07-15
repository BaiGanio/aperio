// tests/lib/agent/providers/llamacpp.test.js
//
// Tests for runLlamaCppLoop. Mocks fetch (global) and logger so the loop
// can process mock SSE responses without a real llama-server.
// LlamaCppStreamHandler and ToolExecutor are NOT mocked — they process
// the mock HTTP responses normally.

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { estimateThinkingTokens, fitToolsToContext, getToolLoopGuidance } from "../../../../lib/agent/providers/llamacpp.js";

test("request preflight removes lowest-priority schemas until headroom is restored", () => {
  const tools = ["recall", "wiki_write", "wiki_search", "wiki_list"].map(name => ({
    type: "function",
    function: { name },
  }));
  const result = fitToolsToContext(
    [{ role: "system", content: "prompt" }],
    tools,
    1_000,
    {
      estimateTokens: value => 500 + value.tools.length * 180,
      headroomRatio: 0.9,
    },
  );

  assert.deepEqual(result.tools.map(tool => tool.function.name), ["recall", "wiki_write"]);
  assert.equal(result.removed, 2);
  assert.ok(result.estimatedTokens <= 900);
});

test("post-recall guidance completes an explicit wiki write directly and concisely", () => {
  const messages = [
    { role: "user", content: "Write a wiki article summarizing everything we know about Nimbus" },
    { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "recall", input: { query: "Nimbus" } }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "r1", content: "grounded memories" }] },
  ];

  const guidance = getToolLoopGuidance(messages);
  assert.match(guidance, /wiki_write/);
  assert.match(guidance, /strictly valid JSON/i);
  assert.match(guidance, /concise/i);
});

test("post-write guidance prevents a successful wiki mutation from repeating", () => {
  const messages = [
    { role: "user", content: "Write a wiki article about Nimbus" },
    { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "wiki_write", input: { slug: "nimbus" } }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "w1", content: "✅ Wiki article created." }] },
  ];

  const guidance = getToolLoopGuidance(messages);
  assert.match(guidance, /completed successfully/i);
  assert.match(guidance, /do not call `wiki_write` again/i);
  assert.match(guidance, /user-visible/i);
});

test("post-write guidance trusts a successful result whose article title mentions errors", () => {
  const messages = [
    { role: "user", content: "Write a wiki article about Nimbus" },
    { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "wiki_write", input: { slug: "nimbus-error-recovery" } }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "w1", content: "✅ Created wiki article: Nimbus Error Recovery" }] },
  ];

  const guidance = getToolLoopGuidance(messages);
  assert.match(guidance, /completed successfully/i);
  assert.match(guidance, /do not call `wiki_write` again/i);
  assert.doesNotMatch(guidance, /retry/i);
});

test("post-write guidance allows a failed wiki mutation to retry", () => {
  const messages = [
    { role: "user", content: "Write a wiki article about Nimbus" },
    { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "wiki_write", input: { __parse_error__: "bad JSON" } }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "w1", content: "❌ Tool requires strictly valid JSON arguments." }] },
  ];

  const guidance = getToolLoopGuidance(messages);
  assert.match(guidance, /failed/i);
  assert.match(guidance, /retry/i);
  assert.doesNotMatch(guidance, /completed successfully/i);
});

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

let runLlamaCppLoop;

before(async () => {
  process.env.LLAMACPP_VLM_MODEL = "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF";
  const mod = await import("../../../../lib/agent/providers/llamacpp.js");
  runLlamaCppLoop = mod.runLlamaCppLoop;
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

function baseCtx(model = "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF", overrides = {}) {
  return {
    provider: {
      name: "llamacpp",
      model,
      llamacppBaseURL: "http://127.0.0.1:8080",
      baseURL: "http://127.0.0.1:8080/v1",
      contextWindow: 8192,
      vision: true,
    },
    callTool: mock.fn(),
    getSystemPrompt: () => "You are a helpful assistant.",
    getOpenAiTools: () => [],
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
describe("runLlamaCppLoop — health check failure", () => {
  afterEach(() => {
    reset();
    mock.restoreAll();
    // Re-apply logger mocks after restoreAll
    mock.method(logger, "info",  (...args) => { infoCalls.push(args); });
    mock.method(logger, "warn",  (...args) => { warnCalls.push(args); });
    mock.method(logger, "error", (...args) => { errorCalls.push(args); });
  });

  test("returns health error when llama-server not available", async () => {
    // Override fetch to make the health check fail
    mock.method(globalThis, "fetch", async (url) => {
      if (String(url).includes("/health")) {
        throw new Error("Connection refused");
      }
      return { ok: true, status: 200, body: null, text: async () => "" };
    });

    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: makeEmittersend() };
    const ctx = baseCtx("Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M");

    const result = await runLlamaCppLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.ok(result.includes("llama.cpp engine is not running"));
  });

  test("a timed-out probe is reported as slow, not 'not running'", async () => {
    let probes = 0;
    mock.method(globalThis, "fetch", async (url) => {
      if (String(url).includes("/health")) {
        probes++;
        throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
      }
      return { ok: true, status: 200, body: null, text: async () => "" };
    });

    const result = await runLlamaCppLoop(
      [{ role: "user", content: "Hello" }], { send: makeEmittersend() }, {}, undefined, () => {}, baseCtx("gemma4:e4b"));

    assert.ok(!result.includes("not running"), "should not blame a missing server on a timeout");
    assert.match(result, /slow to respond/);
    assert.equal(probes, 2, "should retry once with a longer timeout before giving up");
  });

  // Regression: the health probe is a one-time preflight, not a per-turn gate.
  // After a successful tool turn, a transient /health failure (e.g. server busy
  // serving a large model) must NOT abort the conversation with a bogus
  // "not running" message — we already know it's running.
  test("does not re-probe health after first contact; survives a transient /health blip", async () => {
    let healthProbes = 0;
    let chatCalls = 0;
    const TOOLS = [{ type: "function", function: { name: "db_schema" } }];
    const TOOL_SSE = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"t1","function":{"name":"db_schema","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":10,"output_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ];
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/health")) {
        healthProbes++;
        if (healthProbes > 1) throw new Error("Connection refused"); // transient blip on later turns
        return { ok: true, status: 200, text: async () => "" };
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
      getOpenAiTools: () => TOOLS,
      callTool: mock.fn(async () => "ok"),
    });
    const result = await runLlamaCppLoop(
      [{ role: "user", content: "list tables" }], { send: makeEmittersend() }, {}, undefined, () => {}, ctx);

    assert.equal(healthProbes, 1, "health probe should run once as a preflight, not per turn");
    assert.equal(chatCalls, 2, "tool turn + final answer turn");
    assert.equal(result, "Final answer.");
  });

  test("projects a recall result into context pressure before the next model request", async () => {
    let chatCalls = 0;
    const observed = [];
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
      if (tag.includes("/chat/completions")) {
        chatCalls++;
        const chunks = chatCalls === 1 ? [
          'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"r1","function":{"name":"recall","arguments":"{\\"query\\":\\"Nimbus\\"}"}}]},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":100,"output_tokens":8}}\n\n',
          'data: [DONE]\n\n',
        ] : [
          'data: {"choices":[{"index":0,"delta":{"content":"Grounded answer."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":700,"output_tokens":3}}\n\n',
          'data: [DONE]\n\n',
        ];
        return { ok: true, status: 200, text: async () => "", body: sseStream(chunks) };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const ctx = baseCtx("gemma4:e4b", {
      callTool: mock.fn(async () => "Nimbus ".repeat(300)),
      prepareModelContext: mock.fn(async request => {
        observed.push(request.observedInputTokens);
        return {
          messages: request.messages,
          systemPrompt: "System prompt",
          tools: [{ name: "recall", description: "Recall", inputSchema: { type: "object" } }],
        };
      }),
    });

    const result = await runLlamaCppLoop(
      [{ role: "user", content: "Summarize Nimbus" }],
      { send: makeEmittersend() }, {}, undefined, () => {}, ctx,
    );

    assert.equal(result, "Grounded answer.");
    assert.equal(observed[0] > 0, true, "first request estimates its current messages");
    assert.ok(observed[1] > 100, "second request includes growth from the appended recall result");
  });

  test("does not re-probe on a subsequent user turn sharing one session state", async () => {
    let healthProbes = 0;
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/health")) {
        healthProbes++;
        if (healthProbes > 1) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        return { ok: true, status: 200, text: async () => "" };
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
    const r1 = await runLlamaCppLoop(
      [{ role: "user", content: "good at tool calling?" }], { send: makeEmittersend() }, {}, undefined, () => {}, ctx);
    const r2 = await runLlamaCppLoop(
      [{ role: "user", content: "what happened?" }], { send: makeEmittersend() }, {}, undefined, () => {}, ctx);

    assert.equal(healthProbes, 1, "second turn must reuse the connected state, not re-probe");
    assert.equal(r1, "Answer.");
    assert.equal(r2, "Answer.", "turn 2 should answer, not report 'still loading'");
  });
});

// =============================================================================
// test: successful response
// =============================================================================
describe("runLlamaCppLoop — successful response", () => {
  afterEach(() => {
    reset();
  });

  test("returns model response text from SSE stream", async () => {
    let requestedModel;
    // Set up fetch mock
    mock.method(globalThis, "fetch", async (url, opts) => {
      const tag = String(url);
      if (tag.includes("/health")) {
        return { ok: true, status: 200, text: async () => "" };
      }
      if (tag.includes("/chat/completions")) {
        requestedModel = JSON.parse(opts.body).model;
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
            + '"usage":{"input_tokens":15,"output_tokens":6},"timings":{"predicted_per_second":22}}\n\n',
            'data: [DONE]\n\n',
          ]),
          text: async () => "",
        };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: makeEmittersend() };
    const ctx = baseCtx("ggml-org/Qwen2.5-VL-7B-Instruct-GGUF");
    ctx.provider.requestModel = "aperio-main";

    const result = await runLlamaCppLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.equal(result, "Hello world");
    assert.equal(requestedModel, "aperio-main");

    // Phase 5: llama-server's real timings ride along on the usage object
    // (not just a debug log line) and survive on ctx.state past this turn.
    const streamEnd = emitter.send.mock.calls.map(c => c.arguments[0]).find(m => m.type === "stream_end" && m.usage?.timings);
    assert.ok(streamEnd, "expected a stream_end carrying usage.timings");
    assert.equal(streamEnd.usage.timings.predicted_per_second, 22);
    assert.equal(ctx.state.lastTimings?.predicted_per_second, 22);
  });

  test("carries one successful wiki_write into a guided final-response request", async () => {
    const bodies = [];
    let chatCalls = 0;
    mock.method(globalThis, "fetch", async (url, opts) => {
      const tag = String(url);
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
      if (tag.includes("/chat/completions")) {
        bodies.push(JSON.parse(opts.body));
        chatCalls++;
        const chunks = chatCalls === 1 ? [
          'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"w1","function":{"name":"wiki_write","arguments":"{\\"slug\\":\\"nimbus\\",\\"title\\":\\"Nimbus\\",\\"body_md\\":\\"Grounded.\\"}"}}]},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":100,"output_tokens":20}}\n\n',
          "data: [DONE]\n\n",
        ] : [
          'data: {"choices":[{"index":0,"delta":{"content":"Created the Nimbus article."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":150,"output_tokens":6}}\n\n',
          "data: [DONE]\n\n",
        ];
        return { ok: true, status: 200, text: async () => "", body: sseStream(chunks) };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    });
    const callTool = mock.fn(async () => "✅ Wiki article created.");
    const tools = [{ type: "function", function: { name: "wiki_write", parameters: {} } }];

    const result = await runLlamaCppLoop(
      [{ role: "user", content: "Write a wiki article about Nimbus" }],
      { send: makeEmittersend() }, {}, undefined, () => {},
      baseCtx("gemma4:e4b", { callTool, getOpenAiTools: () => tools }),
    );

    assert.equal(result, "Created the Nimbus article.");
    assert.equal(callTool.mock.callCount(), 1, "the successful mutation executes once");
    assert.equal(chatCalls, 2, "one mutation request and one final-response request");
    assert.match(bodies[1].messages[0].content, /do not call `wiki_write` again/i);
  });

  test("returns error when API returns non-200", async () => {
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/health")) {
        return { ok: true, status: 200, text: async () => "" };
      }
      return {
        ok: false, status: 400,
        text: async () => JSON.stringify({ error: { message: "Invalid model" } }),
      };
    });

    const messages = [{ role: "user", content: "Hello" }];
    const emitter = { send: makeEmittersend() };
    const ctx = baseCtx("ggml-org/Qwen2.5-VL-7B-Instruct-GGUF");

    const result = await runLlamaCppLoop(messages, emitter, {}, undefined, () => {}, ctx);
    assert.ok(result.includes("Invalid model"));
  });

  test("retries the real model id when an older router does not know aperio-main", async () => {
    const requested = [];
    mock.method(globalThis, "fetch", async (url, opts) => {
      if (String(url).includes("/health")) return { ok: true, status: 200, text: async () => "" };
      if (String(url).endsWith("/models")) return { ok: true, json: async () => ({ data: [{ id: "unsloth/Qwen3.5-9B-GGUF:Q4_K_M", meta: { n_ctx: 16384 } }] }) };
      const model = JSON.parse(opts.body).model;
      requested.push(model);
      if (model === "aperio-main") return {
        ok: false, status: 400,
        text: async () => JSON.stringify({ error: { message: "model 'aperio-main' not found" } }),
      };
      return {
        ok: true, status: 200,
        body: sseStream([
          'data: {"choices":[{"delta":{"content":"fallback works"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      };
    });
    const ctx = baseCtx("unsloth/Qwen3.5-9B-GGUF:Q4_K_M");
    ctx.provider.requestModel = "aperio-main";
    const result = await runLlamaCppLoop([{ role: "user", content: "Hello" }], { send: makeEmittersend() }, {}, undefined, () => {}, ctx);
    assert.equal(result, "fallback works");
    assert.deepEqual(requested, ["aperio-main", "unsloth/Qwen3.5-9B-GGUF:Q4_K_M"]);
    assert.equal(ctx.provider.contextWindow, 15073);
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

    const result = await runLlamaCppLoop(
      messages, emitter, {}, undefined, () => {},
      baseCtx("qwen2.5:3b", { callTool }),
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
      if (tag.includes("/health")) {
        return { ok: true, status: 200, text: async () => "" };
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

    const result = await runLlamaCppLoop(
      messages, { send: makeEmittersend() }, {}, undefined, () => {},
      baseCtx("qwen2.5:3b", {
        callTool,
        getOpenAiTools: () => tools,
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

  test("sends images directly to a native-vision main model without using the omitted VLM bridge", async () => {
    let requestBody;
    mock.method(globalThis, "fetch", async (url, opts) => {
      const tag = String(url);
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
      requestBody = JSON.parse(opts.body);
      return {
        ok: true, status: 200, text: async () => "",
        body: sseStream([
          'data: {"choices":[{"index":0,"delta":{"content":"The main vision model saw it."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":7}}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    });
    const callTool = mock.fn(async () => assert.fail("native vision should not call the VLM bridge"));
    const result = await runLlamaCppLoop(
      [{ role: "user", content: [
        { type: "text", text: "Describe this image" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } },
      ]}],
      { send: makeEmittersend() }, {}, undefined, () => {},
      baseCtx("unsloth/Qwen3.5-9B-GGUF:Q4_K_M", { callTool }),
    );

    assert.equal(result, "The main vision model saw it.");
    const wireContent = requestBody.messages.at(-1).content;
    assert.ok(wireContent.some(b => b.type === "image_url"), "the raw image should reach the native-vision model");
    assert.equal(wireContent.find(b => b.type === "image_url").image_url.url, "data:image/png;base64,pixels");
  });

  test("sends images directly to an allowlisted capable model", async () => {
    const previous = process.env.APERIO_CAPABLE_MODELS;
    process.env.APERIO_CAPABLE_MODELS = "qwen3:32b";
    try {
      let requestBody;
      mock.method(globalThis, "fetch", async (url, opts) => {
        const tag = String(url);
        if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
        requestBody = JSON.parse(opts.body);
        return {
          ok: true, status: 200, text: async () => "",
          body: sseStream([
            'data: {"choices":[{"index":0,"delta":{"content":"The capable model saw it."},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":6}}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      });
      const callTool = mock.fn(async () => assert.fail("capable model should not call the VLM bridge"));
      const result = await runLlamaCppLoop(
        [{ role: "user", content: [
          { type: "text", text: "Describe this image" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } },
        ]}],
        { send: makeEmittersend() }, {}, undefined, () => {},
        baseCtx("qwen3:32b", { callTool }),
      );

      assert.equal(result, "The capable model saw it.");
      const wireContent = requestBody.messages.at(-1).content;
      assert.ok(wireContent.some(b => b.type === "image_url"));
    } finally {
      if (previous === undefined) delete process.env.APERIO_CAPABLE_MODELS;
      else process.env.APERIO_CAPABLE_MODELS = previous;
    }
  });

});

// =============================================================================
// test: empty-completion retry
// =============================================================================
describe("runLlamaCppLoop — empty-completion retry", () => {
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
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
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

    const result = await runLlamaCppLoop(
      [{ role: "user", content: "Make a doc" }], { send: makeEmittersend() }, {}, undefined, () => {}, baseCtx("gemma4:12b"));

    assert.equal(chatCalls, 2, "should have retried exactly once");
    assert.equal(result, "Recovered");
    assert.equal(bodies[0].chat_template_kwargs, undefined, "first attempt keeps thinking");
    assert.deepEqual(bodies[1].chat_template_kwargs, { enable_thinking: false }, "retry suppresses thinking");
  });

  test("gives up after one retry and returns the no-response fallback", async () => {
    let chatCalls = 0;
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
      if (tag.includes("/chat/completions")) { chatCalls++; return { ok: true, status: 200, text: async () => "", body: sseStream(EMPTY_SSE) }; }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const result = await runLlamaCppLoop(
      [{ role: "user", content: "Make a doc" }], { send: makeEmittersend() }, {}, undefined, () => {}, baseCtx("gemma4:12b"));

    assert.equal(chatCalls, 2, "one original + one retry, then give up");
    assert.match(result, /no response/i);
  });
});

// =============================================================================
// test: tool-call leakage retry
// =============================================================================
describe("runLlamaCppLoop — tool-call leakage", () => {
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
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
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
    const result = await runLlamaCppLoop(
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
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
      if (tag.includes("/chat/completions")) { chatCalls++; return { ok: true, status: 200, text: async () => "", body: sseStream(LEAK_SSE) }; }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const result = await runLlamaCppLoop(
      [{ role: "user", content: "check your memories for exam" }], { send: makeEmittersend() }, {}, undefined, () => {}, baseCtx("gemma4:e4b"));

    assert.equal(chatCalls, 2, "one original + one retry, then give up");
    assert.match(result, /couldn't issue the call correctly/i);
  });
});

// =============================================================================
// test: system-prompt echo retry
// =============================================================================
describe("runLlamaCppLoop — system-prompt echo", () => {
  afterEach(() => { reset(); });

  const SYSTEM_PROMPT = [
    "Aperio is a co-pilot: an accurate, honest, and direct thinking partner",
    "for the user it supports. Its job is to help them move faster, think",
    "sharper, and build better — by being genuinely useful, not by agreeing",
    "or filling silence. Think with the user, not for them.",
  ].join(" ");

  function echoSSE(text) {
    return [
      `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n`,
      `data: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}},"finish_reason":null}]}\n\n`,
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ];
  }

  test("retracts a verbatim system-prompt recitation, retries once, then renders the real answer", async () => {
    let chatCalls = 0;
    const bodies = [];
    mock.method(globalThis, "fetch", async (url, opts) => {
      const tag = String(url);
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
      if (tag.includes("/chat/completions")) {
        bodies.push(JSON.parse(opts.body));
        chatCalls++;
        const chunks = chatCalls === 1 ? echoSSE(SYSTEM_PROMPT.repeat(2)) : [
          'data: {"choices":[{"index":0,"delta":{"content":"Issue #229 asks each model to sign a comment."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":4}}\n\n',
          'data: [DONE]\n\n',
        ];
        return { ok: true, status: 200, text: async () => "", body: sseStream(chunks) };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const emitter = { send: makeEmittersend() };
    const result = await runLlamaCppLoop(
      [{ role: "user", content: "take a look of GitHub issue #229" }], emitter, {}, undefined, () => {},
      baseCtx("gemma4:e4b", { getSystemPrompt: () => SYSTEM_PROMPT }));

    assert.equal(chatCalls, 2, "should retry exactly once");
    assert.equal(result, "Issue #229 asks each model to sign a comment.");
    assert.ok(emitter.send.mock.calls.some(c => c.arguments[0]?.type === "retract"), "should retract the echoed prompt");
    assert.match(bodies[1].messages[0].content, /repeated your own system instructions/i);
  });

  test("surfaces an honest error when the echo persists after the retry", async () => {
    let chatCalls = 0;
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
      if (tag.includes("/chat/completions")) { chatCalls++; return { ok: true, status: 200, text: async () => "", body: sseStream(echoSSE(SYSTEM_PROMPT.repeat(2))) }; }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const result = await runLlamaCppLoop(
      [{ role: "user", content: "take a look of GitHub issue #229" }], { send: makeEmittersend() }, {}, undefined, () => {},
      baseCtx("gemma4:e4b", { getSystemPrompt: () => SYSTEM_PROMPT }));

    assert.equal(chatCalls, 2, "one original + one retry, then give up");
    assert.match(result, /couldn't issue the call correctly/i);
  });
});

// =============================================================================
// test: corrupted native tool-call name recovery
// =============================================================================
describe("runLlamaCppLoop — corrupted tool name", () => {
  afterEach(() => { reset(); });

  const TOOLS = [{ type: "function", function: { name: "db_schema" } }];

  // gemma wrapped its call in hallucinated channel markup; llama.cpp dumped the
  // raw text into function.name. The real tool ("db_schema") is still embedded.
  const CORRUPT_TC_SSE = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"t1","function":{"name":"thought <|channel>thought <channel|><|tool_call>call:db_schema","arguments":"{\\"connection\\":\\"aperio\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"input_tokens":10,"output_tokens":8}}\n\n',
    'data: [DONE]\n\n',
  ];

  test("recovers the embedded tool name and dispatches the real tool", async () => {
    const calledNames = [];
    mock.method(globalThis, "fetch", async (url) => {
      const tag = String(url);
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
      if (tag.includes("/chat/completions")) return { ok: true, status: 200, text: async () => "", body: sseStream(CORRUPT_TC_SSE) };
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const ctx = baseCtx("gemma4:12b", {
      getOpenAiTools: () => TOOLS,
      callTool: mock.fn(async (name) => { calledNames.push(name); return "ok"; }),
    });
    // One turn issues the (recovered) tool call; stop the loop after by aborting.
    let turns = 0;
    const getAbort = () => ({ signal: { aborted: turns++ > 0 } });

    await runLlamaCppLoop(
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
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
      if (tag.includes("/chat/completions")) { chatCalls++; return { ok: true, status: 200, text: async () => "", body: sseStream(BAD_SSE) }; }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const emitter = { send: makeEmittersend() };
    const result = await runLlamaCppLoop(
      [{ role: "user", content: "list tables" }], emitter, {}, undefined, () => {}, baseCtx("gemma4:12b", { getOpenAiTools: () => TOOLS }));

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
