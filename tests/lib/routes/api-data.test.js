// tests/lib/routes/api-data.test.js
// Tests for data portability REST endpoints: export and import.
//
// All store methods (exportAll, importAll, listWithoutEmbeddings, setEmbedding)
// are injected via the { store } parameter, so no module-level mocking needed.

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";

import logger from "../../../lib/helpers/logger.js";
import { mountDataRoutes } from "../../../lib/routes/api-data.js";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

before(() => {
  mock.method(logger, "error", () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "info",  () => {});
  mock.method(logger, "debug", () => {});
});

after(() => mock.restoreAll());

// ─── Invoke helper ────────────────────────────────────────────────────────────

function invoke(router, method, url, { body = {}, query = {}, params = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url, body, query, params,
      path: url,
      headers: {}, baseUrl: "", originalUrl: url,
      ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
    };
    const res = {
      _status: 200, headersSent: false, _headers: {},
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
      getHeader(k)    { return this._headers[String(k).toLowerCase()]; },
      set()           { return this; },
      on()            { return this; },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

// ─── Mock store factory ──────────────────────────────────────────────────────

function makeStore(overrides = {}) {
  return {
    exportAll:  async () => ({ memories: [], wiki_articles: [], agent_jobs: [], agent_runs: [] }),
    importAll:  async () => ({ imported: { memories: 0, wiki_articles: 0 }, skipped: { memories: 0, wiki_articles: 0 } }),
    listWithoutEmbeddings: async () => [],
    setEmbedding: async () => {},
    ...overrides,
  };
}

// =============================================================================
// POST /data/export
// =============================================================================

describe("POST /data/export", () => {
  test("exports with default options (include all)", async () => {
    const data = {
      memories:       [{ id: "m1", title: "Mem" }],
      wiki_articles:  [{ id: "w1", title: "Wiki" }],
      agent_jobs:     [{ id: "j1" }],
      agent_runs:     [{ id: "r1" }],
    };
    const store = makeStore({ exportAll: async () => data });
    const router = Router();
    mountDataRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/data/export", { body: {} });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.aperio_export, 1);
    assert.ok(body.exported_at);
    assert.strictEqual(body.counts.memories, 1);
    assert.strictEqual(body.counts.wiki_articles, 1);
    assert.strictEqual(body.counts.agent_jobs, 1);
    assert.strictEqual(body.counts.agent_runs, 1);
    assert.strictEqual(body.memories.length, 1);
    assert.strictEqual(body.wiki_articles.length, 1);
    assert.strictEqual(body.agent_jobs.length, 1);
    assert.strictEqual(body.agent_runs.length, 1);
  });

  test("excludes wiki and agent jobs when requested", async () => {
    const data = {
      memories:       [{ id: "m1" }],
      wiki_articles:  [{ id: "w1" }],
      agent_jobs:     [{ id: "j1" }],
      agent_runs:     [{ id: "r1" }],
    };
    const store = makeStore({ exportAll: async () => data });
    const router = Router();
    mountDataRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/data/export", {
      body: { include_wiki: false, include_agent_jobs: false },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.counts.wiki_articles, 0);
    assert.strictEqual(body.counts.agent_jobs, 0);
    assert.strictEqual(body.counts.agent_runs, 0);
    assert.strictEqual(body.wiki_articles.length, 0);
    assert.strictEqual(body.agent_jobs.length, 0);
    assert.strictEqual(body.agent_runs.length, 0);
    // Memories are always included
    assert.strictEqual(body.memories.length, 1);
  });

  test("returns 500 when exportAll throws", async () => {
    const store = makeStore({ exportAll: async () => { throw new Error("export failed"); } });
    const router = Router();
    mountDataRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/data/export", { body: {} });
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("export failed"));
  });
});

// =============================================================================
// POST /data/import
// =============================================================================

describe("POST /data/import", () => {
  test("imports memories and wiki articles", async () => {
    let captured;
    const store = makeStore({
      importAll: async (data) => {
        captured = data;
        return { imported: { memories: 2, wiki_articles: 1 }, skipped: { memories: 0, wiki_articles: 0 } };
      },
    });
    const router = Router();
    mountDataRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/data/import", {
      body: {
        memories: [{ id: "m1", title: "Mem1" }, { id: "m2", title: "Mem2" }],
        wiki_articles: [{ id: "w1", title: "Wiki1" }],
      },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.imported.memories, 2);
    assert.strictEqual(body.imported.wiki_articles, 1);
    assert.ok(body.note);
    assert.deepStrictEqual(captured.memories.length, 2);
    assert.deepStrictEqual(captured.wiki_articles.length, 1);
  });

  test("returns 400 when memories array is missing", async () => {
    const store = makeStore();
    const router = Router();
    mountDataRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/data/import", {
      body: { wiki_articles: [] },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("memories array is required"));
  });

  test("returns 413 when memories exceed 1000", async () => {
    const store = makeStore();
    const router = Router();
    mountDataRoutes(router, { store });

    const many = Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}` }));
    const { status, body } = await invoke(router, "POST", "/data/import", {
      body: { memories: many },
    });
    assert.strictEqual(status, 413);
    assert.ok(body.error.includes("max 1000"));
  });

  test("accepts legacy flat array format", async () => {
    let captured;
    const store = makeStore({
      importAll: async (data) => {
        captured = data;
        return { imported: { memories: 1, wiki_articles: 0 }, skipped: { memories: 0, wiki_articles: 0 } };
      },
    });
    const router = Router();
    mountDataRoutes(router, { store });

    // Direct array body (old export format)
    const { status, body } = await invoke(router, "POST", "/data/import", {
      body: [{ id: "m1", title: "Legacy" }],
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(captured.memories.length, 1);
    assert.strictEqual(captured.memories[0].id, "m1");
    assert.deepStrictEqual(captured.wiki_articles, []);
  });

  test("import with 0 memories does not fire backfill (no note)", async () => {
    const store = makeStore({
      importAll: async () => ({ imported: { memories: 0, wiki_articles: 0 }, skipped: { memories: 0, wiki_articles: 0 } }),
    });
    const router = Router();
    mountDataRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/data/import", {
      body: { memories: [] },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.imported.memories, 0);
    assert.strictEqual(body.note, undefined);
  });

  test("returns 500 when importAll throws", async () => {
    const store = makeStore({
      importAll: async () => { throw new Error("import crashed"); },
    });
    const router = Router();
    mountDataRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/data/import", {
      body: { memories: [{ id: "m1" }] },
    });
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("import crashed"));
  });
});
