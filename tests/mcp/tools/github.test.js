// tests/mcp/tools/github.test.js
// Tests for MCP GitHub tools: fetch, create, update, list, triage.
// fetch is mocked; the store is a tiny in-memory fake mirroring the ledger's
// dedup contract. create/update use confirm-before-write — tests cover both
// the proposal (phase 1) and the execution (phase 2) paths.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  fetchGithubIssueHandler,
  createGithubIssueHandler,
  updateGithubIssueHandler,
  listGithubIssuesHandler,
  recordIssueTriageHandler,
  register,
} from "../../../mcp/tools/github.js";

// ─── Generic mock fetch helper ────────────────────────────────────────────────

function withMockFetch(mockFn, testFn) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  return testFn().finally(() => { globalThis.fetch = original; });
}

// Map URL substrings to response values (objects or factories taking (url, opts)).
function mockRoutes(routes) {
  return async (url, options = {}) => {
    const urlStr = typeof url === "string" ? url : String(url);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (urlStr.includes(pattern)) {
        return typeof handler === "function"
          ? handler(urlStr, options)
          : handler;
      }
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  };
}

// ─── Store helper ─────────────────────────────────────────────────────────────

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

// ─── Factories ────────────────────────────────────────────────────────────────

function makeIssue(overrides = {}) {
  return {
    number: 1, title: "Test Bug", state: "open",
    body: "This is a test issue body.",
    html_url: "https://github.com/owner/repo/issues/1",
    user: { login: "testuser" },
    created_at: "2026-01-01T00:00:00Z",
    labels: [{ name: "bug" }, { name: "enhancement" }],
    assignees: [{ login: "assignee1" }],
    ...overrides,
  };
}

function makeComment(overrides = {}) {
  return {
    id: 1, body: "A test comment.",
    user: { login: "commenter" },
    created_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => "",
    headers: { get: () => "application/json" },
    arrayBuffer: async () => Buffer.alloc(0),
  };
}

const ISSUES = [
  { number: 1, title: "Bug A",     state: "open", updated_at: "2026-06-01T00:00:00Z" },
  { number: 2, title: "Feature B", state: "open", updated_at: "2026-06-02T00:00:00Z" },
  { number: 3, title: "A PR",      state: "open", updated_at: "2026-06-03T00:00:00Z", pull_request: { url: "x" } },
];

function issuesResponse(items) {
  return async () => jsonResponse(items);
}

/** Extract the confirm-before-write Token from a response text. */
function extractToken(text) {
  const m = text.match(/Token:\s*(\S+)/);
  return m ? m[1] : null;
}

// =============================================================================
// fetch_github_issue
// =============================================================================

