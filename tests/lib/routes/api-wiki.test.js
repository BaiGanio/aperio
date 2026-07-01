// tests/lib/routes/api-wiki.test.js
// Tests for wiki list, search, and article endpoints.
//
// The wikiQueries module delegates to store.wiki (SQLite) or store.pool
// (Postgres) at runtime. We provide a mock store with store.wiki methods
// so the real wikiQueries functions route through our mocks without needing
// mock.module() for ESM imports.

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";

import logger from "../../../lib/helpers/logger.js";
import { mountWikiRoutes } from "../../../lib/routes/api-wiki.js";

// ─── Logger mocks ─────────────────────────────────────────────────────────────

before(() => {
  mock.method(logger, "error", () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "info",  () => {});
  mock.method(logger, "debug", () => {});
  // Avoid loading transformers in embeddings.js — voyage with no key returns null
  // safely without network calls.
  process.env.EMBEDDING_PROVIDER = "voyage";
  delete process.env.VOYAGE_API_KEY;
});

after(() => {
  mock.restoreAll();
  delete process.env.EMBEDDING_PROVIDER;
});

// ─── Mock store factory ───────────────────────────────────────────────────────

function makeMockStore(overrides = {}) {
  return {
    wiki: {
      list:   overrides.list   ?? (async () => []),
      search: overrides.search ?? (async () => []),
      get:    overrides.get    ?? (async () => null),
    },
    cache: overrides.cache ?? [],
  };
}

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

// =============================================================================
// GET /wiki/list
// =============================================================================

describe("GET /wiki/list", () => {
  test("returns articles list from store", async () => {
    const articles = [
      { slug: "hello", title: "Hello World", summary: "A test article" },
    ];
    const store = makeMockStore({ list: async () => articles });
    const router = Router();
    mountWikiRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/wiki/list");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.articles, articles);
  });

  test("passes query params as parsed integers for limit/offset", async () => {
    let captured;
    const store = makeMockStore({
      list: async (opts) => { captured = opts; return []; },
    });
    const router = Router();
    mountWikiRoutes(router, { store });

    await invoke(router, "GET", "/wiki/list", {
      query: { tag: "dev", status: "active", updated_since: "2026-01-01", limit: "5", offset: "10" },
    });

    assert.strictEqual(captured.tag, "dev");
    assert.strictEqual(captured.status, "active");
    assert.strictEqual(captured.updated_since, "2026-01-01");
    assert.strictEqual(captured.limit, 5);   // string → int
    assert.strictEqual(captured.offset, 10); // string → int
  });

  test("handles missing optional query params gracefully", async () => {
    let captured;
    const store = makeMockStore({
      list: async (opts) => { captured = opts; return []; },
    });
    const router = Router();
    mountWikiRoutes(router, { store });

    await invoke(router, "GET", "/wiki/list", { query: {} });

    // listArticles applies defaults: limit=25, offset=0
    assert.strictEqual(captured.limit, 25);
    assert.strictEqual(captured.offset, 0);
    assert.strictEqual(captured.tag, undefined);
    assert.strictEqual(captured.status, undefined);
    assert.strictEqual(captured.updated_since, undefined);
  });

  test("returns 500 when store throws", async () => {
    const store = makeMockStore({
      list: async () => { throw new Error("db unreachable"); },
    });
    const router = Router();
    mountWikiRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/wiki/list");
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("db unreachable"));
  });
});

// =============================================================================
// GET /wiki/search
// =============================================================================

