// tests/integration/db/contract/agent-jobs.test.js
// Shared contract: agent job definitions + run history, run identically
// against a real SqliteStore and (opt-in) a real PostgresStore. See
// backends.js for why.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { contractBackends, postgresSkipNotice, contractId } from "./backends.js";

postgresSkipNotice(test);

for (const backend of await contractBackends()) {
  describe(`agent jobs store contract [${backend.name}]`, () => {
    let store;
    before(async () => { store = await backend.getStore(); });
    after(async () => { await backend.teardown(store); });

    test("upsertAgentJob -> getAgentJob roundtrips a freeform job", async () => {
      const id = contractId("job");
      const saved = await store.upsertAgentJob({
        id, enabled: false,
        trigger: { kind: "interval", everyMs: 3600000 },
        prompt: "Summarise recent memories.",
      });
      assert.equal(saved.id, id);
      assert.equal(saved.enabled, false);
      assert.equal(saved.prompt, "Summarise recent memories.");

      const fetched = await store.getAgentJob(id);
      assert.equal(fetched.prompt, "Summarise recent memories.");

      await store.deleteAgentJob(id);
    });

    test("upsertAgentJob overwrites an existing job by id", async () => {
      const id = contractId("job-overwrite");
      await store.upsertAgentJob({ id, enabled: true, prompt: "v1" });
      const updated = await store.upsertAgentJob({ id, enabled: true, prompt: "v2" });
      assert.equal(updated.prompt, "v2");
      await store.deleteAgentJob(id);
    });

    test("listAgentJobs includes a newly upserted job", async () => {
      const id = contractId("job-list");
      await store.upsertAgentJob({ id, enabled: true, prompt: "x" });
      const jobs = await store.listAgentJobs();
      assert.ok(jobs.some((j) => j.id === id));
      await store.deleteAgentJob(id);
    });

    test("getAgentJob returns null for a missing id", async () => {
      assert.equal(await store.getAgentJob(contractId("missing")), null);
    });

    test("deleteAgentJob reports whether a job existed", async () => {
      const id = contractId("job-delete");
      await store.upsertAgentJob({ id, enabled: true, prompt: "x" });
      assert.equal(await store.deleteAgentJob(id), true);
      assert.equal(await store.deleteAgentJob(id), false);
      assert.equal(await store.getAgentJob(id), null);
    });

    test("recordAgentRun -> listAgentRuns orders newest first and respects limit", async () => {
      const jobId = contractId("job-runs");
      const earlier = new Date(Date.now() - 2 * 86400000).toISOString();
      const later = new Date(Date.now() - 1 * 86400000).toISOString();
      await store.recordAgentRun({
        jobId, startedAt: earlier, verdict: "ok", mode: "steps", trigger: "manual",
        tools: ["recall"], answer: "done",
      });
      await store.recordAgentRun({
        jobId, startedAt: later, verdict: "error", mode: "steps", trigger: "interval", error: "boom",
      });

      const runs = await store.listAgentRuns(jobId);
      assert.equal(runs.length, 2);
      assert.equal(runs[0].verdict, "error", "newest first");
      assert.equal(runs[1].verdict, "ok");
      assert.deepEqual(runs[1].tools, ["recall"], "JSON round-trips to an array");

      const limited = await store.listAgentRuns(jobId, 1);
      assert.equal(limited.length, 1);

      for (const run of runs) await store.deleteAgentRun(run.id);
    });

    test("listAgentRuns returns [] for a job with no runs", async () => {
      assert.deepEqual(await store.listAgentRuns(contractId("no-runs")), []);
    });

    test("deleteAgentRun reports hit/miss", async () => {
      const jobId = contractId("job-run-delete");
      await store.recordAgentRun({ jobId, startedAt: new Date().toISOString(), verdict: "ok", mode: "steps" });
      const [run] = await store.listAgentRuns(jobId);
      assert.equal(await store.deleteAgentRun(run.id), true);
      assert.equal(await store.deleteAgentRun(run.id), false);
    });

    test("pruneAgentRuns removes runs older than the retention window", async () => {
      const jobId = contractId("job-prune");
      const old = new Date(Date.now() - 40 * 86400000).toISOString();
      const recent = new Date(Date.now() - 2 * 86400000).toISOString();
      await store.recordAgentRun({ jobId, startedAt: old, verdict: "ok", mode: "steps" });
      await store.recordAgentRun({ jobId, startedAt: recent, verdict: "ok", mode: "steps" });

      const before = await store.listAgentRuns(jobId);
      assert.equal(before.length, 2);

      await store.pruneAgentRuns(30);
      const after = await store.listAgentRuns(jobId);
      assert.equal(after.length, 1);
      assert.equal(after[0].started_at, recent);

      await store.deleteAgentRun(after[0].id);
    });
  });
}
