// tests/lib/helpers/embedding-queue.test.js
//
// Tests for createEmbeddingQueue.
// The queue's flush() is driven by a setInterval timer (60s). We use
// t.mock.timers to control the interval and trigger flushes on demand.

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

import logger from "../../../lib/helpers/logger.js";

// ─── Logger mocks ─────────────────────────────────────────────────────────

let infoCalls = [];
let warnCalls = [];
let debugCalls = [];

function resetLogCalls() {
  infoCalls = [];
  warnCalls = [];
  debugCalls = [];
}

before(() => {
  mock.method(logger, "info",  (...args) => { infoCalls.push(args); });
  mock.method(logger, "warn",  (...args) => { warnCalls.push(args); });
  mock.method(logger, "debug", (...args) => { debugCalls.push(args); });
});

after(() => {
  mock.restoreAll();
});

// ─── Dynamic import ───────────────────────────────────────────────────────

let createEmbeddingQueue;

before(async () => {
  const mod = await import("../../../lib/helpers/embedding-queue.js");
  createEmbeddingQueue = mod.createEmbeddingQueue;
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeStore(setEmbeddingFn) {
  return {
    setEmbedding: setEmbeddingFn ?? (async () => {}),
  };
}

function successfulEmbedding() {
  return mock.fn(async () => [0.1, 0.2, 0.3]);
}

function failingEmbedding(msg = "model unavailable") {
  return mock.fn(async () => { throw new Error(msg); });
}

function nullEmbedding() {
  return mock.fn(async () => null);
}

async function flushAll(queue) {
  // Advance past the 60s interval to trigger flush
  // Use multiple ticks so microtasks drain between them
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setImmediate(r));
  }
}

// =============================================================================
// enqueue
// =============================================================================
describe("enqueue()", () => {
  afterEach(() => {
    resetLogCalls();
  });

  test("adds an item to the queue", (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const queue = createEmbeddingQueue({
      store: makeStore(),
      generateEmbedding: successfulEmbedding(),
    });

    queue.enqueue("id-1", "some text to embed");
    assert.equal(queue.size(), 1);

    queue.shutdown();
  });

  test("deduplicates by id", (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const queue = createEmbeddingQueue({
      store: makeStore(),
      generateEmbedding: successfulEmbedding(),
    });

    queue.enqueue("id-1", "first text");
    queue.enqueue("id-1", "second text");  // same id, different text — ignored
    assert.equal(queue.size(), 1);

    queue.shutdown();
  });

  test("allows different ids", (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const queue = createEmbeddingQueue({
      store: makeStore(),
      generateEmbedding: successfulEmbedding(),
    });

    queue.enqueue("id-a", "text A");
    queue.enqueue("id-b", "text B");
    assert.equal(queue.size(), 2);

    queue.shutdown();
  });
});

