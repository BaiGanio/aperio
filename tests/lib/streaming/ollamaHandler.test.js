// tests/lib/streaming/ollamaHandler.test.js
import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { OllamaStreamHandler } from "../../../lib/streaming/ollamaHandler.js";

// =============================================================================
// Helpers
// =============================================================================

const noopAdapter = () => ({
  thinks:      false,
  createState: () => ({}),
  processDelta(delta, _state, _emit) {
    return { contentToken: delta.content ?? null };
  },
  stripReasoning(text) { return text; },
});

function mockEmitter() {
  return { send: mock.fn() };
}

/**
 * Build a mock ReadableStream response suitable for SSE consumption.
 *
 * Each `chunks` element is an SSE string (or a Uint8Array) that will be
 * emitted by the reader one at a time, decoded by the handler's internal
 * TextDecoder.
 */
function mockResponse(chunks = []) {
  let idx = 0;
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (idx >= chunks.length) return { done: true, value: undefined };
            const raw = typeof chunks[idx] === "string"
              ? new TextEncoder().encode(chunks[idx])
              : chunks[idx];
            idx++;
            return { done: false, value: raw };
          },
        };
      },
    },
  };
}

function buildHandler({ chunks = [], adapter, emitter, callTool } = {}) {
  return new OllamaStreamHandler(
    mockResponse(chunks),
    emitter ?? mockEmitter(),
    adapter ?? noopAdapter(),
    callTool ?? mock.fn(),
    { name: "test-provider" },
  );
}

// Helper to encode a complete SSE line ready for the stream.
const sse = (json) => `data: ${JSON.stringify(json)}\n`;

// Helper to build SSE data lines wrapped in the full response envelope.
const deltaContent = (text, opts = {}) => sse({
  choices: [{ index: 0, delta: { content: text, ...opts }, finish_reason: null }],
});

const deltaToolCall = (toolDelta, opts = {}) => sse({
  choices: [{ index: 0, delta: { tool_calls: [toolDelta], ...opts }, finish_reason: null }],
});

const deltaReasoning = (text) => sse({
  choices: [{ index: 0, delta: { reasoning_content: text, content: "" }, finish_reason: null }],
});

const doneMarker = "data: [DONE]\n";

// =============================================================================
// processChunk
// =============================================================================

