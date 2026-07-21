// tests/lib/handlers/wiki/wikiQueries.test.js
//
// Tests for searchArticles, listArticles, getArticle.
// Provides mock stores that exercise both the store.wiki delegation path
// and the Postgres (store.pool) SQL path.

import { describe, test, mock, before } from "node:test";
import assert from "node:assert/strict";

// ─── Dynamic import ───────────────────────────────────────────────────────

let queries;

before(async () => {
  queries = await import("../../../../lib/handlers/wiki/wikiQueries.js");
});

// ─── Mock store factories ────────────────────────────────────────────────

function makeMem(id, title = "Memory title", updated_at = "2026-01-01T00:00:00.000Z") {
  return { id, title, updated_at, valid_until: null };
}

function makeWikiStore(overrides = {}) {
  return {
    search: overrides.search ?? (async () => []),
    list:   overrides.list   ?? (async () => []),
    get:    overrides.get    ?? (async () => null),
  };
}

function makePool(queryFn) {
  return { query: queryFn ?? (async () => ({ rows: [], rowCount: 0 })) };
}

// =============================================================================
// searchArticles — store.wiki path
// =============================================================================
describe("searchArticles — store.wiki path", () => {
  test("validates query is required", async () => {
    const store = { wiki: makeWikiStore() };
    await assert.rejects(
      () => queries.searchArticles(store, async () => [], { query: "" }),
      { message: /query is required/ }
    );
    await assert.rejects(
      () => queries.searchArticles(store, async () => [], { query: "   " }),
      { message: /query is required/ }
    );
    await assert.rejects(
      () => queries.searchArticles(store, async () => [], {}),
      { message: /query is required/ }
    );
  });

  test("delegates to store.wiki.search with correct params", async () => {
    const search = mock.fn(async () => []);
    const store = { wiki: makeWikiStore({ search }) };
    const genEmb = mock.fn(async () => [0.1, 0.2]);

    await queries.searchArticles(store, genEmb, { query: "test query", tags: ["api"], status: "fresh", limit: 5, mode: "auto" });

    assert.equal(search.mock.calls.length, 1);
    const opts = search.mock.calls[0].arguments[0];
    assert.equal(opts.query, "test query");
    assert.deepEqual(opts.queryEmbedding, [0.1, 0.2]);
    assert.deepEqual(opts.tags, ["api"]);
    assert.equal(opts.status, "fresh");
    assert.equal(opts.limit, 5);
    assert.equal(opts.mode, "auto");
  });

  test("generates embedding for auto mode", async () => {
    const search = mock.fn(async () => []);
    const store = { wiki: makeWikiStore({ search }) };
    const genEmb = mock.fn(async (text) => [text.length * 0.01]);

    await queries.searchArticles(store, genEmb, { query: "hello" });

    assert.equal(genEmb.mock.calls.length, 1);
    assert.equal(genEmb.mock.calls[0].arguments[0], "hello");
  });

  test("skips embedding generation in fulltext mode", async () => {
    const search = mock.fn(async () => []);
    const store = { wiki: makeWikiStore({ search }) };
    const genEmb = mock.fn(async () => { throw new Error("should not be called"); });

    await queries.searchArticles(store, genEmb, { query: "hello", mode: "fulltext" });

    assert.equal(genEmb.mock.calls.length, 0, "embedding should not be generated in fulltext mode");
    const opts = search.mock.calls[0].arguments[0];
    assert.equal(opts.queryEmbedding, null);
  });

  test("generates embedding for semantic mode", async () => {
    const search = mock.fn(async () => []);
    const store = { wiki: makeWikiStore({ search }) };
    const genEmb = mock.fn(async () => [0.5]);

    await queries.searchArticles(store, genEmb, { query: "hello", mode: "semantic" });

    assert.equal(genEmb.mock.calls.length, 1);
    const opts = search.mock.calls[0].arguments[0];
    assert.deepEqual(opts.queryEmbedding, [0.5]);
  });

  test("passes defaults when not provided", async () => {
    const search = mock.fn(async () => []);
    const store = { wiki: makeWikiStore({ search }) };

    await queries.searchArticles(store, async () => [], { query: "test" });

    const opts = search.mock.calls[0].arguments[0];
    assert.equal(opts.limit, 10);
    assert.equal(opts.mode, "auto");
  });

  test("returns results from store.wiki.search", async () => {
    const rows = [{ slug: "article-1", title: "Article 1" }];
    const store = { wiki: makeWikiStore({ search: async () => rows }) };

    const result = await queries.searchArticles(store, async () => [], { query: "test" });

    assert.equal(result, rows);
    assert.equal(result.length, 1);
  });
});

