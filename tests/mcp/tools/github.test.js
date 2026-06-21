// tests/mcp/tools/github.test.js
// Tests the triage tools in mcp/tools/github.js: list_github_issues (repo
// resolution, PR filtering, ledger upsert, only_untriaged) and
// record_issue_triage. fetch is mocked; the store is a tiny in-memory fake
// mirroring the ledger's dedup contract.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { listGithubIssuesHandler, recordIssueTriageHandler } from "../../../mcp/tools/github.js";

function withMockFetch(mockFn, testFn) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  return testFn().finally(() => { globalThis.fetch = original; });
}

// Minimal store fake: a Map keyed by repo#number, mirroring upsert/markTriaged.
function fakeStore(settings = {}) {
  const rows = new Map();
  const key = (repo, n) => `${repo}#${n}`;
  return {
    settings,
    async getSetting(k) { return this.settings[k] ?? null; },
    async upsertIssue({ repo, number, title, state, updatedAt }) {
      const k = key(repo, number);
      const prev = rows.get(k);
      const triaged_at = prev && prev.updated_at === updatedAt ? prev.triaged_at : null;
      rows.set(k, { repo, issue_number: number, title, state, updated_at: updatedAt, triaged_at });
    },
    async listPendingIssues(repo) {
      return [...rows.values()]
        .filter(r => r.triaged_at == null && (!repo || r.repo === repo))
        .sort((a, b) => String(a.updated_at).localeCompare(b.updated_at));
    },
    async markTriaged({ repo, number, priority, verdict }) {
      const r = rows.get(key(repo, number));
      if (r) { r.triaged_at = "now"; r.priority = priority; r.verdict = verdict; }
    },
    _rows: rows,
  };
}

function issuesResponse(items) {
  return async () => ({
    ok: true, status: 200,
    json: async () => items,
    text: async () => "",
  });
}

const ISSUES = [
  { number: 1, title: "Bug A",     state: "open", updated_at: "2026-06-01T00:00:00Z" },
  { number: 2, title: "Feature B", state: "open", updated_at: "2026-06-02T00:00:00Z" },
  { number: 3, title: "A PR",      state: "open", updated_at: "2026-06-03T00:00:00Z", pull_request: { url: "x" } },
];

describe("list_github_issues", () => {
  test("no repo configured → friendly error, no fetch", async () => {
    let called = false;
    await withMockFetch(async () => { called = true; throw new Error("should not fetch"); }, async () => {
      const res = await listGithubIssuesHandler({}, { store: fakeStore() });
      assert.match(res.content[0].text, /No repo configured/);
      assert.equal(called, false);
    });
  });

  test("explicit repo: filters PRs, upserts ledger, lists issues", () =>
    withMockFetch(issuesResponse(ISSUES), async () => {
      const store = fakeStore();
      const res = await listGithubIssuesHandler({ repo: "octocat/hello" }, { store });
      const text = res.content[0].text;
      assert.match(text, /#1 · Bug A/);
      assert.match(text, /#2 · Feature B/);
      assert.doesNotMatch(text, /A PR/, "pull requests must be filtered out");
      assert.equal(store._rows.size, 2, "only the 2 real issues are in the ledger");
      assert.match(text, /untrusted/i);
    }));

  test("triage.repos setting is used when no repo/project given", () =>
    withMockFetch(issuesResponse(ISSUES), async () => {
      const store = fakeStore({ "triage.repos": ["octocat/hello"] });
      const res = await listGithubIssuesHandler({}, { store });
      assert.match(res.content[0].text, /octocat\/hello/);
    }));

  test("only_untriaged returns just the pending subset", () =>
    withMockFetch(issuesResponse(ISSUES), async () => {
      const store = fakeStore();
      // Pre-triage #1 by upserting then marking it.
      await store.upsertIssue({ repo: "octocat/hello", number: 1, title: "Bug A", state: "open", updatedAt: "2026-06-01T00:00:00Z" });
      await store.markTriaged({ repo: "octocat/hello", number: 1, priority: 1, verdict: "done" });

      const res = await listGithubIssuesHandler({ repo: "octocat/hello", only_untriaged: true }, { store });
      const text = res.content[0].text;
      assert.doesNotMatch(text, /#1 ·/, "already-triaged issue is excluded");
      assert.match(text, /#2 ·/, "pending issue is included");
    }));
});

describe("record_issue_triage", () => {
  test("marks the issue triaged in the ledger", async () => {
    const store = fakeStore();
    await store.upsertIssue({ repo: "octocat/hello", number: 5, title: "X", state: "open", updatedAt: "2026-06-01T00:00:00Z" });
    const res = await recordIssueTriageHandler({ repo: "octocat/hello", issue_number: 5, priority: 2, verdict: "minor" }, { store });
    assert.match(res.content[0].text, /Triaged octocat\/hello#5/);
    assert.equal((await store.listPendingIssues("octocat/hello")).length, 0);
  });

  test("rejects a bad repo", async () => {
    const res = await recordIssueTriageHandler({ repo: "noslash", issue_number: 1 }, { store: fakeStore() });
    assert.match(res.content[0].text, /repo.*required/);
  });
});