describe("processChunk", () => {
  test("parses a normal SSE data line and processes its delta", () => {
    const h = buildHandler();
    const emitter = h.emitter;

    h.processChunk(deltaContent("Hello"));
    assert.equal(h.fullText, "Hello");
    assert.equal(emitter.send.mock.calls.length, 1);
    assert.deepEqual(emitter.send.mock.calls[0].arguments[0], { type: "token", text: "Hello" });
  });

  test("processChunk returns false for normal data", () => {
    const h = buildHandler();
    assert.equal(h.processChunk(deltaContent("x")), false);
  });

  test("returns true for [DONE] marker", () => {
    const h = buildHandler();
    assert.equal(h.processChunk(doneMarker), true);
  });

  test("skips lines that do not start with 'data: '", () => {
    const h = buildHandler();
    const result = h.processChunk("not a data line\nmore data\n");
    assert.equal(result, false);
    assert.equal(h.fullText, "");
  });

  test("skips invalid JSON after 'data: ' prefix", () => {
    const h = buildHandler();
    h.processChunk("data: {broken json}\n");
    assert.equal(h.fullText, "");
  });

  test("handles multiple data lines in a single chunk", () => {
    const h = buildHandler();
    const chunk = deltaContent("A") + deltaContent("B");
    h.processChunk(chunk);
    assert.equal(h.fullText, "AB");
  });

  test("extracts usage from a data line (prompt, completion, reasoning tokens)", () => {
    const h = buildHandler();
    const usageLine = sse({
      usage: { prompt_tokens: 10, completion_tokens: 25, completion_tokens_details: { reasoning_tokens: 5 } },
    });
    h.processChunk(usageLine + deltaContent("answer"));
    assert.deepEqual(h.streamUsage, { input_tokens: 10, output_tokens: 25, thinking_tokens: 5 });
    assert.equal(h.fullText, "answer");
  });

  test("extracts usage with zero defaults when fields are missing", () => {
    const h = buildHandler();
    const usageLine = sse({ usage: {} });
    h.processChunk(usageLine + deltaContent("x"));
    assert.deepEqual(h.streamUsage, { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
  });

  test("skips delta when choices[0].delta is missing", () => {
    const h = buildHandler();
    const line = sse({ choices: [{ index: 0 }] });
    h.processChunk(line);
    assert.equal(h.fullText, "");
  });
});

// =============================================================================
// processDelta — tool calls
// =============================================================================

describe("processDelta — tool calls", () => {
  test("accumulates a single tool call with name and arguments", () => {
    const h = buildHandler();
    h.processDelta({
      tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"' } }],
    });
    h.processDelta({
      tool_calls: [{ index: 0, function: { arguments: 'test.txt"}' } }],
    });
    assert.equal(h.toolCalls.length, 1);
    assert.equal(h.toolCalls[0].id, "call_1");
    assert.equal(h.toolCalls[0].name, "read_file");
    assert.equal(h.toolCalls[0].args, '{"path":"test.txt"}');
    assert.equal(h.mightBeToolCall, true);
  });

  test("handles multiple tool calls by index", () => {
    const h = buildHandler();
    h.processDelta({
      tool_calls: [
        { index: 0, id: "c1", function: { name: "read_file", arguments: '{"p":"a"}' } },
        { index: 1, id: "c2", function: { name: "write_file", arguments: '{"p":"b"}' } },
      ],
    });
    assert.equal(h.toolCalls.length, 2);
    assert.equal(h.toolCalls[0].id, "c1");
    assert.equal(h.toolCalls[0].name, "read_file");
    assert.equal(h.toolCalls[1].id, "c2");
    assert.equal(h.toolCalls[1].name, "write_file");
  });

  test("sets mightBeToolCall to true on tool_calls delta", () => {
    const h = buildHandler();
    assert.equal(h.mightBeToolCall, false);
    h.processDelta({ tool_calls: [{ index: 0, function: { name: "t" } }] });
    assert.equal(h.mightBeToolCall, true);
  });

  test("buffers content tokens to tokenBuffer when mightBeToolCall is true", () => {
    const h = buildHandler();
    h.mightBeToolCall = true;
    h.processDelta({ content: "some buffered text" });
    assert.equal(h.tokenBuffer, "some buffered text");
    // Should NOT emit to the emitter
    assert.equal(h.emitter.send.mock.calls.length, 0);
  });

  test("does not buffer when mightBeToolCall is false", () => {
    const h = buildHandler();
    h.mightBeToolCall = false;
    h.processDelta({ content: "direct text" });
    assert.equal(h.fullText, "direct text");
    assert.equal(h.tokenBuffer, "");
    assert.equal(h.emitter.send.mock.calls.length, 1);
    assert.deepEqual(h.emitter.send.mock.calls[0].arguments[0], { type: "token", text: "direct text" });
  });
});

// =============================================================================
// processDelta — reasoning / thinking
// =============================================================================

describe("processDelta — reasoning / thinking", () => {
  test("accumulates reasoning_content from delta", () => {
    const h = buildHandler();
    h.processDelta({ reasoning_content: "step 1\n", content: "" });
    h.processDelta({ reasoning_content: "step 2\n", content: "answer" });
    assert.equal(h.reasoningContent, "step 1\nstep 2\n");
  });

  test("accumulates reasoning from delta", () => {
    const h = buildHandler();
    h.processDelta({ reasoning: "deep ", content: "" });
    h.processDelta({ reasoning: "thought", content: " result" });
    assert.equal(h.reasoningContent, "deep thought");
  });

  test("sets detectedThinking when adapter does not think and reasoning appears", () => {
    const h = buildHandler({ adapter: { ...noopAdapter(), thinks: false } });
    h.processDelta({ reasoning: "thinking...", content: "" });
    assert.equal(h.detectedThinking, true);
  });

  test("does NOT set detectedThinking when adapter.thinks is true", () => {
    const h = buildHandler({ adapter: { ...noopAdapter(), thinks: true } });
    h.processDelta({ reasoning: "thinking...", content: "" });
    assert.equal(h.detectedThinking, false);
  });
});

// =============================================================================
// processDelta — normal content via adapter
// =============================================================================

describe("processDelta — normal content via adapter", () => {
  test("delegates to adapter.processDelta and appends returned contentToken", () => {
    const processDelta = mock.fn((delta) => ({ contentToken: delta.content?.toUpperCase() ?? null }));
    const h = buildHandler({ adapter: { ...noopAdapter(), processDelta } });
    h.processDelta({ content: "hello" });
    assert.equal(processDelta.mock.calls.length, 1);
    assert.equal(h.fullText, "HELLO");
  });

  test("null contentToken from adapter is not appended", () => {
    const processDelta = mock.fn(() => ({ contentToken: null }));
    const h = buildHandler({ adapter: { ...noopAdapter(), processDelta } });
    h.processDelta({ content: "skip" });
    assert.equal(h.fullText, "");
  });

  test("adapter emit function sends events to the emitter", () => {
    let capturedEmit = null;
    const adapter = {
      ...noopAdapter(),
      processDelta(delta, _state, emit) {
        capturedEmit = emit;
        return { contentToken: delta.content ?? null };
      },
    };
    const h = buildHandler({ adapter });
    h.processDelta({ content: "x" });
    assert.ok(capturedEmit);
    capturedEmit({ type: "custom", data: 1 });
    assert.deepEqual(h.emitter.send.mock.calls[1].arguments[0], { type: "custom", data: 1 });
  });
});

// =============================================================================
// flushAdapter
// =============================================================================

describe("flushAdapter", () => {
  test("calls adapter.flushState and appends returned text when flushState exists", () => {
    const flushState = mock.fn(() => "flushed content");
    const h = buildHandler({ adapter: { ...noopAdapter(), flushState } });
    h.flushAdapter();
    assert.equal(flushState.mock.calls.length, 1);
    assert.equal(h.fullText, "flushed content");
  });

  test("emits flushed content as token event when mightBeToolCall is false", () => {
    const flushState = () => "flushed";
    const h = buildHandler({ adapter: { ...noopAdapter(), flushState } });
    h.mightBeToolCall = false;
    h.flushAdapter();
    const calls = h.emitter.send.mock.calls;
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].arguments[0], { type: "token", text: "flushed" });
  });

  test("adds flushed text to tokenBuffer when mightBeToolCall is true", () => {
    const flushState = () => "buffered-flush";
    const h = buildHandler({ adapter: { ...noopAdapter(), flushState } });
    h.mightBeToolCall = true;
    h.flushAdapter();
    assert.equal(h.tokenBuffer, "buffered-flush");
    // No token event when mightBeToolCall is true
    assert.equal(h.emitter.send.mock.calls.length, 0);
  });

  test("does nothing when adapter.flushState is undefined", () => {
    const h = buildHandler();
    h.flushAdapter();
    assert.equal(h.fullText, "");
  });

  test("does nothing when flushState returns undefined/null", () => {
    const flushState = () => undefined;
    const h = buildHandler({ adapter: { ...noopAdapter(), flushState } });
    h.flushAdapter();
    assert.equal(h.fullText, "");
  });
});

