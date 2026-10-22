// tests/unit/helpers/metricsSampler.test.js
// The sampler owns its timer: it can be stopped, it never overlaps samples,
// and a stopped sampler stops touching the store.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createMetricsSampler } from "../../../lib/helpers/metricsSampler.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise the test can resolve by hand, used to park a sample mid-flight. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Keeps a sample off `/usr/bin/vm_stat` and `sysctl`: spawning those on a busy
// CI runner is what made the timing-based version of the overlap test flaky.
const stubExec = async () => ({ stdout: "" });

describe("createMetricsSampler", () => {
  test("starts with a zeroed cache and fills it after a sample", async () => {
    const sampler = createMetricsSampler({ store: { counts: async () => ({ total: 7, embedded: 3 }) } });
    assert.deepEqual(sampler.getMetrics(), { rss: 0, heap: 0, cpu: 0, embedding_queue_size: 0 });

    await sampler.sample();
    const metrics = sampler.getMetrics();
    assert.equal(typeof metrics.rss, "number");
    assert.equal(typeof metrics.heap, "number");
    assert.equal(metrics.memories_total, 7);
    assert.equal(typeof metrics.cores, "number");
    assert.equal(typeof metrics.platform, "string");
  });

  test("survives a store whose counts() rejects", async () => {
    const sampler = createMetricsSampler({ store: { counts: async () => { throw new Error("db down"); } } });
    await sampler.sample();
    assert.equal(sampler.getMetrics().memories_total, 0);
    assert.equal(typeof sampler.getMetrics().rss, "number");
  });

  test("never runs overlapping samples", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;

    // Each sample parks inside counts() until the test opens its gate, so an
    // overlap is observed by construction instead of by waiting long enough to
    // catch one. Nothing below depends on wall-clock timing.
    const entered = [deferred(), deferred(), deferred(), deferred()];
    const gate    = [deferred(), deferred(), deferred(), deferred()];
    let index = 0;

    const store = {
      async counts() {
        const n = index++;
        calls += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        entered[n]?.resolve();
        await gate[n]?.promise;
        concurrent -= 1;
        return { total: 0, embedded: 0 };
      },
    };

    const sampler = createMetricsSampler({ store, intervalMs: 0, execImpl: stubExec });
    try {
      sampler.start();
      await entered[0].promise;    // the scheduled sample is parked inside counts()

      // The real overlap risk is an external caller (a route handler) arriving
      // while the loop's own sample is still running: it must join the in-flight
      // sample, not start a second one. collect() reaches store.counts()
      // synchronously, so a second entry has already been counted by the time
      // sample() returns — no waiting needed to see it.
      const joined = sampler.sample();
      assert.equal(maxConcurrent, 1, "samples must not overlap");

      gate[0].resolve();
      await joined;
      assert.equal(calls, 1, "the mid-flight caller must not start a second sample");

      await entered[1].promise;    // the loop goes on sampling by itself
      gate[1].resolve();
    } finally {
      sampler.stop();
      for (const g of gate) g.resolve();
    }

    assert.equal(maxConcurrent, 1, "samples must not overlap");
    assert.ok(calls >= 2, `expected repeated sampling, got ${calls}`);
  });

  test("stop() halts sampling and start() is idempotent", async () => {
    let calls = 0;
    const store = { counts: async () => { calls += 1; return { total: 0, embedded: 0 }; } };
    const sampler = createMetricsSampler({ store, intervalMs: 1 });
    sampler.start();
    sampler.start();             // second start must not add a second loop
    await tick(30);
    sampler.stop();
    assert.equal(sampler.isRunning, false);

    const after = calls;
    await tick(30);
    assert.equal(calls, after, "no samples may run after stop()");
  });

  test("concurrent sample() callers share one in-flight sample", async () => {
    let calls = 0;
    const store = { async counts() { calls += 1; await tick(10); return { total: 1, embedded: 1 }; } };
    const sampler = createMetricsSampler({ store });
    await Promise.all([sampler.sample(), sampler.sample(), sampler.sample()]);
    assert.equal(calls, 1);
  });
});