// =============================================================================
// flush — success path
// =============================================================================
describe("flush — success", () => {
  afterEach(() => {
    resetLogCalls();
  });

  test("calls generateEmbedding and setEmbedding for each item", async (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const genEmb = successfulEmbedding();
    const setEmb = mock.fn(async () => {});
    const queue = createEmbeddingQueue({
      store: makeStore(setEmb),
      generateEmbedding: genEmb,
    });

    queue.enqueue("id-1", "text one");
    queue.enqueue("id-2", "text two");

    // Advance past 60s to trigger flush
    t.mock.timers.tick(60_000);
    await flushAll(queue);

    assert.equal(genEmb.mock.calls.length, 2, "generateEmbedding called twice");
    assert.equal(setEmb.mock.calls.length, 2, "setEmbedding called twice");
    assert.equal(queue.size(), 0, "queue should be empty after successful flush");

    queue.shutdown();
  });

  test("calls generateEmbedding with the enqueued text", async (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const genEmb = successfulEmbedding();
    const queue = createEmbeddingQueue({
      store: makeStore(),
      generateEmbedding: genEmb,
    });

    queue.enqueue("id-x", "Hello world");

    t.mock.timers.tick(60_000);
    await flushAll(queue);

    assert.equal(genEmb.mock.calls[0].arguments[0], "Hello world");

    queue.shutdown();
  });

  test("calls setEmbedding with the id and embedding array", async (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const setEmb = mock.fn(async () => {});
    const queue = createEmbeddingQueue({
      store: makeStore(setEmb),
      generateEmbedding: successfulEmbedding(),
    });

    queue.enqueue("id-set", "embed me");

    t.mock.timers.tick(60_000);
    await flushAll(queue);

    assert.equal(setEmb.mock.calls[0].arguments[0], "id-set");
    assert.deepEqual(setEmb.mock.calls[0].arguments[1], [0.1, 0.2, 0.3]);

    queue.shutdown();
  });

  test("logs info on successful embedding", async (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const queue = createEmbeddingQueue({
      store: makeStore(),
      generateEmbedding: successfulEmbedding(),
    });

    queue.enqueue("id-log", "log me");

    t.mock.timers.tick(60_000);
    await flushAll(queue);

    assert.ok(infoCalls.some(args => args[0].includes("id=id-log embedded")));

    queue.shutdown();
  });

  test("skips items with future nextRetryAt", async (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const genEmb = successfulEmbedding();
    const queue = createEmbeddingQueue({
      store: makeStore(),
      generateEmbedding: genEmb,
    });

    queue.enqueue("id-skip", "skip me");

    // Advance only a little — not past 60s, so flush doesn't fire
    t.mock.timers.tick(100);
    await flushAll(queue);

    // No embedding should have been generated
    assert.equal(genEmb.mock.calls.length, 0);
    assert.equal(queue.size(), 1, "item should still be in queue");

    queue.shutdown();
  });
});