describe("fetch_github_issue", () => {
  test("invalid URL returns error", async () => {
    const res = await fetchGithubIssueHandler(
      { url: "https://example.com/something" },
      { store: fakeStore() },
    );
    assert.match(res.content[0].text, /Invalid GitHub issue URL/);
  });

  test("fetches issue without comments", () =>
    withMockFetch(mockRoutes({
      "api.github.com/repos/owner/repo/issues/1": jsonResponse(makeIssue()),
    }), async () => {
      const res = await fetchGithubIssueHandler(
        { url: "https://github.com/owner/repo/issues/1", include_comments: false },
        { store: fakeStore() },
      );
      const text = res.content[0].text;
      assert.match(text, /# Test Bug/);
      assert.match(text, /\*\*State:\*\* open/);
      assert.match(text, /#1/);
      assert.match(text, /testuser/);
      assert.match(text, /This is a test issue body/);
      assert.match(text, /bug, enhancement/);
      assert.match(text, /assignee1/);
      assert.doesNotMatch(text, /## Comments/);
    }));

  test("fetches issue with comments", () =>
    withMockFetch(mockRoutes({
      // Specific patterns first — comments URL contains /issues/1, so it must
      // be checked before the shorter /issues/1 pattern.
      "api.github.com/repos/owner/repo/issues/1/comments": jsonResponse([makeComment()]),
      "api.github.com/repos/owner/repo/issues/1": jsonResponse(makeIssue()),
    }), async () => {
      const res = await fetchGithubIssueHandler(
        { url: "https://github.com/owner/repo/issues/1", include_comments: true },
        { store: fakeStore() },
      );
      const text = res.content[0].text;
      assert.match(text, /## Comments/);
      assert.match(text, /commenter/);
      assert.match(text, /A test comment/);
    }));

  test("fetches images when include_images=true", () =>
    withMockFetch(mockRoutes({
      // Specific patterns first to avoid substring overlap with /issues/1.
      "api.github.com/repos/owner/repo/issues/1/comments": jsonResponse([makeComment()]),
      "api.github.com/repos/owner/repo/issues/1": jsonResponse(makeIssue({
        body: "Here is an image: ![screenshot](https://cdn.example.com/img.png)",
      })),
      "cdn.example.com/img.png": {
        ok: true, status: 200,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => Buffer.from("fake-image-bytes"),
        text: async () => "",
        json: async () => ({}),
      },
    }), async () => {
      process.env.APERIO_ALLOW_INTERNAL_FETCH = "1"; // bypass SSRF guard
      try {
        const res = await fetchGithubIssueHandler(
          { url: "https://github.com/owner/repo/issues/1", include_images: true },
          { store: fakeStore() },
        );
        assert.strictEqual(res.content.length, 2);
        assert.strictEqual(res.content[0].type, "text");
        assert.strictEqual(res.content[1].type, "image");
        assert.strictEqual(res.content[1].mimeType, "image/png");
      } finally {
        delete process.env.APERIO_ALLOW_INTERNAL_FETCH;
      }
    }));

  test("returns error on non-200 API response", () =>
    withMockFetch(mockRoutes({
      "api.github.com/repos/owner/repo/issues/1": {
        ok: false, status: 404,
        text: async () => "Not Found",
        json: async () => ({}),
        headers: { get: () => "application/json" },
      },
    }), async () => {
      const res = await fetchGithubIssueHandler(
        { url: "https://github.com/owner/repo/issues/1" },
        { store: fakeStore() },
      );
      assert.match(res.content[0].text, /GitHub API error 404/);
    }));

  test("returns error when fetch throws", () =>
    withMockFetch(async () => { throw new Error("connect ECONNREFUSED"); }, async () => {
      const res = await fetchGithubIssueHandler(
        { url: "https://github.com/owner/repo/issues/1" },
        { store: fakeStore() },
      );
      assert.match(res.content[0].text, /Fetch failed/);
    }));
});

// =============================================================================
// create_github_issue  (confirm-before-write)
// =============================================================================

describe("create_github_issue", () => {
  test("missing title returns error", async () => {
    const res = await createGithubIssueHandler(
      { repo: "owner/repo" },
      { store: fakeStore({ "github.token": "test-token" }) },
    );
    assert.match(res.content[0].text, /title.*required/);
  });

  test("no repo or project returns error", async () => {
    const res = await createGithubIssueHandler(
      { title: "Issue" },
      { store: fakeStore({ "github.token": "test-token" }) },
    );
    assert.match(res.content[0].text, /Provide either.*project.*repo/);
  });

  test("no token configured returns error", async () => {
    const res = await createGithubIssueHandler(
      { repo: "owner/repo", title: "Issue" },
      { store: fakeStore() }, // no github.token setting
    );
    assert.match(res.content[0].text, /No GitHub token configured/);
  });

  test("recognizes an environment token loaded after the tool module", async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "late-loaded-test-token";
    try {
      const res = await createGithubIssueHandler(
        { repo: "owner/repo", title: "Issue" },
        { store: fakeStore() },
      );
      assert.ok(extractToken(res.content[0].text), "late-loaded env token should allow a proposal");
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  test("phase 1: proposes and returns a confirmation token", async () => {
    const res = await createGithubIssueHandler(
      { repo: "owner/repo", title: "My Issue", body: "Body text", labels: ["bug"], assignees: ["user1"] },
      { store: fakeStore({ "github.token": "test-token" }) },
    );
    const text = res.content[0].text;
    assert.match(text, /owner\/repo/);
    assert.match(text, /My Issue/);
    assert.match(text, /Body text/);
    assert.match(text, /bug/);
    assert.match(text, /user1/);
    assert.ok(extractToken(text), "a Token: line must be present");
  });

  test("phase 2: confirm creates the issue via POST", () =>
    withMockFetch(mockRoutes({
      "api.github.com/repos/owner/repo/issues": (url, opts) => {
        assert.strictEqual(opts.method, "POST");
        const body = JSON.parse(opts.body);
        assert.strictEqual(body.title, "My Issue");
        assert.strictEqual(body.body, "Body text");
        return jsonResponse({ number: 42, html_url: "https://github.com/owner/repo/issues/42" }, 201);
      },
    }), async () => {
      const store = fakeStore({ "github.token": "test-token" });
      // Phase 1: propose
      const propose = await createGithubIssueHandler(
        { repo: "owner/repo", title: "My Issue", body: "Body text" },
        { store },
      );
      const token = extractToken(propose.content[0].text);
      assert.ok(token, "must have a token");

      // Phase 2: confirm
      const confirm = await createGithubIssueHandler(
        { repo: "owner/repo", title: "My Issue", body: "Body text", confirmation_token: token },
        { store },
      );
      assert.match(confirm.content[0].text, /Created issue #42/);
      assert.match(confirm.content[0].text, /issues\/42/);
    }));
});

// =============================================================================
// update_github_issue  (confirm-before-write)
// =============================================================================

describe("update_github_issue", () => {
  test("missing issue number returns error", async () => {
    const res = await updateGithubIssueHandler(
      { repo: "owner/repo" },
      { store: fakeStore({ "github.token": "test-token" }) },
    );
    assert.match(res.content[0].text, /issue.*required/);
  });

  test("invalid state returns error", async () => {
    const res = await updateGithubIssueHandler(
      { repo: "owner/repo", issue: 1, state: "invalid" },
      { store: fakeStore({ "github.token": "test-token" }) },
    );
    assert.match(res.content[0].text, /state.*'open'.*'closed'/);
  });

  test("no changes returns error", async () => {
    const res = await updateGithubIssueHandler(
      { repo: "owner/repo", issue: 1 },
      { store: fakeStore({ "github.token": "test-token" }) },
    );
    assert.match(res.content[0].text, /Nothing to do/);
  });

  test("phase 1: proposes update with state change", async () => {
    const res = await updateGithubIssueHandler(
      { repo: "owner/repo", issue: 5, state: "closed" },
      { store: fakeStore({ "github.token": "test-token" }) },
    );
    const text = res.content[0].text;
    assert.match(text, /owner\/repo/);
    assert.match(text, /#5/);
    assert.match(text, /closed/);
    assert.ok(extractToken(text), "a Token: line must be present");
  });

  test("phase 2: confirm PATCHes the issue", () =>
    withMockFetch(mockRoutes({
      "api.github.com/repos/owner/repo/issues/5": (url, opts) => {
        assert.strictEqual(opts.method, "PATCH");
        const body = JSON.parse(opts.body);
        assert.strictEqual(body.state, "closed");
        return jsonResponse({ number: 5 });
      },
    }), async () => {
      const store = fakeStore({ "github.token": "test-token" });
      const propose = await updateGithubIssueHandler(
        { repo: "owner/repo", issue: 5, state: "closed" },
        { store },
      );
      const token = extractToken(propose.content[0].text);
      assert.ok(token);

      const confirm = await updateGithubIssueHandler(
        { repo: "owner/repo", issue: 5, state: "closed", confirmation_token: token },
        { store },
      );
      assert.match(confirm.content[0].text, /Updated issue #5/);
      assert.match(confirm.content[0].text, /state/);
    }));

  test("phase 2: confirm with comment adds POST comment", () =>
    withMockFetch(mockRoutes({
      // /issues/5/comments must be checked first — /issues/5 is a prefix.
      "api.github.com/repos/owner/repo/issues/5/comments": (url, opts) => {
        assert.strictEqual(opts.method, "POST");
        const body = JSON.parse(opts.body);
        assert.strictEqual(body.body, "A follow-up note.");
        return jsonResponse({ id: 99 }, 201);
      },
      "api.github.com/repos/owner/repo/issues/5": (url, opts) => {
        assert.strictEqual(opts.method, "PATCH");
        return jsonResponse({ number: 5 });
      },
    }), async () => {
      const store = fakeStore({ "github.token": "test-token" });
      const propose = await updateGithubIssueHandler(
        { repo: "owner/repo", issue: 5, state: "closed", comment: "A follow-up note." },
        { store },
      );
      const token = extractToken(propose.content[0].text);
      assert.ok(token);

      const confirm = await updateGithubIssueHandler(
        { repo: "owner/repo", issue: 5, state: "closed", comment: "A follow-up note.", confirmation_token: token },
        { store },
      );
      assert.match(confirm.content[0].text, /Updated issue #5/);
      assert.match(confirm.content[0].text, /state/);
      assert.match(confirm.content[0].text, /comment/);
    }));
});

// =============================================================================
// list_github_issues
// =============================================================================

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

// =============================================================================
// record_issue_triage
// =============================================================================

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

// =============================================================================
// Tool registration — discoverability contract (#237 Symptom B)
// =============================================================================

// Small models map "write a comment on the issue" onto a tool by lexical
// overlap with its description. update_github_issue must therefore LEAD with
// the commenting use-case, not bury `comment` behind close/edit/label verbs.
describe("update_github_issue registration", () => {
  function collectRegistrations() {
    const tools = new Map();
    const fakeServer = { registerTool: (name, config) => tools.set(name, config) };
    register(fakeServer, {});
    return tools;
  }

  test("description leads with the commenting use-case", () => {
    const { description } = collectRegistrations().get("update_github_issue");
    const firstSentence = description.split(/\.\s/)[0];
    assert.match(firstSentence, /\bcomment\b/i);
    assert.ok(
      description.toLowerCase().indexOf("comment") < description.toLowerCase().indexOf("close"),
      "commenting must be mentioned before close/reopen",
    );
  });

  test("comment param description says what text to pass", () => {
    const { inputSchema } = collectRegistrations().get("update_github_issue");
    const desc = inputSchema.shape.comment.description;
    assert.match(desc, /comment text to post/i);
  });
});
