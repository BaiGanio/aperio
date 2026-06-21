// tests/db/issue-triage.test.js
// Tests the issue-triage ledger store methods on SqliteStore (in-memory DB).
// Covers the dedup contract: a fresh issue is pending; re-upserting with a
// newer updated_at makes it pending again; markTriaged clears it.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

let oldPath, oldDims, store;

before(async () => {
  oldPath = process.env.SQLITE_PATH;
  oldDims = process.env.EMBEDDING_DIMS;
  process.env.SQLITE_PATH = ":memory:";
  process.env.EMBEDDING_DIMS = "4";
  const { SqliteStore } = await import("../../db/sqlite.js");
  store = await SqliteStore.init();
});

after(() => {
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  if (oldDims) process.env.EMBEDDING_DIMS = oldDims; else delete process.env.EMBEDDING_DIMS;
});

const REPO = "octocat/hello";

describe("issue-triage ledger", () => {
  test("upsert makes an issue pending", async () => {
    await store.upsertIssue({ repo: REPO, number: 1, title: "First", state: "open", updatedAt: "2026-06-01T00:00:00Z" });
    const pending = await store.listPendingIssues(REPO);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].issue_number, 1);
    assert.equal(pending[0].triaged_at, null);
  });

  test("markTriaged removes it from the pending set", async () => {
    await store.markTriaged({ repo: REPO, number: 1, priority: 2, verdict: "minor", runId: 42 });
    const pending = await store.listPendingIssues(REPO);
    assert.equal(pending.length, 0);
  });

  test("re-upsert with the SAME updated_at stays triaged", async () => {
    await store.upsertIssue({ repo: REPO, number: 1, title: "First", state: "open", updatedAt: "2026-06-01T00:00:00Z" });
    const pending = await store.listPendingIssues(REPO);
    assert.equal(pending.length, 0, "unchanged updated_at must not reset triage");
  });

  test("re-upsert with a NEWER updated_at resets to pending", async () => {
    await store.upsertIssue({ repo: REPO, number: 1, title: "First (edited)", state: "open", updatedAt: "2026-06-05T00:00:00Z" });
    const pending = await store.listPendingIssues(REPO);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].title, "First (edited)");
    assert.equal(pending[0].triaged_at, null);
  });

  test("listPendingIssues filters by repo and orders by updated_at", async () => {
    await store.upsertIssue({ repo: REPO, number: 2, title: "Older", state: "open", updatedAt: "2026-05-01T00:00:00Z" });
    await store.upsertIssue({ repo: "other/repo", number: 9, title: "Elsewhere", state: "open", updatedAt: "2026-06-09T00:00:00Z" });

    const mine = await store.listPendingIssues(REPO);
    assert.deepEqual(mine.map(r => r.issue_number), [2, 1], "ascending by updated_at");

    const all = await store.listPendingIssues();
    assert.equal(all.length, 3, "no-repo arg returns every pending row");
  });
});
