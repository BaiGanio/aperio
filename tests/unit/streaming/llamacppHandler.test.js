// tests/lib/streaming/llamacppHandler.test.js
import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { LlamaCppStreamHandler } from "../../../lib/streaming/llamacppHandler.js";
import { resolveReasoningAdapter } from "../../../lib/workers/reasoning.js";

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
  return new LlamaCppStreamHandler(
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

  test("does NOT drop a token when its SSE line is split across chunks", () => {
    // Regression: long streamed outputs (e.g. an HTML page) lost scattered
    // characters because a `data: {…}` line straddling two network reads had
    // both halves discarded. The line buffer must reassemble it.
    const h = buildHandler();
    const full = deltaContent("font-weight: 600");
    const cut = Math.floor(full.length / 2);
    h.processChunk(full.slice(0, cut));   // first half — no newline yet
    assert.equal(h.fullText, "");          // nothing emitted until the line completes
    h.processChunk(full.slice(cut));       // remainder + newline
    assert.equal(h.fullText, "font-weight: 600");
  });

  test("reassembles a line split across three chunks", () => {
    const h = buildHandler();
    const full = deltaContent("transition: color 0.2s");
    h.processChunk(full.slice(0, 10));
    h.processChunk(full.slice(10, 22));
    h.processChunk(full.slice(22));
    assert.equal(h.fullText, "transition: color 0.2s");
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
// flushBufferedContent
// =============================================================================

describe("flushBufferedContent", () => {
  test("emits buffered tokens as a plain token event, without restarting the stream", () => {
    const h = buildHandler();
    h.tokenBuffer = "the rest of the sentence";
    h.flushBufferedContent();
    const calls = h.emitter.send.mock.calls;
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].arguments[0], { type: "token", text: "the rest of the sentence" });
    assert.equal(h.tokenBuffer, "");
  });

  test("does nothing when tokenBuffer is empty", () => {
    const h = buildHandler();
    h.flushBufferedContent();
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
        // For tool calls, the LlamaCppStreamHandler processes tool_calls before
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

  test("reassembles an SSE line split across chunk boundaries", async () => {
    // Network reads routinely cut a `data: {…}` line in half. The handler must
    // buffer the partial line and complete it with the next chunk rather than
    // dropping both halves (which corrupted long streamed outputs).
    const em = mockEmitter();
    const full = deltaContent("hi");   // "data: {…}\n"
    const cut = full.length - 4;
    const h = buildHandler({
      chunks: [
        full.slice(0, cut),   // first half, no newline yet
        full.slice(cut),      // remainder + newline
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

  test("captures a mid-stream error object into streamError and ends the stream", async () => {
    // llama-server returns HTTP 200 for a streaming request, then emits the
    // failure inside the stream (e.g. an OOM Metal alloc → "Compute error.").
    // The handler must surface it, not drop it as an empty completion.
    const em = mockEmitter();
    const h = buildHandler({
      chunks: [
        deltaContent("partial"),
        sse({ error: { code: 500, message: "Compute error.", type: "server_error" } }),
        deltaContent("never reached"),
        doneMarker,
      ],
      emitter: em,
    });

    const result = await h.process();

    assert.equal(h.streamError, "Compute error.");
    // Stream ended at the error line — content after it is not consumed.
    assert.equal(result.text, "partial");
    assert.deepEqual(result.toolCalls, []);
  });

  test("falls back to the error type when the error object has no message", async () => {
    const h = buildHandler({
      chunks: [sse({ error: { type: "server_error" } }), doneMarker],
    });
    await h.process();
    assert.equal(h.streamError, "server_error");
  });
});

// =============================================================================
// process — idle stream timeout
// =============================================================================

describe("process — idle stream timeout", () => {
  test("ends the stream gracefully and cancels the reader when reads stall past the idle timeout", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const cancel = mock.fn(async () => {});
    const response = {
      body: {
        getReader() {
          return {
            read() { return new Promise(() => {}); }, // a genuinely stuck connection never resolves
            cancel,
          };
        },
      },
    };
    const em = mockEmitter();
    const h = new LlamaCppStreamHandler(response, em, noopAdapter(), mock.fn(), { name: "test-provider" });

    const resultPromise = h.process();
    t.mock.timers.tick(120_000);
    const result = await resultPromise;

    assert.match(h.streamError, /stalled/);
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(result.text, "");
  });

  test("does not fire the idle timeout when reads keep arriving (e.g. a long prefill's keep-alive pings)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    // Mirrors what llama-server actually does during a long prefill: a 3-byte
    // SSE comment ping every ~30s, well under the 120s idle threshold, until
    // the real token data arrives.
    const chunks = [": \n\n", ": \n\n", ": \n\n", deltaContent("done"), doneMarker];
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(30_000); // advance less than the 120s idle threshold between reads
              return { done: false, value: raw };
            },
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, mockEmitter(), noopAdapter(), mock.fn(), { name: "test-provider" });

    const result = await h.process();

    assert.equal(h.streamError, null);
    assert.equal(result.text, "done");
  });
});

// =============================================================================
// process — thinking timeout
// =============================================================================

describe("process — thinking timeout", () => {
  test("cuts off a stream that keeps reasoning but never answers or calls a tool", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const cancel = mock.fn(async () => {});
    const chunks = [
      deltaReasoning("thinking...\n"),
      deltaReasoning("still thinking...\n"),
      deltaReasoning("more...\n"),
      deltaReasoning("even more...\n"),
      deltaReasoning("even more still...\n"),
    ];
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(60_000); // 60s per chunk
              return { done: false, value: raw };
            },
            cancel,
          };
        },
      },
    };
    const em = mockEmitter();
    const h = new LlamaCppStreamHandler(response, em, noopAdapter(), mock.fn(), { name: "test-provider" });

    const result = await h.process();

    assert.equal(h.thinkingTimedOut, true);
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(h.streamError, null); // not an error path — caller's empty-completion retry handles this
    assert.equal(result.text, "");
    // The deadline is anchored to the FIRST reasoning chunk (read 1, t=60s),
    // not connection start — so it takes 4 reads (t=240s, i.e. 180s of
    // reasoning elapsed since t=60s, exactly the threshold), not 3 (t=180s,
    // which is only 120s of reasoning).
    assert.equal(idx, 4);
  });

  test("does not cut off when the answer arrives before the thinking timeout elapses", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const chunks = [deltaReasoning("thinking...\n"), deltaContent("here is the answer"), doneMarker];
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(30_000); // well under the 180s threshold
              return { done: false, value: raw };
            },
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, mockEmitter(), noopAdapter(), mock.fn(), { name: "test-provider" });

    const result = await h.process();

    assert.equal(h.thinkingTimedOut, false);
    assert.equal(result.text, "here is the answer");
  });

  test("does not cut off a tool call reached before the thinking timeout elapses", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const chunks = [
      deltaReasoning("thinking...\n"),
      deltaToolCall({ index: 0, id: "tc1", function: { name: "read_file", arguments: "{}" } }),
      doneMarker,
    ];
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(30_000);
              return { done: false, value: raw };
            },
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, mockEmitter(), noopAdapter(), mock.fn(), { name: "test-provider" });

    const result = await h.process();

    assert.equal(h.thinkingTimedOut, false);
    assert.equal(result.toolCalls.length, 1);
  });

  test("thinkingTimeoutMs: 0 disables the guard (DeepSeek's call site, which has no suppressed-thinking retry)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const chunks = [
      deltaReasoning("thinking...\n"),
      deltaReasoning("still thinking...\n"),
      deltaReasoning("more...\n"),
      deltaReasoning("even more...\n"),
      deltaContent("finally, the answer"),
      doneMarker,
    ];
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(60_000); // same cadence that trips the guard when it's enabled
              return { done: false, value: raw };
            },
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, mockEmitter(), noopAdapter(), mock.fn(), { name: "test-provider" }, false, 0);

    const result = await h.process();

    assert.equal(h.thinkingTimedOut, false);
    assert.equal(result.text, "finally, the answer");
  });

  test("does NOT cut off a tag-free (unresolved) inline-adapter answer, even past the timeout", async (t) => {
    // Uses the actual production adapter (resolveReasoningAdapter), not a
    // hand-rolled stand-in. A chat template can pre-fill the opening <think>,
    // so the model's content can start INSIDE reasoning with no opening tag —
    // makeTagSplitter then holds every chunk in its speculative buffer and
    // never fires onReasoningStart/onReasoningToken until a </think> arrives
    // (see lib/workers/reasoning.js). That state is observably IDENTICAL to
    // an ordinary tag-free answer that simply takes a long time to finish —
    // there is no signal available mid-stream to tell them apart. An earlier
    // version of this guard treated unresolved buffering as confirmed
    // reasoning and cancelled+discarded it; that risked destroying a
    // legitimate slow answer, so this state is deliberately left untracked.
    // This is the same scenario as the old (now-removed) headless-cutoff
    // test, run for even longer, asserting the opposite outcome.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const adapter = resolveReasoningAdapter("qwen3-7b");
    const cancel = mock.fn(async () => {});
    const chunks = [
      deltaContent("Let me work through "),
      deltaContent("this step by step "),
      deltaContent("without ever closing "),
      deltaContent("the reasoning block "),
      deltaContent("at all, ever, "),
      deltaContent("and it just keeps "),
      deltaContent("taking a genuinely long time."),
      doneMarker,
    ];
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(60_000); // 7 * 60s = 420s, well past the 180s threshold
              return { done: false, value: raw };
            },
            cancel,
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, mockEmitter(), adapter, mock.fn(), { name: "test-provider" });

    const result = await h.process();

    assert.equal(h.thinkingTimedOut, false);
    assert.equal(cancel.mock.calls.length, 0);
    assert.equal(result.text, "Let me work through this step by step without ever closing the reasoning block at all, ever, and it just keeps taking a genuinely long time.");
  });

  test("still flushes an unresolved tag-free lead as the answer when the stream ends normally (not timed out)", async (t) => {
    // Guards against over-correcting the fix above: skipping flushAdapter()
    // must be conditional on thinkingTimedOut specifically, not a blanket
    // change — an ordinary short, tag-free answer via the same real adapter
    // must still come through once the stream completes on its own.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const adapter = resolveReasoningAdapter("qwen3-7b");
    const chunks = [deltaContent("just a plain answer, "), deltaContent("no thinking tags at all"), doneMarker];
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(1_000); // well under the threshold
              return { done: false, value: raw };
            },
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, mockEmitter(), adapter, mock.fn(), { name: "test-provider" });

    const result = await h.process();

    assert.equal(h.thinkingTimedOut, false);
    assert.equal(result.text, "just a plain answer, no thinking tags at all");
  });

  test("anchors the deadline to first reasoning activity, not connection start — a long prefill does not eat the budget", async (t) => {
    // llama-server pings a 3-byte SSE comment throughout a long prefill,
    // before any real delta arrives — none of those lines reach processDelta,
    // so they must not advance the reasoning clock. Reasoning then starts
    // fresh and must get its own full budget, not whatever was left after the
    // prefill (which here has already exceeded the 180s threshold on its own,
    // via connection time — the historical bug this test pins).
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pings = Array(8).fill(": \n\n"); // 8 * 30s = 240s of prefill, already over the 180s threshold
    const chunks = [...pings, deltaReasoning("finally starting to think\n"), deltaContent("the answer"), doneMarker];
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(30_000);
              return { done: false, value: raw };
            },
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, mockEmitter(), noopAdapter(), mock.fn(), { name: "test-provider" });

    const result = await h.process();

    assert.equal(h.thinkingTimedOut, false);
    assert.equal(result.text, "the answer");
  });

  test("a whitespace-only content delta mid-reasoning does not permanently disable the guard", async (t) => {
    // A reasoning stream can emit a whitespace-only content delta (e.g. "\n")
    // before continuing to reason. That makes fullText non-empty even though
    // there is still no real answer — a raw truthiness check on fullText
    // would treat that as "an answer arrived" and never trip again, letting
    // runaway reasoning continue indefinitely. The guard must use the same
    // semantic-emptiness check (stripped + trimmed) as the caller's
    // empty-completion retry.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const cancel = mock.fn(async () => {});
    const chunks = [
      deltaReasoning("thinking...\n"),
      deltaContent("\n"), // whitespace-only — not a real answer
      deltaReasoning("still thinking...\n"),
      deltaReasoning("more...\n"),
      deltaReasoning("even more...\n"),
      deltaReasoning("even more still...\n"),
    ];
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(60_000);
              return { done: false, value: raw };
            },
            cancel,
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, mockEmitter(), noopAdapter(), mock.fn(), { name: "test-provider" });

    const result = await h.process();

    assert.equal(h.thinkingTimedOut, true);
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(result.text, "\n");
  });

  test("closes an open reasoning frame with reasoning_done when the timeout cuts off mid-reasoning", async (t) => {
    // A reasoning_start already sent to the emitter needs its matching
    // reasoning_done, or a UI that pairs them (e.g. the CLI emitter's
    // inReasoning flag, which stream_start does not reset) stays stuck
    // "in reasoning" through the retry that follows this cutoff.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const adapter = resolveReasoningAdapter("deepseek-v4-pro"); // native reasoning_content adapter, emits reasoning_start/done itself
    const em = mockEmitter();
    const chunks = [
      deltaReasoning("thinking...\n"),
      deltaReasoning("still thinking...\n"),
      deltaReasoning("more...\n"),
      deltaReasoning("even more...\n"),
      deltaReasoning("even more still...\n"),
    ];
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(60_000);
              return { done: false, value: raw };
            },
            cancel: mock.fn(async () => {}),
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, em, adapter, mock.fn(), { name: "test-provider" });

    await h.process();

    assert.equal(h.thinkingTimedOut, true);
    const types = em.send.mock.calls.map(c => c.arguments[0].type);
    assert.ok(types.includes("reasoning_start"), "adapter should have opened a reasoning frame");
    assert.equal(types.at(-1), "reasoning_done", "the guard must close the frame before breaking out");
  });

  test("does NOT discard an answer whose first SSE line is only half-buffered when the deadline lands", async (t) => {
    // The guard's own precondition (empty fullText) is also true for the
    // instant between the first fragment of the answer's `data:` line landing
    // in sseBuffer and the newline that completes it — processLine has not run
    // yet, so the answer exists but is invisible to the check. Cancelling there
    // would throw the answer away, because the cutoff path deliberately skips
    // the trailing-buffer flush. Split `data:` lines are routine on this wire.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const answerLine = deltaContent("here is the answer");
    const cancel = mock.fn(async () => {});
    const chunks = [
      deltaReasoning("thinking...\n"),        // t=60s, anchors the 180s deadline
      deltaReasoning("still thinking...\n"),  // t=120s
      deltaReasoning("more...\n"),            // t=180s
      answerLine.slice(0, 30),                // t=240s — deadline due, but half a line is buffered
      answerLine.slice(30),                   // t=300s — completes it
      doneMarker,
    ];
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(60_000);
              return { done: false, value: raw };
            },
            cancel,
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, mockEmitter(), noopAdapter(), mock.fn(), { name: "test-provider" });

    const result = await h.process();

    assert.equal(h.thinkingTimedOut, false, "a buffered partial line must hold the cutoff back");
    assert.equal(cancel.mock.calls.length, 0);
    assert.equal(result.text, "here is the answer");
  });

  test("the partial-line grace is bounded — reads that always end mid-line cannot starve the guard", async (t) => {
    // The counterweight to the test above: if the buffered fragment never
    // resolves into an answer, the guard must still fire rather than defer
    // forever. Every read here ends mid-line, so sseBuffer is never empty at
    // the moment the deadline is checked.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const cancel = mock.fn(async () => {});
    // Reads one byte longer than an SSE line, so every chunk carries the tail
    // of the previous line plus the head of the next — the buffer is never
    // empty when the loop looks at it.
    const line = deltaReasoning("thinking...\n");
    const stream = line.repeat(9);
    const step = line.length + 1;
    const chunks = Array.from({ length: Math.ceil(stream.length / step) }, (_, i) => stream.slice(i * step, (i + 1) * step));
    let idx = 0;
    const response = {
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              const raw = new TextEncoder().encode(chunks[idx++]);
              t.mock.timers.tick(60_000);
              return { done: false, value: raw };
            },
            cancel,
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, mockEmitter(), noopAdapter(), mock.fn(), { name: "test-provider" });

    const result = await h.process();

    assert.equal(h.thinkingTimedOut, true, "the 5s grace must expire, not renew on every fresh partial line");
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(result.text, "");
    assert.ok(idx < chunks.length, "the guard must cut off before the stream ends on its own");
  });

  test("the deadline bounds the pending read too — sparse reasoning cannot stretch the budget", async (t) => {
    // Reasoning chunks arriving just under the 120s idle timeout: checking the
    // deadline only BETWEEN reads let a 180s budget run for ~330s, because
    // each read could stay pending for a full idle interval past it. The wait
    // itself must be capped by whatever is left of the thinking budget.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let cancelledAt = null;
    const cancel = mock.fn(async () => { cancelledAt = Date.now(); });
    let idx = 0;
    // Unlike the other tests here, read() genuinely stays PENDING (resolved by
    // a mock timer) instead of returning already-resolved — that is the whole
    // scenario: a deadline that falls while the loop sits inside one read.
    const response = {
      body: {
        getReader() {
          return {
            read: () => new Promise(resolve => setTimeout(() => {
              if (idx >= 6) return resolve({ done: true, value: undefined });
              resolve({ done: false, value: new TextEncoder().encode(deltaReasoning(`thinking ${idx++}\n`)) });
            }, 110_000)),
            cancel,
          };
        },
      },
    };
    const h = new LlamaCppStreamHandler(response, mockEmitter(), noopAdapter(), mock.fn(), { name: "test-provider" });

    const resultPromise = h.process();
    let settled = false;
    resultPromise.then(() => { settled = true; }, () => { settled = true; });
    // Drive the mock clock in small steps, yielding to the microtask queue
    // between them so the handler's loop can actually run.
    for (let i = 0; i < 100 && !settled; i++) {
      t.mock.timers.tick(10_000);
      await new Promise(r => setImmediate(r));
    }
    await resultPromise;

    assert.equal(h.thinkingTimedOut, true);
    // First reasoning token at t=110s, 180s budget => cut off at t=290s. The
    // pre-fix loop only noticed after the next read landed, at t=330s.
    assert.equal(cancelledAt, 290_000);
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
    const h = new LlamaCppStreamHandler(res, em, adapter, ct, { name: "p" });
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
    assert.equal(h.streamError, null);
    assert.equal(h.thinkingTimedOut, false);
    assert.equal(h.reasoningSeen, false);
    assert.equal(h.reasoningStartMs, null);
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

// =============================================================================
// timings (llama-server extension, not part of the OpenAI schema)
// =============================================================================

describe("timings", () => {
  test("is null when the stream never sends a timings block", async () => {
    const h = buildHandler({ chunks: [deltaContent("hi"), doneMarker] });
    await h.process();
    assert.equal(h.timings, null);
  });

  test("captures timings from the final SSE chunk", async () => {
    const h = buildHandler({ chunks: [
      deltaContent("hi"),
      sse({ timings: { prompt_ms: 12.3, predicted_ms: 45.6, prompt_per_second: 80, predicted_per_second: 22, cache_n: 3 } }),
      doneMarker,
    ] });
    await h.process();
    assert.deepEqual(h.timings, { prompt_ms: 12.3, predicted_ms: 45.6, prompt_per_second: 80, predicted_per_second: 22, cache_n: 3 });
  });
});