describe("GET /wiki/search", () => {
  test("returns 400 when q is missing", async () => {
    const store = makeMockStore();
    const router = Router();
    mountWikiRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/wiki/search", { query: {} });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("q is required"));
  });

  test("returns 400 when q is empty string", async () => {
    const store = makeMockStore();
    const router = Router();
    mountWikiRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/wiki/search", { query: { q: "" } });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("q is required"));
  });

  test("searches with query and returns results", async () => {
    const articles = [
      { slug: "hello", title: "Hello World", score: 0.95 },
    ];
    const store = makeMockStore({ search: async () => articles });
    const router = Router();
    mountWikiRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/wiki/search", {
      query: { q: "hello", mode: "fulltext" },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.articles, articles);
  });

  test("passes tag, status, limit, mode through to searchArticles", async () => {
    let captured;
    const store = makeMockStore({
      search: async (opts) => { captured = opts; return []; },
    });
    const router = Router();
    mountWikiRoutes(router, { store });

    await invoke(router, "GET", "/wiki/search", {
      query: { q: "test", tag: "dev", status: "active", limit: "3", mode: "semantic" },
    });

    assert.strictEqual(captured.query, "test");
    assert.deepStrictEqual(captured.tags, ["dev"]);
    assert.strictEqual(captured.status, "active");
    assert.strictEqual(captured.limit, 3);
    assert.strictEqual(captured.mode, "semantic");
  });

  test("skips generateEmbedding when mode=fulltext", async () => {
    let captured;
    const store = makeMockStore({
      search: async (opts) => { captured = opts; return []; },
    });
    const router = Router();
    mountWikiRoutes(router, { store });

    await invoke(router, "GET", "/wiki/search", {
      query: { q: "test", mode: "fulltext" },
    });
    assert.strictEqual(captured.queryEmbedding, null);
  });

  test("applies defaults for limit and mode when omitted", async () => {
    let captured;
    const store = makeMockStore({
      search: async (opts) => { captured = opts; return []; },
    });
    const router = Router();
    mountWikiRoutes(router, { store });

    await invoke(router, "GET", "/wiki/search", { query: { q: "test" } });

    // searchArticles applies defaults: limit=10, mode='auto'
    assert.strictEqual(captured.query, "test");
    assert.strictEqual(captured.limit, 10);
    assert.strictEqual(captured.mode, "auto");
    assert.strictEqual(captured.tags, undefined);
    assert.strictEqual(captured.status, undefined);
  });

  test("returns 500 when store throws", async () => {
    const store = makeMockStore({
      search: async () => { throw new Error("search crashed"); },
    });
    const router = Router();
    mountWikiRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/wiki/search", {
      query: { q: "test", mode: "fulltext" },
    });
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("search crashed"));
  });
});

// =============================================================================
// GET /wiki/article/:slug
// =============================================================================

describe("GET /wiki/article/:slug", () => {
  const fakeArticle = {
    id: "art-1", slug: "my-article", title: "My Article",
    summary: "A test", body_md: "# Hello", tags: ["dev"],
    status: "active", revision: 3, generated_at: "2026-01-01T00:00:00.000Z",
    source_memory_ids: [],
  };

  test("returns article for existing slug", async () => {
    const store = makeMockStore({ get: async () => fakeArticle });
    const router = Router();
    mountWikiRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/wiki/article/my-article");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.slug, "my-article");
    assert.strictEqual(body.title, "My Article");
    assert.ok(Array.isArray(body.sources));
  });

  test("resolves source memories from store.cache", async () => {
    const article = {
      ...fakeArticle,
      source_memory_ids: ["mem-1", "mem-2"],
    };
    const cache = [
      { id: "mem-1", title: "Memory One", valid_until: null },
      // mem-2 missing from cache → falls back to id as title
    ];
    const store = makeMockStore({ get: async () => article, cache });
    const router = Router();
    mountWikiRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/wiki/article/my-article");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.sources.length, 2);
    assert.deepStrictEqual(body.sources[0], { id: "mem-1", title: "Memory One" });
    assert.deepStrictEqual(body.sources[1], { id: "mem-2", title: "mem-2" });
  });

  test("returns 404 for non-existent slug", async () => {
    const store = makeMockStore({ get: async () => null });
    const router = Router();
    mountWikiRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/wiki/article/nonexistent");
    assert.strictEqual(status, 404);
    assert.ok(body.error.includes("Article not found"));
  });

  test("returns 500 when store throws", async () => {
    const store = makeMockStore({
      get: async () => { throw new Error("db error"); },
    });
    const router = Router();
    mountWikiRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/wiki/article/my-article");
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("db error"));
  });
});