// =============================================================================
// flush — failure / retry
// =============================================================================
describe("flush — failure / retry", () => {
  afterEach(() => {
    resetLogCalls();
  });

  test("retries on failure with exponential backoff", async (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });

    // First call fails, second succeeds
    let callCount = 0;
    const genEmb = mock.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("Ollama busy");
      return [0.5, 0.6, 0.7];
    });
    const setEmb = mock.fn(async () => {});
    const queue = createEmbeddingQueue({
      store: makeStore(setEmb),
      generateEmbedding: genEmb,
    });

    queue.enqueue("id-retry", "retry me");

    // First flush — fails
    t.mock.timers.tick(60_000);
    await flushAll(queue);

    assert.equal(genEmb.mock.calls.length, 1, "first attempt should have been made");
    assert.equal(setEmb.mock.calls.length, 0, "no setEmbedding yet");
    assert.equal(queue.size(), 1, "item stays in queue after first failure");
    assert.ok(debugCalls.some(args => args[0].includes("attempt 1 failed")), "should log debug on failure");

    // Advance 30s (2^1 * 15s = 30s backoff) — item should still be blocked
    t.mock.timers.tick(30_000);
    await flushAll(queue);
    assert.equal(genEmb.mock.calls.length, 1, "should not retry before backoff expires");

    // Advance past the remaining backoff (30s more = 60s total from first tick)
    t.mock.timers.tick(35_000);
    await flushAll(queue);

    // Second attempt succeeds
    assert.equal(genEmb.mock.calls.length, 2, "second attempt should have been made");
    assert.equal(setEmb.mock.calls.length, 1, "setEmbedding called after success");
    assert.equal(queue.size(), 0, "item removed after successful retry");
    assert.ok(infoCalls.some(args => args[0].includes("id=id-retry embedded")), "should log success");

    queue.shutdown();
  });

  test("drops item after 3 failed attempts", async (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const genEmb = failingEmbedding("API error");
    const queue = createEmbeddingQueue({
      store: makeStore(),
      generateEmbedding: genEmb,
    });

    queue.enqueue("id-drop", "drop me");

    // Attempt 1 fails
    t.mock.timers.tick(60_000);
    await flushAll(queue);
    assert.equal(queue.size(), 1, "still queued after attempt 1");

    // Advance 30s. Attempt 2 fails.
    t.mock.timers.tick(60_000);
    await flushAll(queue);
    assert.equal(queue.size(), 1, "still queued after attempt 2");

    // Advance 60s. Attempt 3 fails — dropped.
    t.mock.timers.tick(60_000);
    await flushAll(queue);
    assert.equal(queue.size(), 0, "dropped after 3 failed attempts");

    // Warning should be logged
    assert.ok(warnCalls.some(args => args[0].includes("dropped after 3 failed attempts")),
      "should log warning on drop");

    queue.shutdown();
  });

  test("handles null embedding result as failure", async (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const genEmb = nullEmbedding();
    const setEmb = mock.fn(async () => {});
    const queue = createEmbeddingQueue({
      store: makeStore(setEmb),
      generateEmbedding: genEmb,
    });

    queue.enqueue("id-null", "null result");

    t.mock.timers.tick(60_000);
    await flushAll(queue);

    // Null is treated as error — item stays queued for retry
    assert.equal(setEmb.mock.calls.length, 0, "setEmbedding should not be called");
    assert.equal(queue.size(), 1, "should retry on null result");

    queue.shutdown();
  });

  test("continues processing other items when one fails", async (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const genEmb = mock.fn(async (text) => {
      if (text === "bad") throw new Error("fail");
      return [0.1, 0.2, 0.3];
    });
    const setEmb = mock.fn(async () => {});
    const queue = createEmbeddingQueue({
      store: makeStore(setEmb),
      generateEmbedding: genEmb,
    });

    queue.enqueue("good-id", "good");
    queue.enqueue("bad-id", "bad");

    t.mock.timers.tick(60_000);
    await flushAll(queue);

    // Good item succeeded, bad item failed (still in queue for retry)
    assert.equal(setEmb.mock.calls.length, 1, "good item should be embedded");
    assert.equal(setEmb.mock.calls[0].arguments[0], "good-id");
    assert.equal(queue.size(), 1, "bad item should remain for retry");

    queue.shutdown();
  });
});

// =============================================================================
// shutdown
// =============================================================================
describe("shutdown()", () => {
  afterEach(() => { resetLogCalls(); });

  test("stops the timer", (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const genEmb = successfulEmbedding();
    const queue = createEmbeddingQueue({
      store: makeStore(),
      generateEmbedding: genEmb,
    });

    queue.enqueue("id", "text");
    queue.shutdown();

    // Advance far past the interval — flush should not fire
    t.mock.timers.tick(600_000);
    assert.equal(genEmb.mock.calls.length, 0, "no embedding should have been generated");
  });
});

// =============================================================================
// size
// =============================================================================
describe("size()", () => {
  afterEach(() => { resetLogCalls(); });

  test("returns 0 for empty queue", (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const queue = createEmbeddingQueue({
      store: makeStore(),
      generateEmbedding: successfulEmbedding(),
    });
    assert.equal(queue.size(), 0);
    queue.shutdown();
  });

  test("reflects enqueued and dequeued items", async (t) => {
    // Mock both setInterval (for the flush timer) and Date (for retry backoff
    // timing — flush() uses Date.now() to check nextRetryAt).
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const queue = createEmbeddingQueue({
      store: makeStore(),
      generateEmbedding: successfulEmbedding(),
    });

    assert.equal(queue.size(), 0);
    queue.enqueue("a", "text a");
    assert.equal(queue.size(), 1);
    queue.enqueue("b", "text b");
    assert.equal(queue.size(), 2);

    // Flush and process
    t.mock.timers.tick(60_000);
    await flushAll(queue);
    assert.equal(queue.size(), 0);

    queue.shutdown();
  });
});
