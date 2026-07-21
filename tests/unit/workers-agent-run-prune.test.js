import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createAgentRunPruner } from "../../lib/workers/agent-run-prune.js";

describe("agent run artifact pruning", () => {
  const originalRetention = process.env.AGENT_RUN_RETENTION_DAYS;

  afterEach(() => {
    if (originalRetention === undefined) delete process.env.AGENT_RUN_RETENTION_DAYS;
    else process.env.AGENT_RUN_RETENTION_DAYS = originalRetention;
  });

  test("uses the run-history retention cutoff for run artifacts", async () => {
    process.env.AGENT_RUN_RETENTION_DAYS = "30";
    const cutoffs = [];
    const worker = createAgentRunPruner({
      store: { pruneAgentRuns: async days => assert.equal(days, 30) },
      artifactStore: {
        pruneOwners: input => {
          cutoffs.push(input);
          return 1;
        },
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    worker.stop();

    assert.equal(cutoffs.length, 1);
    assert.equal(cutoffs[0].scope, "run");
    assert.ok(Number.isFinite(cutoffs[0].olderThan));
  });

  test("retention zero preserves run history and artifacts", async () => {
    process.env.AGENT_RUN_RETENTION_DAYS = "0";
    let called = false;
    const worker = createAgentRunPruner({
      store: { pruneAgentRuns: async () => { called = true; } },
      artifactStore: { pruneOwners: () => { called = true; } },
    });
    await new Promise(resolve => setImmediate(resolve));
    worker.stop();
    assert.equal(called, false);
  });
});
