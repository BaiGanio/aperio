// tests/unit/streaming/llamacppHandler-settings.test.js
//
// Both stream timeouts read user-editable settings into module-level constants
// that freeze at import time, so a bad value can only be exercised by importing
// the module with that value already in the environment — which is why this
// lives in its own file instead of in llamacppHandler.test.js (that suite
// imports the module at the real defaults for every other test).

import { describe, test, mock, before } from "node:test";
import assert from "node:assert/strict";

let LlamaCppStreamHandler;
before(async () => {
  // Must be set BEFORE the dynamic import: the constants are evaluated once,
  // at module load, and never re-read.
  process.env.LLAMACPP_STREAM_IDLE_TIMEOUT_MS = "abc";
  process.env.LLAMACPP_THINKING_TIMEOUT_MS = "not-a-number";
  ({ LlamaCppStreamHandler } = await import("../../../lib/streaming/llamacppHandler.js"));
});

const noopAdapter = () => ({
  thinks: false,
  createState: () => ({}),
  processDelta: (delta) => ({ contentToken: delta.content ?? null }),
  stripReasoning: (text) => text,
});

describe("timeout settings — invalid values fall back to the documented defaults", () => {
  test("a nonnumeric idle timeout still ends a stalled stream instead of spinning", async (t) => {
    // parseInt("abc") is NaN. An unnormalized NaN makes setTimeout fire
    // immediately AND poisons the remaining-idle arithmetic, so the read loop
    // spins on the same pending read forever: no stall reported, no cutoff,
    // one core pinned. This test hangs (and times out) if that regresses.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const cancel = mock.fn(async () => {});
    const response = {
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel }) },
    };
    const h = new LlamaCppStreamHandler(response, { send: mock.fn() }, noopAdapter(), mock.fn(), { name: "test-provider" });

    const resultPromise = h.process();
    t.mock.timers.tick(120_000); // the documented default, not the bad setting
    const result = await resultPromise;

    assert.match(h.streamError, /stalled — no data received for 120s/);
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(result.text, "");
  });

  test("a nonnumeric thinking timeout falls back to the 180s default", () => {
    const response = { body: { getReader: () => ({ read: () => new Promise(() => {}) }) } };
    const h = new LlamaCppStreamHandler(response, { send: mock.fn() }, noopAdapter(), mock.fn(), { name: "test-provider" });
    assert.equal(h.thinkingTimeoutMs, 180_000);
  });

  test("a caller-supplied budget that is not a usable number disables the guard rather than arming it", () => {
    // The cutoff cancels and discards a turn, so nonsense must fail safe.
    const response = { body: { getReader: () => ({ read: () => new Promise(() => {}) }) } };
    const build = (budget) => new LlamaCppStreamHandler(
      response, { send: mock.fn() }, noopAdapter(), mock.fn(), { name: "test-provider" }, false, budget);

    assert.equal(build(NaN).thinkingTimeoutMs, 0);
    assert.equal(build(-5).thinkingTimeoutMs, 0);
    assert.equal(build(0).thinkingTimeoutMs, 0, "0 stays 0 — the documented way to disable it");
    assert.equal(build(1000).thinkingTimeoutMs, 1000);
  });
});