// =============================================================================
// flushRemainingTokenBuffer
// =============================================================================

describe("flushRemainingTokenBuffer", () => {
  test("emits buffered tokens and clears the buffer", () => {
    const h = buildHandler();
    h.tokenBuffer = "buffered data";
    h.flushRemainingTokenBuffer();
    const calls = h.emitter.send.mock.calls;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].arguments[0], { type: "stream_start" });
    assert.deepEqual(calls[1].arguments[0], { type: "token", text: "buffered data" });
    assert.equal(h.tokenBuffer, "");
  });

  test("does nothing when tokenBuffer is empty", () => {
    const h = buildHandler();
    h.flushRemainingTokenBuffer();
    assert.equal(h.emitter.send.mock.calls.length, 0);
  });
});

// =============================================================================
// process — full stream lifecycle
// =============================================================================

describe("process — full stream lifecycle", () => {
  test("reads chunks, processes deltas, and returns the expected result", async () => {
    const em = mockEmitter();
    const h = buildHandler({
      chunks: [
        deltaContent("Hel"),
        deltaContent("lo "),
        deltaContent("world"),
        doneMarker,
      ],
      emitter: em,
    });

    const result = await h.process();

    assert.equal(h.fullText, "Hello world");
    assert.equal(result.text, "Hello world");
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.cleanText, "Hello world");
    assert.equal(result.reasoningContent, null);

    // stream_start + 2 token events (one per flush) + stream_end from flushRemainingTokenBuffer
    // Actually with doneMarker triggering the loop break, there's no flushRemainingTokenBuffer
    // Let's check the tokens were sent
    const tokenCalls = em.send.mock.calls.filter(c => c.arguments[0].type === "token");
    assert.equal(tokenCalls.length, 3);
    assert.equal(tokenCalls[0].arguments[0].text, "Hel");
    assert.equal(tokenCalls[1].arguments[0].text, "lo ");
    assert.equal(tokenCalls[2].arguments[0].text, "world");
  });

  test("handles a stream with tool calls and reasoning content", async () => {
    const em = mockEmitter();
    const adapter = {
      ...noopAdapter(),
      processDelta(delta, _state, _emit) {
        // For tool calls, the OllamaStreamHandler processes tool_calls before
        // reaching the adapter, so delta.content may be undefined or null.
        // Only return contentToken when content is present.
        return { contentToken: delta.content ?? null };
      },
    };
    const h = buildHandler({
      chunks: [
        deltaReasoning("Let me think\n"),
        deltaContent(""),
        deltaToolCall({ index: 0, id: "tc1", function: { name: "read_file", arguments: '{"path":"' } }),
        deltaToolCall({ index: 0, function: { arguments: 'x.txt"}' } }),
        doneMarker,
      ],
      emitter: em,
      adapter,
    });

    const result = await h.process();

    assert.equal(h.reasoningContent, "Let me think\n");
    assert.equal(h.toolCalls.length, 1);
    assert.equal(h.toolCalls[0].name, "read_file");
    assert.equal(h.toolCalls[0].args, '{"path":"x.txt"}');
    // fullText should include the content from the adapter (which is empty content
    // for reasoning/tool-call deltas), plus the tool call response
    // Since tool calls buffer content, and the adapter may produce null contentToken,
    // fullText may just be reasoning -> which is not added to fullText automatically
    // by the handler (reasoning/reasoning_content are NOT added to fullText).
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.reasoningContent, "Let me think\n");
  });

  test("skips partial SSE lines that are not delimited by \\n", async () => {
    // The handler splits chunks by "\n" and processes complete lines only.
    // Partial lines (no newline) are silently dropped.
    const em = mockEmitter();
    const h = buildHandler({
      chunks: [
        "partial data without newline... ",
        deltaContent("hi"),   // complete line — gets processed
        doneMarker,
      ],
      emitter: em,
    });
    const result = await h.process();
    assert.equal(result.text, "hi");
  });

  test("returns reasoningContent as null when there is none", async () => {
    const h = buildHandler({
      chunks: [deltaContent("hi"), doneMarker],
    });
    const result = await h.process();
    assert.equal(result.reasoningContent, null);
  });

  test("process does NOT flush tokenBuffer — caller must call flushRemainingTokenBuffer", async () => {
    const em = mockEmitter();
    const h = buildHandler({
      chunks: [
        deltaToolCall({ index: 0, function: { name: "t" } }),
        deltaContent("buffered text"),
        doneMarker,
      ],
      emitter: em,
    });
    // Tool call sets mightBeToolCall → subsequent content goes to tokenBuffer.
    // But fullText still accumulates it (it's just also placed in tokenBuffer).
    const result = await h.process();
    assert.equal(h.tokenBuffer, "buffered text");
    assert.equal(result.text, "buffered text");  // fullText still collects content
    // No direct token events for the buffered content (it's not emitted live)
    const tokenEvents = em.send.mock.calls.filter(c => c.arguments[0].type === "token");
    assert.equal(tokenEvents.length, 0);
  });
});