// =============================================================================
// listArticles — store.wiki path
// =============================================================================
describe("listArticles — store.wiki path", () => {
  test("delegates to store.wiki.list with correct params", async () => {
    const list = mock.fn(async () => []);
    const store = { wiki: makeWikiStore({ list }) };

    await queries.listArticles(store, { tag: "api", status: "fresh", updated_since: "2026-05-01", limit: 10, offset: 5 });

    assert.equal(list.mock.calls.length, 1);
    const opts = list.mock.calls[0].arguments[0];
    assert.equal(opts.tag, "api");
    assert.equal(opts.status, "fresh");
    assert.equal(opts.updated_since, "2026-05-01");
    assert.equal(opts.limit, 10);
    assert.equal(opts.offset, 5);
  });

  test("uses defaults when not provided", async () => {
    const list = mock.fn(async () => []);
    const store = { wiki: makeWikiStore({ list }) };

    await queries.listArticles(store, {});

    const opts = list.mock.calls[0].arguments[0];
    assert.equal(opts.limit, 25);
    assert.equal(opts.offset, 0);
  });

  test("returns results from store.wiki.list", async () => {
    const rows = [{ slug: "art-1", title: "Art 1" }];
    const store = { wiki: makeWikiStore({ list: async () => rows }) };

    const result = await queries.listArticles(store, {});

    assert.equal(result, rows);
  });
});

// =============================================================================
// getArticle — store.wiki path
// =============================================================================
describe("getArticle — store.wiki path", () => {
  test("returns article with resolved source titles from cache", async () => {
    const article = { id: "art-1", slug: "my-art", source_memory_ids: ["mem-1", "mem-2"] };
    const store = {
      wiki: makeWikiStore({ get: async () => article }),
      cache: [
        makeMem("mem-1", "Memory One"),
        makeMem("mem-2", "Memory Two"),
      ],
    };

    const result = await queries.getArticle(store, "my-art");

    assert.equal(result.slug, "my-art");
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0].id, "mem-1");
    assert.equal(result.sources[0].title, "Memory One");
    assert.equal(result.sources[1].title, "Memory Two");
  });

  test("returns null when article does not exist", async () => {
    const store = { wiki: makeWikiStore({ get: async () => null }) };

    const result = await queries.getArticle(store, "nonexistent");

    assert.equal(result, null);
  });

  test("uses memory id as title when not found in cache", async () => {
    const article = { id: "art-2", slug: "other", source_memory_ids: ["mem-missing"] };
    const store = {
      wiki: makeWikiStore({ get: async () => article }),
      cache: [],  // cache is empty
    };

    const result = await queries.getArticle(store, "other");

    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].id, "mem-missing");
    assert.equal(result.sources[0].title, "mem-missing");  // fallback to id
  });

  test("filters out valid_until (expired) cache entries", async () => {
    const article = { id: "art-3", slug: "slug-3", source_memory_ids: ["mem-expired"] };
    const store = {
      wiki: makeWikiStore({ get: async () => article }),
      cache: [{ id: "mem-expired", title: "Old Memory", updated_at: "2025-01-01T00:00:00.000Z", valid_until: "2025-06-01T00:00:00.000Z" }],
    };

    const result = await queries.getArticle(store, "slug-3");

    // Expired memory should not be found → title falls back to id
    assert.equal(result.sources[0].title, "mem-expired");
  });

  test("handles article with no source_memory_ids", async () => {
    const article = { id: "art-4", slug: "no-sources" };
    const store = {
      wiki: makeWikiStore({ get: async () => article }),
      cache: [],
    };

    const result = await queries.getArticle(store, "no-sources");

    assert.deepEqual(result.sources, []);
  });

  test("handles article with source_memory_ids = undefined", async () => {
    const article = { id: "art-5", slug: "undef-sources", source_memory_ids: undefined };
    const store = {
      wiki: makeWikiStore({ get: async () => article }),
      cache: [],
    };

    const result = await queries.getArticle(store, "undef-sources");

    assert.deepEqual(result.sources, []);
  });

  test("spreads article properties onto result", async () => {
    const article = { id: "art-6", slug: "full-art", title: "Full Article", body_md: "# Hello", status: "fresh" };
    const store = {
      wiki: makeWikiStore({ get: async () => article }),
      cache: [],
    };

    const result = await queries.getArticle(store, "full-art");

    assert.equal(result.title, "Full Article");
    assert.equal(result.body_md, "# Hello");
    assert.equal(result.status, "fresh");
  });
});

