import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createLlamaLogPruner } from "../../lib/workers/llamacpp-log-prune.js";

describe("llamacpp session-log pruning", () => {
  const originalRetention = process.env.LLAMACPP_LOG_RETENTION_DAYS;

  afterEach(() => {
    if (originalRetention === undefined) delete process.env.LLAMACPP_LOG_RETENTION_DAYS;
    else process.env.LLAMACPP_LOG_RETENTION_DAYS = originalRetention;
  });

  test("prunes with the configured retention on start", () => {
    process.env.LLAMACPP_LOG_RETENTION_DAYS = "7";
    const calls = [];
    const worker = createLlamaLogPruner(days => { calls.push(days); return 0; });
    worker.stop();
    assert.deepEqual(calls, [7]);
  });

  test("defaults to 1 day when unset", () => {
    delete process.env.LLAMACPP_LOG_RETENTION_DAYS;
    const calls = [];
    const worker = createLlamaLogPruner(days => { calls.push(days); return 0; });
    worker.stop();
    assert.deepEqual(calls, [1]);
  });

  test("clamps zero/negative/garbage retention to the 1-day floor", () => {
    for (const bad of ["0", "-5", "banana"]) {
      process.env.LLAMACPP_LOG_RETENTION_DAYS = bad;
      const calls = [];
      const worker = createLlamaLogPruner(days => { calls.push(days); return 0; });
      worker.stop();
      assert.deepEqual(calls, [1], `retention "${bad}" should clamp to 1`);
    }
  });

  test("a throwing prune does not take down the worker", () => {
    const worker = createLlamaLogPruner(() => { throw new Error("boom"); });
    worker.stop(); // reaching here means run() swallowed the error
  });
});
