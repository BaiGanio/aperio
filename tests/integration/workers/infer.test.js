// Tests for infer.js — inferMemories
//
// inferMemories already accepts callTool as DI. We added deps.complete and
// deps.logger overrides so ALL external dependencies can be injected without
// touching the real filesystem or any AI provider. Global timers
// (setTimeout/setInterval/clearTimeout/clearInterval) are mocked so no real
// waits or intervals fire.

import { describe, test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Timer tracking — mock BEFORE any dynamic import of the SUT ──────────────

let capturedTimeoutCb   = null;
let capturedTimeoutDelay = null;
let timeoutCleared      = false;
let capturedIntervalCb  = null;
let capturedIntervalDelay = null;
let intervalCleared     = false;

mock.method(globalThis, "setTimeout", (fn, delay) => {
  capturedTimeoutCb = fn;
  capturedTimeoutDelay = delay;
  return {
    _id: Symbol("timeout"),
    unref() {},
    [Symbol.toPrimitive]() { return "mock-timeout"; },
  };
});

mock.method(globalThis, "clearTimeout", () => { timeoutCleared = true; });

mock.method(globalThis, "setInterval", (fn, delay) => {
  capturedIntervalCb = fn;
  capturedIntervalDelay = delay;
  return {
    _id: Symbol("interval"),
    unref() {},
    [Symbol.toPrimitive]() { return "mock-interval"; },
  };
});

mock.method(globalThis, "clearInterval", () => { intervalCleared = true; });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("inferMemories", () => {
  let inferMemories;

  before(async () => {
    const mod = await import("../../../lib/workers/infer.js");
    inferMemories = mod.inferMemories;
  });

  after(() => mock.restoreAll());

  beforeEach(() => {
    capturedTimeoutCb   = null;
    capturedTimeoutDelay = null;
    timeoutCleared      = false;
    capturedIntervalCb  = null;
    capturedIntervalDelay = null;
    intervalCleared     = false;
  });

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Default deps — tests can override specific fields. */
  function mockDeps() {
    return {
      complete: mock.fn(),
      logger:   { info: mock.fn(), debug: mock.fn(), error: mock.fn() },
    };
  }

  /** Default callTool — echoes recall, no-op on remember. */
  function mockCallTool() {
    return mock.fn(async (name, arg) => {
      if (name === "recall") return "a\n---\nb\n---\nc\n---\nd";
      return undefined;
    });
  }

  // ─── Helpers (continued) ────────────────────────────────────────────────────

  /** Drain event loop so floating async promises settle. */
  const drain = () => new Promise(resolve => setImmediate(resolve));

  /** Fire the initial timeout AND let microtasks/macrotasks drain completely. */
  async function fireInitialTimeout() {
    capturedTimeoutCb();
    await drain();
  }

  // ─── Shape & lifecycle ──────────────────────────────────────────────────────

  test("returns { stop } object", () => {
    const inst = inferMemories(mockCallTool(), mockDeps());
    assert.ok(inst);
    assert.strictEqual(typeof inst.stop, "function");
  });

  test("sets setTimeout with 90s initial delay (INITIAL_DELAY_MS)", () => {
    inferMemories(mockCallTool(), mockDeps());
    assert.strictEqual(capturedTimeoutDelay, 90_000);
  });

  test("stop() clears both timeout and interval", () => {
    const inst = inferMemories(mockCallTool(), mockDeps());
    capturedTimeoutCb();
    timeoutCleared = false;
    intervalCleared = false;

    inst.stop();

    assert.strictEqual(timeoutCleared, true);
    assert.strictEqual(intervalCleared, true);
  });

  test("stop() is safe when interval was never created (timeout hasn't fired)", () => {
    const inst = inferMemories(mockCallTool(), mockDeps());
    assert.doesNotThrow(() => inst.stop());
  });

  // ─── Skip paths (no inference triggered) ────────────────────────────────────

  test("does not call complete when recall returns empty", async () => {
    const ct = mock.fn(async () => "No memories found.");
    const deps = mockDeps();

    inferMemories(ct, deps);
    await capturedTimeoutCb();
    await drain();

    assert.strictEqual(deps.complete.mock.callCount(), 0);
  });

  test("does not call complete when recall returns 'No result'", async () => {
    const ct = mock.fn(async () => "No result");
    const deps = mockDeps();

    inferMemories(ct, deps);
    await fireInitialTimeout();

    assert.strictEqual(deps.complete.mock.callCount(), 0);
  });

  test("does not call complete when recall returns null", async () => {
    const ct = mock.fn(async () => null);
    const deps = mockDeps();

    inferMemories(ct, deps);
    await fireInitialTimeout();

    assert.strictEqual(deps.complete.mock.callCount(), 0);
  });

  test("does not call complete when too few blocks remain after stripping [INFERENCE]", async () => {
    const ct = mock.fn(async () => "a\n---\nb"); // 2 blocks after stripping → < 3
    const deps = mockDeps();

    inferMemories(ct, deps);
    await fireInitialTimeout();

    assert.strictEqual(deps.complete.mock.callCount(), 0);
  });

  test("strips [INFERENCE] blocks from recall", async () => {
    const ct = mock.fn(async () =>
      "[INFERENCE] Likes coffee\n---\na\n---\nb\n---\nc"
    );
    const deps = mockDeps();

    inferMemories(ct, deps);
    await fireInitialTimeout();

    // 3 non-inference blocks → enough to proceed, complete is called
    assert.strictEqual(deps.complete.mock.callCount(), 1);
  });

  // ─── complete response handling ─────────────────────────────────────────────

  test("does not remember when complete returns empty JSON array", async () => {
    const ct = mockCallTool();
    const deps = mockDeps();
    deps.complete.mock.mockImplementation(async () => "[]");

    inferMemories(ct, deps);
    await fireInitialTimeout();

    assert.strictEqual(ct.mock.callCount(), 1);
    assert.strictEqual(ct.mock.calls[0].arguments[0], "recall");
  });

  test("does not remember when complete returns non-JSON text", async () => {
    const ct = mockCallTool();
    const deps = mockDeps();
    deps.complete.mock.mockImplementation(async () => "No insights found today.");

    inferMemories(ct, deps);
    await fireInitialTimeout();

    assert.strictEqual(ct.mock.callCount(), 1);
  });

  test("remembers each valid inference from complete response", async () => {
    const ct = mockCallTool();
    const deps = mockDeps();
    deps.complete.mock.mockImplementation(async () =>
      JSON.stringify([
        { title: "Likes coffee", content: "Prefers dark roast" },
        { title: "Early riser",  content: "Wakes before 6am" },
      ])
    );

    inferMemories(ct, deps);
    await fireInitialTimeout();

    // recall + 2 remembers = 3 calls
    assert.strictEqual(ct.mock.callCount(), 3);
    assert.strictEqual(ct.mock.calls[0].arguments[0], "recall");

    // First remember
    assert.strictEqual(ct.mock.calls[1].arguments[0], "remember");
    assert.deepStrictEqual(ct.mock.calls[1].arguments[1], {
      type: "inference",
      title: "Likes coffee",
      content: "Prefers dark roast",
      tags: ["derived"],
      importance: 2,
      confidence: 0.6,
      source: "derived",
    });

    // Second remember
    assert.strictEqual(ct.mock.calls[2].arguments[0], "remember");
    assert.strictEqual(ct.mock.calls[2].arguments[1].title, "Early riser");
  });

  test("skips inference items with missing title or content", async () => {
    const ct = mockCallTool();
    const deps = mockDeps();
    deps.complete.mock.mockImplementation(async () =>
      JSON.stringify([
        { title: "Valid", content: "This one works" },
        { title: "",      content: "Empty title" },
        { content: "Missing title key" },
        { title: "Missing content key" },
      ])
    );

    inferMemories(ct, deps);
    await fireInitialTimeout();

    // Only the valid inference → recall + 1 remember
    assert.strictEqual(ct.mock.callCount(), 2);
    assert.strictEqual(ct.mock.calls[1].arguments[1].title, "Valid");
  });

  // ─── Markdown-wrapped JSON ─────────────────────────────────────────────────

  test("extracts JSON from markdown-wrapped response", async () => {
    const ct = mockCallTool();
    const deps = mockDeps();
    deps.complete.mock.mockImplementation(async () =>
      "Here are the insights:\n\n```json\n[{\"title\": \"T1\", \"content\": \"C1\"}]\n```\n"
    );

    inferMemories(ct, deps);
    await fireInitialTimeout();

    assert.strictEqual(ct.mock.callCount(), 2);
    assert.strictEqual(ct.mock.calls[1].arguments[1].title, "T1");
  });

  test("extracts JSON from response with mixed content before and after", async () => {
    const ct = mockCallTool();
    const deps = mockDeps();
    deps.complete.mock.mockImplementation(async () =>
      "prefix\n```json\n[{\"title\": \"T2\", \"content\": \"C2\"}]\n```\nsuffix"
    );

    inferMemories(ct, deps);
    await fireInitialTimeout();

    assert.strictEqual(ct.mock.callCount(), 2);
    assert.strictEqual(ct.mock.calls[1].arguments[1].title, "T2");
  });

  // ─── Logging ────────────────────────────────────────────────────────────────

  test("logs info when inferences are stored", async () => {
    const deps = mockDeps();
    deps.complete.mock.mockImplementation(async () =>
      JSON.stringify([{ title: "T", content: "C" }])
    );

    inferMemories(mockCallTool(), deps);
    await fireInitialTimeout();

    assert.strictEqual(deps.logger.info.mock.callCount(), 1);
    const msg = deps.logger.info.mock.calls[0].arguments[0];
    assert.match(msg, /Inferred 1 new pattern/);
  });

  test("does not log info when zero inferences stored", async () => {
    const deps = mockDeps();
    deps.complete.mock.mockImplementation(async () => "[]");

    inferMemories(mockCallTool(), deps);
    await fireInitialTimeout();

    assert.strictEqual(deps.logger.info.mock.callCount(), 0);
  });

  // ─── Error handling ─────────────────────────────────────────────────────────

  test("logs debug when recall throws", async () => {
    const ct   = mock.fn(async () => { throw new Error("recall failed"); });
    const deps = mockDeps();

    inferMemories(ct, deps);
    await fireInitialTimeout();

    assert.strictEqual(deps.logger.debug.mock.callCount(), 1);
    const msg = deps.logger.debug.mock.calls[0].arguments[0];
    assert.match(msg, /\[infer\] skipped: recall failed/);
  });

  test("logs debug when complete throws", async () => {
    const deps = mockDeps();
    deps.complete.mock.mockImplementation(async () => { throw new Error("API down"); });

    inferMemories(mockCallTool(), deps);
    await fireInitialTimeout();

    assert.strictEqual(deps.logger.debug.mock.callCount(), 1);
    const msg = deps.logger.debug.mock.calls[0].arguments[0];
    assert.match(msg, /\[infer\] skipped: API down/);
  });

  test("logs debug when JSON parse fails", async () => {
    const deps = mockDeps();
    // Brackets present so regex matches, but content is invalid JSON
    deps.complete.mock.mockImplementation(async () => "[{]");

    inferMemories(mockCallTool(), deps);
    await fireInitialTimeout();

    assert.strictEqual(deps.logger.debug.mock.callCount(), 1);
    assert.match(deps.logger.debug.mock.calls[0].arguments[0], /\[infer\] skipped/);
  });

  // ─── Interval lifecycle ─────────────────────────────────────────────────────

  test("sets interval after the initial run completes", async () => {
    inferMemories(mockCallTool(), mockDeps());
    // Before timeout fires: no interval yet
    assert.strictEqual(capturedIntervalCb, null);

    await fireInitialTimeout();

    // After timeout fires: interval is set with 30 min delay
    assert.ok(capturedIntervalCb);
    assert.strictEqual(capturedIntervalDelay, 30 * 60 * 1000);
  });

  test("interval callback calls runInference again", async () => {
    const ct    = mockCallTool();
    const deps  = mockDeps();
    deps.complete.mock.mockImplementation(async () => "[]");

    inferMemories(ct, deps);
    await fireInitialTimeout();
    const priorCalls = ct.mock.callCount();

    // Simulate the interval firing
    capturedIntervalCb();
    await drain();

    assert.strictEqual(ct.mock.callCount(), priorCalls + 1);
  });

  test("interval callback also handles errors gracefully", async () => {
    const ct    = mock.fn(async () => { throw new Error("interval fail"); });
    const deps  = mockDeps();

    inferMemories(ct, deps);
    await fireInitialTimeout();
    const priorDebug = deps.logger.debug.mock.callCount();

    // Interval fires and the callTool throws
    capturedIntervalCb();
    await drain();

    assert.strictEqual(deps.logger.debug.mock.callCount(), priorDebug + 1);
  });

  test("limits memories to first 20 blocks", async () => {
    // Create 25 blocks
    const blocks = Array.from({ length: 25 }, (_, i) => `block-${i}`);
    const ct = mock.fn(async () => blocks.join("\n---\n"));
    const deps = mockDeps();
    deps.complete.mock.mockImplementation(async () => "[]");

    inferMemories(ct, deps);
    await fireInitialTimeout();

    // Verify complete got a prompt with only 20 blocks
    const promptContent = deps.complete.mock.calls[0].arguments[0][0].content;
    const promptBlockCount = promptContent.split("---").length;
    assert.strictEqual(promptBlockCount, 20);
  });
});