// =============================================================================
// searchArticles — Postgres path
// =============================================================================
describe("searchArticles — Postgres path", () => {
  function makePool() {
    let lastQuery = null;
    let lastParams = null;
    const query = mock.fn(async (sql, params) => {
      lastQuery = sql;
      lastParams = params;
      return { rows: [], rowCount: 0 };
    });
    return { query, _lastQuery: () => lastQuery, _lastParams: () => lastParams };
  }

  function pgStore(pool) {
    return { pool, wiki: undefined };
  }

  test("generates embedding and calls pool.query for hybrid search", async () => {
    const pool = makePool();
    const genEmb = mock.fn(async () => [0.1, 0.2, 0.3]);
    const store = pgStore(pool);

    await queries.searchArticles(store, genEmb, { query: "test query" });

    assert.equal(genEmb.mock.calls.length, 1);
    assert.equal(pool.query.mock.calls.length, 1);
    // SQL should contain hybrid fusion pattern (vector + fts)
    const sql = pool.query.mock.calls[0].arguments[0];
    assert.ok(sql.includes("vector_ranked"), "should use vector search");
    assert.ok(sql.includes("fts_ranked"), "should use FTS search");
    assert.ok(sql.includes("fused"), "should fuse results");
  });

  test("uses fulltext-only mode when mode=fulltext", async () => {
    const pool = makePool();
    const genEmb = mock.fn(async () => { throw new Error("should not embed"); });
    const store = pgStore(pool);

    await queries.searchArticles(store, genEmb, { query: "test", mode: "fulltext" });

    assert.equal(genEmb.mock.calls.length, 0);
    const sql = pool.query.mock.calls[0].arguments[0];
    assert.ok(sql.includes("plainto_tsquery"), "should use FTS search");
    assert.ok(!sql.includes("<=>"), "should not use vector search");
  });

  test("uses semantic-only mode when mode=semantic", async () => {
    const pool = makePool();
    const genEmb = mock.fn(async () => [0.1, 0.2]);
    const store = pgStore(pool);

    await queries.searchArticles(store, genEmb, { query: "test", mode: "semantic" });

    assert.equal(genEmb.mock.calls.length, 1);
    const sql = pool.query.mock.calls[0].arguments[0];
    assert.ok(sql.includes("<=>"), "should use vector search");
    assert.ok(!sql.includes("plainto_tsquery"), "should not use FTS search");
  });

  test("clamps limit between 1 and 25", async () => {
    const pool = makePool();
    const store = pgStore(pool);

    await queries.searchArticles(store, async () => [0.1], { query: "test", limit: 100 });
    await queries.searchArticles(store, async () => [0.1], { query: "test", limit: -5 });

    // First call: limit 100 → clamped to 25
    const params1 = pool.query.mock.calls[0].arguments[1];
    const lastParam1 = params1[params1.length - 1];
    assert.equal(lastParam1, 25, "limit 100 should be clamped to 25");

    // Second call: limit -5 → Math.max(-5, 1) = 1
    const params2 = pool.query.mock.calls[1].arguments[1];
    const lastParam2 = params2[params2.length - 1];
    assert.equal(lastParam2, 1, "negative limit should be clamped to 1");
  });

  test("passes tags and status filters to SQL", async () => {
    const pool = makePool();
    const store = pgStore(pool);

    await queries.searchArticles(store, async () => [0.1], {
      query: "test", tags: ["api"], status: "fresh",
    });

    const sql = pool.query.mock.calls[0].arguments[0];
    assert.ok(sql.includes("status = "), "should filter by status");
    assert.ok(sql.includes("tags && "), "should filter by tags");
  });
});

