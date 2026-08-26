// tests/unit/helpers/datasetRuns.test.js
// Dataset runs are bounded: finished runs drop their result rows, expire, and
// the registry never grows past its cap.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createDatasetRunRegistry } from "../../../lib/helpers/datasetRuns.js";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("createDatasetRunRegistry", () => {
  test("keeps an active run queryable with its config", () => {
    const runs = createDatasetRunRegistry();
    const state = runs.create("a", { dataset: "d", split: "s" });
    assert.equal(runs.get("a"), state);
    assert.equal(state.status, "queued");
    assert.deepEqual(state.config, { dataset: "d", split: "s" });
  });

  test("finish() keeps the summary but drops the result rows", () => {
    const runs = createDatasetRunRegistry();
    const state = runs.create("a", { dataset: "d", split: "s" });
    const results = Array.from({ length: 1000 }, (_, i) => ({ i, text: "x".repeat(64) }));

    runs.finish(state, { status: "complete", summary: { recallAt1: 0.5 }, results });

    assert.equal(state.status, "complete");
    assert.deepEqual(state.summary, { recallAt1: 0.5 });
    assert.equal(state.results, undefined, "result rows must not stay in memory");
    assert.ok(state.finishedAt, "terminal runs record a finish time");
    // The same object the route already handed out is the one that was trimmed.
    assert.equal(runs.get("a"), state);
  });

  test("finish() preserves the failure reason", () => {
    const runs = createDatasetRunRegistry();
    const state = runs.create("a", {});
    runs.finish(state, { status: "failed", error: "boom" });
    assert.equal(state.status, "failed");
    assert.equal(state.error, "boom");
  });

  test("internal timing never leaks into the run record", () => {
    const runs = createDatasetRunRegistry();
    const state = runs.create("a", {});
    runs.finish(state, { status: "complete" });
    for (const key of Object.keys(state)) assert.doesNotMatch(key, /AtMs$/);
  });

  test("finished runs are evicted once their TTL elapses", () => {
    const c = clock();
    const runs = createDatasetRunRegistry({ terminalTtlMs: 1000, now: c.now });
    const state = runs.create("a", {});
    runs.finish(state, { status: "complete" });

    c.advance(999);
    assert.ok(runs.get("a"), "still queryable inside the grace period");
    c.advance(2);
    assert.equal(runs.get("a"), undefined, "evicted after the TTL");
    assert.equal(runs.size, 0);
  });

  test("an active run is not evicted by the terminal TTL", () => {
    const c = clock();
    const runs = createDatasetRunRegistry({ terminalTtlMs: 10, staleTtlMs: 1_000_000, now: c.now });
    runs.create("a", {});
    c.advance(5000);
    assert.ok(runs.get("a"), "running work stays addressable and cancellable");
  });

  test("a run that never reaches a terminal state expires on the stale TTL", () => {
    const c = clock();
    const runs = createDatasetRunRegistry({ staleTtlMs: 1000, now: c.now });
    const state = runs.create("a", {});
    state.status = "running";
    c.advance(1001);
    assert.equal(runs.get("a"), undefined);
  });

  test("the registry is capped, shedding finished runs before active ones", () => {
    const runs = createDatasetRunRegistry({ maxEntries: 3, terminalTtlMs: 10 ** 9 });
    const finished = runs.create("done", {});
    runs.finish(finished, { status: "complete" });
    runs.create("live-1", {});
    runs.create("live-2", {});
    runs.create("live-3", {});     // create() prunes first — pushes past the cap

    assert.ok(runs.size <= 3, `expected the cap to hold, got ${runs.size}`);
    assert.equal(runs.get("done"), undefined, "the finished run is shed first");
    assert.ok(runs.get("live-3"));
  });

  test("the cap also bounds a flood of active runs", () => {
    const runs = createDatasetRunRegistry({ maxEntries: 5 });
    for (let i = 0; i < 200; i++) runs.create(`run-${i}`, {});
    assert.ok(runs.size <= 5, `expected ≤5 entries, got ${runs.size}`);
    assert.ok(runs.get("run-199"), "the newest run survives");
  });
});