// =============================================================================
// constructor
// =============================================================================

describe("constructor", () => {
  test("initializes all state fields", () => {
    const em = mockEmitter();
    const adapter = noopAdapter();
    const ct = mock.fn();
    const res = mockResponse();
    const h = new OllamaStreamHandler(res, em, adapter, ct, { name: "p" });
    assert.equal(h.response, res);
    assert.equal(h.emitter, em);
    assert.equal(h.adapter, adapter);
    assert.equal(h.callTool, ct);
    assert.equal(h.fullText, "");
    assert.equal(h.reasoningContent, "");
    assert.deepEqual(h.toolCalls, []);
    assert.equal(h.tokenBuffer, "");
    assert.equal(h.mightBeToolCall, false);
    assert.equal(h.detectedThinking, false);
    assert.deepEqual(h.streamUsage, { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
  });

  test("calls adapter.createState and stores the result", () => {
    const state = { foo: 1 };
    const createState = () => state;
    const adapter = { ...noopAdapter(), createState };
    const h = buildHandler({ adapter });
    assert.equal(h.adapterState, state);
  });
});

// =============================================================================
// streamUsage
// =============================================================================

describe("streamUsage", () => {
  test("tracks usage across multiple chunks and returns the last value", () => {
    const h = buildHandler({ chunks: [
      sse({ usage: { prompt_tokens: 5, completion_tokens: 10 } }) + deltaContent("a"),
      sse({ usage: { prompt_tokens: 10, completion_tokens: 25, completion_tokens_details: { reasoning_tokens: 5 } } }) + deltaContent("b"),
      doneMarker,
    ] });
    return h.process().then(() => {
      assert.equal(h.streamUsage.input_tokens, 10);
      assert.equal(h.streamUsage.output_tokens, 25);
      assert.equal(h.streamUsage.thinking_tokens, 5);
    });
  });
});