// =============================================================================
// listArticles — Postgres path
// =============================================================================
describe("listArticles — Postgres path", () => {
  function pgStore(pool) {
    return { pool, wiki: undefined };
  }

  test("calls pool.query with list SQL", async () => {
    const query = mock.fn(async () => ({ rows: [], rowCount: 0 }));
    const store = pgStore({ query });

    await queries.listArticles(store, { tag: "api", status: "fresh", updated_since: "2026-05-01", limit: 10, offset: 5 });

    assert.equal(query.mock.calls.length, 1);
    const sql = query.mock.calls[0].arguments[0];
    assert.ok(sql.includes("FROM wiki_articles"));
    assert.ok(sql.includes("ORDER BY generated_at DESC"));
    assert.ok(sql.includes("LIMIT"));
    assert.ok(sql.includes("OFFSET"));
  });

  test("includes tag filter when provided", async () => {
    const query = mock.fn(async () => ({ rows: [], rowCount: 0 }));
    const store = pgStore({ query });

    await queries.listArticles(store, { tag: "python" });

    const sql = query.mock.calls[0].arguments[0];
    assert.ok(sql.includes("ANY(tags)"), "tag filter should use ANY(tags)");
  });

  test("includes updated_since filter when provided", async () => {
    const query = mock.fn(async () => ({ rows: [], rowCount: 0 }));
    const store = pgStore({ query });

    await queries.listArticles(store, { updated_since: "2026-06-01" });

    const sql = query.mock.calls[0].arguments[0];
    assert.ok(sql.includes("generated_at"), "should filter by generated_at");
  });

  test("clamps limit between 1 and 100", async () => {
    const query = mock.fn(async () => ({ rows: [], rowCount: 0 }));
    const store = pgStore({ query });

    await queries.listArticles(store, { limit: 500 });
    const params1 = query.mock.calls[0].arguments[1];
    assert.equal(params1[params1.length - 2], 100, "limit 500 should be clamped to 100");

    await queries.listArticles(store, { limit: -5 });
    const params2 = query.mock.calls[1].arguments[1];
    assert.equal(params2[params2.length - 2], 1, "negative limit should be clamped to 1");
  });

  test("returns empty array when no articles match", async () => {
    const query = mock.fn(async () => ({ rows: [], rowCount: 0 }));
    const store = pgStore({ query });

    const result = await queries.listArticles(store, { status: "archived" });
    assert.deepEqual(result, []);
  });
});

// =============================================================================
// getArticle — Postgres path
// =============================================================================
describe("getArticle — Postgres path", () => {
  function pgStore(queryFn) {
    return { pool: { query: queryFn }, wiki: undefined };
  }

  test("returns article with sources from SQL join", async () => {
    let callCount = 0;
    const query = mock.fn(async (sql) => {
      callCount++;
      if (callCount === 1) {
        // First query: get article
        return { rows: [{ id: "pg-1", slug: "pg-art", title: "PG Article", body_md: "# Hello", status: "fresh", revision: 1, generated_at: "2026-06-01T00:00:00.000Z", generated_by: "ollama", summary: "A PG article", tags: ["test"] }], rowCount: 1 };
      }
      // Second query: get sources
      return { rows: [{ id: "mem-1", title: "Memory One" }], rowCount: 1 };
    });
    const store = pgStore(query);

    const result = await queries.getArticle(store, "pg-art");

    assert.ok(result);
    assert.equal(result.slug, "pg-art");
    assert.equal(result.title, "PG Article");
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].title, "Memory One");
  });

  test("returns null when article does not exist", async () => {
    const query = mock.fn(async () => ({ rows: [], rowCount: 0 }));
    const store = pgStore(query);

    const result = await queries.getArticle(store, "missing");

    assert.equal(result, null);
  });

  test("returns article with empty sources when none linked", async () => {
    let callCount = 0;
    const query = mock.fn(async () => {
      callCount++;
      if (callCount === 1) return { rows: [{ id: "pg-2", slug: "no-sources", title: "No Sources", body_md: "Content", status: "fresh", revision: 1, generated_at: "2026-06-01T00:00:00.000Z", generated_by: "ollama" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const store = pgStore(query);

    const result = await queries.getArticle(store, "no-sources");

    assert.ok(result);
    assert.deepEqual(result.sources, []);
  });

  test("queries correct SQL for article lookup", async () => {
    let callCount = 0;
    const query = mock.fn(async (sql, params) => {
      callCount++;
      if (callCount === 1) {
        assert.ok(sql.includes("FROM wiki_articles WHERE slug ="));
        assert.equal(params[0], "specific-slug");
        return { rows: [{ id: "pg-3", slug: "specific-slug", title: "Specific" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const store = pgStore(query);

    await queries.getArticle(store, "specific-slug");

    assert.equal(callCount, 2, "should query article then sources");
  });
});
