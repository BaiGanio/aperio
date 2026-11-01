// tests/integration/db/contract/issue-triage.test.js
// Shared contract: the issue-triage ledger, run identically against a real
// SqliteStore and (opt-in) a real PostgresStore. See backends.js for why.
// Every test uses its own uniquely-namespaced repo, so assertions never rely
// on the table being empty (safe against a real, persistent, opt-in Postgres).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { contractBackends, postgresSkipNotice, contractId } from "./backends.js";

postgresSkipNotice(test);

for (const backend of await contractBackends()) {
  describe(`issue triage store contract [${backend.name}]`, () => {
    let store;
    before(async () => { store = await backend.getStore(); });
    after(async () => { await backend.teardown(store); });

    test("upsertIssue makes an issue pending", async () => {
      const repo = contractId("repo");
      await store.upsertIssue({ repo, number: 1, title: "First", state: "open", updatedAt: "2026-06-01T00:00:00Z" });
      const pending = await store.listPendingIssues(repo);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].issue_number, 1);
      assert.equal(pending[0].triaged_at, null);
    });

    test("markTriaged removes it from the pending set", async () => {
      const repo = contractId("repo-triage");
      await store.upsertIssue({ repo, number: 1, title: "First", state: "open", updatedAt: "2026-06-01T00:00:00Z" });
      await store.markTriaged({ repo, number: 1, priority: 2, verdict: "minor", runId: 42 });
      assert.equal((await store.listPendingIssues(repo)).length, 0);
    });

    test("re-upsert with the SAME updated_at stays triaged", async () => {
      const repo = contractId("repo-stable");
      await store.upsertIssue({ repo, number: 1, title: "First", state: "open", updatedAt: "2026-06-01T00:00:00Z" });
      await store.markTriaged({ repo, number: 1, priority: 1, verdict: "minor", runId: 1 });
      await store.upsertIssue({ repo, number: 1, title: "First", state: "open", updatedAt: "2026-06-01T00:00:00Z" });
      assert.equal((await store.listPendingIssues(repo)).length, 0, "unchanged updated_at must not reset triage");
    });

    test("re-upsert with a NEWER updated_at resets to pending", async () => {
      const repo = contractId("repo-reset");
      await store.upsertIssue({ repo, number: 1, title: "First", state: "open", updatedAt: "2026-06-01T00:00:00Z" });
      await store.markTriaged({ repo, number: 1, priority: 1, verdict: "minor", runId: 1 });
      await store.upsertIssue({ repo, number: 1, title: "First (edited)", state: "open", updatedAt: "2026-06-05T00:00:00Z" });

      const pending = await store.listPendingIssues(repo);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].title, "First (edited)");
      assert.equal(pending[0].triaged_at, null);
    });

    test("listPendingIssues filters by repo and orders by updated_at", async () => {
      const repoA = contractId("repo-mine");
      const repoB = contractId("repo-elsewhere");
      await store.upsertIssue({ repo: repoA, number: 1, title: "Newer", state: "open", updatedAt: "2026-06-09T00:00:00Z" });
      await store.upsertIssue({ repo: repoA, number: 2, title: "Older", state: "open", updatedAt: "2026-05-01T00:00:00Z" });
      await store.upsertIssue({ repo: repoB, number: 9, title: "Elsewhere", state: "open", updatedAt: "2026-06-09T00:00:00Z" });

      const mine = await store.listPendingIssues(repoA);
      assert.deepEqual(mine.map((r) => r.issue_number), [2, 1], "ascending by updated_at");
      assert.ok(!mine.some((r) => r.title === "Elsewhere"), "scoped to the given repo");
    });

    test("listPendingIssues with no repo arg returns pending rows across repos", async () => {
      const repoA = contractId("repo-global-a");
      const repoB = contractId("repo-global-b");
      await store.upsertIssue({ repo: repoA, number: 1, title: "A", state: "open", updatedAt: "2026-06-01T00:00:00Z" });
      await store.upsertIssue({ repo: repoB, number: 1, title: "B", state: "open", updatedAt: "2026-06-01T00:00:00Z" });

      const all = await store.listPendingIssues();
      assert.ok(all.some((r) => r.repo === repoA && r.title === "A"));
      assert.ok(all.some((r) => r.repo === repoB && r.title === "B"));
    });
  });
}
