// tests/lib/agent/providers/llamacpp-thinking-timeout.test.js
//
// Provider-loop regression coverage for the thinking-timeout guardrail
// (lib/streaming/llamacppHandler.js). tests/unit/streaming/llamacppHandler.test.js
// pins the guard's own behavior (cutoff timing, reasoning_done emission,
// semantic-emptiness check) against LlamaCppStreamHandler in isolation; this
// file proves the caller wiring it depends on actually holds end to end:
// cancellation, the reasoning_done frame-close, runLlamaCppLoop's
// empty-completion retry recognizing the cutoff, and a second request with
// thinking suppressed that recovers a real answer.
//
// Lives in its own file because it needs a tiny LLAMACPP_THINKING_TIMEOUT_MS —
// the constant freezes at import time (see llamacppHandler.js), and
// tests/unit/providers/llamacpp.test.js already imports the module once, at
// the real default, for its own suite.

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import logger from "../../../lib/helpers/logger.js";

let infoCalls = [];
before(() => {
  mock.method(logger, "info", (...args) => { infoCalls.push(args); });
  mock.method(logger, "warn", () => {});
  mock.method(logger, "error", () => {});
});
after(() => { mock.restoreAll(); });

let runLlamaCppLoop;
before(async () => {
  process.env.LLAMACPP_THINKING_TIMEOUT_MS = "100";
  process.env.LLAMACPP_VLM_MODEL = "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF";
  const mod = await import("../../../lib/agent/providers/llamacpp.js");
  runLlamaCppLoop = mod.runLlamaCppLoop;
});

function makeEmittersend() { return mock.fn(); }

function baseCtx(model, overrides = {}) {
  return {
    provider: {
      name: "llamacpp",
      model,
      llamacppBaseURL: "http://127.0.0.1:8080",
      baseURL: "http://127.0.0.1:8080/v1",
      contextWindow: 8192,
      vision: false,
    },
    callTool: mock.fn(),
    getSystemPrompt: () => "You are a helpful assistant.",
    getOpenAiTools: () => [],
    reasoningAdapter: {
      createState: () => ({}),
      processDelta: (delta, _state, _emit) => ({ contentToken: delta?.content ?? null }),
      thinks: false,
      stripReasoning: (t) => t,
    },
    state: { noTools: false, thinks: false },
    ...overrides,
  };
}

function sseStream(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
}

// A hand-rolled reader (not a real ReadableStream, whose own automatic
// pull-ahead prefetching makes fake-clock ticks land unpredictably relative
// to the handler's read loop — see tests/unit/streaming/llamacppHandler.test.js,
// which uses the same pattern for its own thinking-timeout tests). Emits one
// reasoning-only SSE line per read() and advances the test's fake Date clock
// alongside it, so the wall-clock elapsed time the thinking-timeout guard
// checks via Date.now() actually accrues without a real multi-second test.
function slowReasoningBody(t, chunks, msPerChunk, cancel) {
  const enc = new TextEncoder();
  let idx = 0;
  return {
    getReader() {
      return {
        async read() {
          if (idx >= chunks.length) return { done: true, value: undefined };
          t.mock.timers.tick(msPerChunk);
          return { done: false, value: enc.encode(chunks[idx++]) };
        },
        cancel,
      };
    },
  };
}

describe("runLlamaCppLoop — thinking-timeout guardrail wiring", () => {
  afterEach(() => { infoCalls = []; });

  test("a cutoff mid-reasoning closes the reasoning frame, cancels the reader, and retries once with thinking suppressed", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const cancel = mock.fn(async () => {});
    const REASONING_CHUNKS = [
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking...\\n","content":""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"still thinking...\\n","content":""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"more...\\n","content":""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"even more...\\n","content":""},"finish_reason":null}]}\n\n',
    ];
    let chatCalls = 0;
    const bodies = [];
    mock.method(globalThis, "fetch", async (url, opts) => {
      const tag = String(url);
      if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
      if (tag.includes("/chat/completions")) {
        bodies.push(JSON.parse(opts.body));
        chatCalls++;
        if (chatCalls === 1) {
          return { ok: true, status: 200, text: async () => "", body: slowReasoningBody(t, REASONING_CHUNKS, 60, cancel) };
        }
        return { ok: true, status: 200, text: async () => "", body: sseStream([
          'data: {"choices":[{"index":0,"delta":{"content":"Recovered"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":10,"output_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ]) };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    });

    const emitter = { send: makeEmittersend() };
    const result = await runLlamaCppLoop(
      [{ role: "user", content: "Make a plan" }], emitter, {}, undefined, () => {}, baseCtx("gemma4:12b"));

    assert.equal(chatCalls, 2, "should have retried exactly once after the cutoff");
    assert.equal(result, "Recovered", "the retry must actually recover a real answer, not just fall back to a generic message");
    assert.equal(cancel.mock.calls.length, 1, "the timed-out reader must be cancelled, not just abandoned");
    assert.equal(bodies[0].chat_template_kwargs, undefined, "first attempt keeps thinking on");
    assert.deepEqual(bodies[1].chat_template_kwargs, { enable_thinking: false }, "retry after the cutoff suppresses thinking");

    const types = emitter.send.mock.calls.map(c => c.arguments[0].type);
    const doneIdx = types.indexOf("reasoning_done");
    const secondStreamStartIdx = types.indexOf("stream_start", doneIdx + 1);
    assert.notEqual(doneIdx, -1, "the cutoff must close the reasoning frame with reasoning_done");
    assert.notEqual(secondStreamStartIdx, -1, "a second stream_start must follow the cutoff, for the retry");
    assert.ok(doneIdx < secondStreamStartIdx,
      "reasoning_done must fire before the retry's own stream_start — otherwise a UI that pairs " +
      "them (e.g. the CLI emitter's inReasoning flag, which stream_start does not reset) starts " +
      "the retry still stuck in the previous reasoning frame");

    const infoMsg = infoCalls.map(a => a[0]).find(m => /runaway reasoning/i.test(m));
    assert.ok(infoMsg, "should log the runaway-reasoning cutoff specifically, not a generic empty-completion message");
  });
});
