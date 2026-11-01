// tests/unit/helpers/timeSlice.test.js
//
// The slicer is what keeps a synchronous better-sqlite3 write loop from owning
// the event loop (issue S2.1). Its contract has two halves that both matter:
// it must yield once a slice is over budget, and it must NOT yield otherwise —
// a slicer that deferred on every row would turn a 22 s repo pass into minutes.
//
// Clock and yield are both injected, so nothing here depends on wall time.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  createTimeSlicer,
  DEFAULT_SLICE_MS,
  DEFAULT_CHECK_EVERY,
} from "../../../lib/helpers/timeSlice.js";

// A controllable clock plus a counting yield.
function harness({ sliceMs = 10, checkEvery = 4 } = {}) {
  let t = 0;
  const yields = [];
  const slicer = createTimeSlicer({
    sliceMs,
    checkEvery,
    now: () => t,
    yieldFn: async () => { yields.push(t); },
  });
  return {
    slicer,
    yields,
    advance: (ms) => { t += ms; },
    get now() { return t; },
  };
}

describe("createTimeSlicer", () => {
  test("does not yield while the slice is within budget", async () => {
    const h = harness({ sliceMs: 10, checkEvery: 4 });
    for (let i = 0; i < 400; i++) {
      h.advance(0.001);
      await h.slicer.tick();
    }
    assert.equal(h.yields.length, 0);
    assert.equal(h.slicer.yields, 0);
  });

  test("yields once the slice runs over budget", async () => {
    const h = harness({ sliceMs: 10, checkEvery: 4 });
    // Four ticks reach the first clock read; by then 12 ms have passed.
    for (let i = 0; i < 4; i++) { h.advance(3); await h.slicer.tick(); }
    assert.equal(h.yields.length, 1);
  });

  test("only reads the clock every `checkEvery` ticks", async () => {
    let reads = 0;
    const slicer = createTimeSlicer({
      sliceMs: 10,
      checkEvery: 8,
      now: () => { reads++; return 0; },
      yieldFn: async () => {},
    });
    reads = 0; // discount the constructor's own read
    for (let i = 0; i < 24; i++) await slicer.tick();
    assert.equal(reads, 3, "24 ticks with checkEvery=8 is three clock reads");
  });

  test("a fresh slice starts after a yield, so one long slice is not punished twice", async () => {
    const h = harness({ sliceMs: 10, checkEvery: 1 });
    h.advance(50);
    await h.slicer.tick();
    assert.equal(h.yields.length, 1);
    // Immediately after, the budget is full again.
    h.advance(1);
    await h.slicer.tick();
    assert.equal(h.yields.length, 1);
    h.advance(20);
    await h.slicer.tick();
    assert.equal(h.yields.length, 2);
  });

  test("yieldNow always yields and resets both the clock and the tick counter", async () => {
    const h = harness({ sliceMs: 1000, checkEvery: 4 });
    await h.slicer.yieldNow();
    assert.equal(h.yields.length, 1, "yieldNow ignores the budget");
    // The tick counter was reset, so the next clock read is a full checkEvery away.
    h.advance(5000);
    await h.slicer.tick();
    await h.slicer.tick();
    await h.slicer.tick();
    assert.equal(h.yields.length, 1, "no clock read yet, so no yield yet");
    await h.slicer.tick();
    assert.equal(h.yields.length, 2);
  });

  test("the real slicer actually defers to the event loop", async () => {
    // Teeth: with the default yieldFn, pending I/O-style callbacks must get a
    // turn. A slicer that resolved synchronously would let the loop below run
    // to completion before the setImmediate callback ever fired.
    const slicer = createTimeSlicer({ sliceMs: 0, checkEvery: 1 });
    let interleaved = false;
    setImmediate(() => { interleaved = true; });
    await slicer.tick();
    assert.equal(interleaved, true);
  });

  test("defaults are sane", () => {
    assert.ok(DEFAULT_SLICE_MS > 0 && DEFAULT_SLICE_MS <= 16,
      "a slice longer than one frame would be visible to a user");
    assert.ok(DEFAULT_CHECK_EVERY >= 1);
  });
});
