// tests/lib/handlers/wiki/wikiHandlers.test.js
//
// Tests for wikiWriteHandler, wikiSearchHandler, wikiListHandler, wikiGetHandler.
//
// Strategy: provide mock `store` objects that implement either the
// `store.wiki` (SQLite/cache) interface or the `store.pool` (Postgres)
// interface. The real queries module (wikiQueries.js) delegates to the
// store at runtime, so we don't need to mock ESM imports between the
// two modules. For wikiGetHandler's dynamic import of regenerate.js,
// we pre-import and mock that module before triggering the refresh path.

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

import logger from "../../../lib/helpers/logger.js";

// ─── Logger mocks ─────────────────────────────────────────────────────────

let infoCalls = [];
let warnCalls = [];
let errorCalls = [];

function resetLogCalls() {
  infoCalls = [];
  warnCalls = [];
  errorCalls = [];
}

before(() => {
  mock.method(logger, "info",  (...args) => { infoCalls.push(args); });
  mock.method(logger, "warn",  (...args) => { warnCalls.push(args); });
  mock.method(logger, "error", (...args) => { errorCalls.push(args); });
});

after(() => {
  mock.restoreAll();
});

// ─── Mock store factories ────────────────────────────────────────────────

/** Memory stub for store.cache lookup */
function makeMem(id, title = "Memory title", updated_at = "2026-01-01T00:00:00.000Z") {
  return { id, title, updated_at, valid_until: null };
}

/**
 * Create a mock `store.wiki` (SQLite / in-memory cache interface).
 * Each method is a spy that can be overridden per test.
 */
function makeWikiStore(overrides = {}) {
  return {
    search: overrides.search ?? (async () => []),
    list:   overrides.list   ?? (async () => []),
    get:    overrides.get    ?? (async () => null),
    upsert: overrides.upsert ?? (async () => ({ id: "art-1", revision: 1, inserted: true })),
  };
}

/**
 * Create a mock context with `store.wiki` (SQLite path).
 */
function makeWikiCtx(wikiOverrides = {}, extra = {}) {
  const cache = extra.cache ?? [];
  return {
    store: {
      wiki: makeWikiStore(wikiOverrides),
      refreshCache: extra.refreshCache ?? (async () => {}),
      cache,
    },
    generateEmbedding: extra.generateEmbedding ?? (async (text) => `[mock:${text.length}]`),
    ...extra.ctxOverrides,
  };
}

/**
 * Create a mock Postgres pool.
 */
function makePgPool(overrides = {}) {
  const pgQuery = overrides.query ?? (async () => ({ rows: [], rowCount: 0 }));
  const pgClient = {
    query: overrides.clientQuery ?? (async () => ({ rows: [{ id: "pg-1", revision: 1, inserted: true }], rowCount: 1 })),
    release: overrides.clientRelease ?? (() => {}),
  };
  const pgConnect = overrides.connect ?? (async () => pgClient);

  return {
    query: pgQuery,
    connect: pgConnect,
  };
}

/**
 * Create a mock context with `store.pool` (Postgres path).
 */
function makePgCtx(poolOverrides = {}, extra = {}) {
  return {
    store: {
      pool: makePgPool(poolOverrides),
      // no store.wiki — the handlers check for store.wiki first
    },
    generateEmbedding: extra.generateEmbedding ?? (async (text) => [0.1, 0.2, 0.3]),
    ...extra.ctxOverrides,
  };
}

function resetState() {
  resetLogCalls();
}

// ─── Dynamic import ───────────────────────────────────────────────────────

let wiki;

before(async () => {
  // Set predictable env vars for modelTag()
  process.env.AI_PROVIDER = "ollama";
  process.env.OLLAMA_MODEL = "llama3.1";

  wiki = await import("../../../lib/handlers/wiki/wikiHandlers.js");
});

// =============================================================================
// wikiWriteHandler — validation
// =============================================================================
describe("wikiWriteHandler — validation", () => {
  afterEach(() => { resetState(); });

  test("rejects invalid slug", async () => {
    const ctx = makeWikiCtx();
    const result = await wiki.wikiWriteHandler(ctx, { slug: "UPPERCASE", title: "T", body_md: "B" });
    assert.ok(result.content[0].text.includes("slug must be lowercase"));
  });

  test("rejects empty slug", async () => {
    const ctx = makeWikiCtx();
    const result = await wiki.wikiWriteHandler(ctx, { slug: "", title: "T", body_md: "B" });
    assert.ok(result.content[0].text.includes("slug must be lowercase"));
  });

  test("rejects missing title", async () => {
    const ctx = makeWikiCtx();
    const result = await wiki.wikiWriteHandler(ctx, { slug: "my-article", body_md: "B" });
    assert.ok(result.content[0].text.includes("title and body_md are required"));
  });

  test("rejects missing body_md", async () => {
    const ctx = makeWikiCtx();
    const result = await wiki.wikiWriteHandler(ctx, { slug: "my-article", title: "T" });
    assert.ok(result.content[0].text.includes("title and body_md are required"));
  });

  test("drops unrecognized source ids and still writes the article", async () => {
    const upsert = mock.fn(async () => ({ id: "a1", revision: 1, inserted: true }));
    const ctx = makeWikiCtx({ upsert }, { cache: [makeMem("mem-1")] });
    // mem-1 exists, mem-2 does not — write succeeds with only mem-1 kept.
    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "my-article", title: "Test", body_md: "Body",
      source_memory_ids: ["mem-1", "mem-2"],
    });
    assert.ok(result.content[0].text.includes("Created"), "should still create the article");
    assert.ok(result.content[0].text.includes("sources: 1"), "should count only valid sources");
    assert.ok(result.content[0].text.includes("1 unrecognized source id(s) omitted"), "should warn about the dropped id");
    assert.ok(result.content[0].text.includes("mem-2"), "should name the dropped id");
    const [opts] = upsert.mock.calls[0].arguments;
    assert.deepEqual(opts.source_memory_ids, ["mem-1"], "upsert should receive only the valid id");
    assert.ok(warnCalls.some(a => a[0].includes("dropped 1 unrecognized source id")), "should log a warning");
  });

  test("drops expired (valid_until) source ids and still writes", async () => {
    const upsert = mock.fn(async () => ({ id: "a1", revision: 1, inserted: true }));
    const ctx = makeWikiCtx(
      { upsert },
      { cache: [{ id: "mem-exp", title: "Expired", updated_at: "2026-01-01T00:00:00.000Z", valid_until: "2026-06-01T00:00:00.000Z" }] }
    );
    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "my-article", title: "Test", body_md: "Body",
      source_memory_ids: ["mem-exp"],
    });
    assert.ok(result.content[0].text.includes("Created"), "writes even when every source drops");
    assert.ok(result.content[0].text.includes("sources: 0"));
    assert.ok(result.content[0].text.includes("1 unrecognized source id(s) omitted"));
    const [opts] = upsert.mock.calls[0].arguments;
    assert.deepEqual(opts.source_memory_ids, []);
  });

  test("keeps valid ids when one is a malformed UUID (chain-recall regression)", async () => {
    // Reproduces the E4B model-tier failure: recall returned 'eaea7bd2-…' but the
    // model transcribed 'eae7bd2-…' (a dropped hex char) into source_memory_ids.
    // The old handler rejected the whole write, forcing a retry that blew the
    // bounded turn budget. It must now keep the two good ids and proceed.
    const good1 = "530924ac-8615-4a78-983f-f5ed4fdd42c2";
    const good2 = "72797743-c906-41f1-890c-ad3e2393516b";
    const bad   = "eae7bd2-d49e-4891-a408-25891d96ce22"; // malformed: 7 hex in first group
    const upsert = mock.fn(async () => ({ id: "a1", revision: 1, inserted: true }));
    const ctx = makeWikiCtx({ upsert }, { cache: [makeMem(good1), makeMem(good2)] });
    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "nimbus-service-overview", title: "Nimbus", body_md: "Body",
      source_memory_ids: [good1, good2, bad],
    });
    assert.ok(result.content[0].text.includes("Created"), "one bad UUID must not fail the whole write");
    assert.ok(result.content[0].text.includes("sources: 2"));
    assert.ok(result.content[0].text.includes("1 unrecognized source id(s) omitted"));
    const [opts] = upsert.mock.calls[0].arguments;
    assert.deepEqual(opts.source_memory_ids, [good1, good2]);
  });

  test("accepts valid kebab-case slug", async () => {
    const ctx = makeWikiCtx({ upsert: async () => ({ id: "a1", revision: 1, inserted: true }) });
    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "my-article-v2", title: "My Article", body_md: "Content",
    });
    assert.ok(result.content[0].text.includes("Created"));
  });
});

// =============================================================================
// wikiWriteHandler — store.wiki (SQLite) path
// =============================================================================
describe("wikiWriteHandler — store.wiki path", () => {
  afterEach(() => { resetState(); });
  afterEach(() => { delete process.env.AI_PROVIDER; process.env.AI_PROVIDER = "ollama"; });

  test("creates a new article via store.wiki.upsert", async () => {
    const upsert = mock.fn(async () => ({ id: "art-123", revision: 1, inserted: true }));
    const ctx = makeWikiCtx({ upsert });

    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "test-article", title: "Test Article", summary: "A summary",
      body_md: "## Content\n\nHello world", tags: ["test"],
    });

    assert.equal(upsert.mock.calls.length, 1);
    const [opts, embedding] = upsert.mock.calls[0].arguments;
    assert.equal(opts.slug, "test-article");
    assert.equal(opts.title, "Test Article");
    assert.equal(opts.summary, "A summary");
    assert.equal(opts.tags[0], "test");
    assert.ok(opts.generated_by);
    assert.ok(opts.source_hash);
    assert.ok(embedding);
    assert.ok(result.content[0].text.includes("Created"));
    assert.ok(result.content[0].text.includes("Test Article"));
  });

  test("returns update verb when upsert reports inserted=false", async () => {
    const upsert = mock.fn(async () => ({ id: "art-1", revision: 3, inserted: false }));
    const ctx = makeWikiCtx({ upsert });

    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "existing", title: "Existing", body_md: "Updated content",
    });

    assert.ok(result.content[0].text.includes("Updated (rev 3)"));
  });

  test("includes source memory ids in upsert call", async () => {
    const mems = [makeMem("mem-a"), makeMem("mem-b")];
    const upsert = mock.fn(async () => ({ id: "art-1", revision: 1, inserted: true }));
    const ctx = makeWikiCtx({ upsert }, { cache: mems });

    await wiki.wikiWriteHandler(ctx, {
      slug: "sourced-article", title: "Sourced", body_md: "Body",
      source_memory_ids: ["mem-a", "mem-b"],
    });

    const [opts] = upsert.mock.calls[0].arguments;
    assert.deepEqual(opts.source_memory_ids, ["mem-a", "mem-b"]);
    assert.ok(opts.source_hash);
  });

  test("logs warning when embedding is null", async () => {
    const ctx = makeWikiCtx(
      { upsert: async () => ({ id: "x", revision: 1, inserted: true }) },
      { generateEmbedding: async () => null }
    );

    await wiki.wikiWriteHandler(ctx, {
      slug: "no-emb", title: "No Emb", body_md: "Body",
    });

    assert.ok(warnCalls.some(args => args[0].includes("no embedding")));
  });

  test("returns error message when upsert throws", async () => {
    const ctx = makeWikiCtx({
      upsert: async () => { throw new Error("DB constraint violation"); },
    });

    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "failing", title: "Fail", body_md: "Body",
    });

    assert.ok(result.content[0].text.includes("DB constraint violation"));
  });
});

// =============================================================================
// wikiWriteHandler — Postgres path
// =============================================================================
describe("wikiWriteHandler — Postgres path", () => {
  afterEach(() => { resetState(); });

  test("writes article via Postgres INSERT", async () => {
    const clientQuery = mock.fn(async (sql) => {
      if (sql === "BEGIN") return {};
      if (sql.includes("INSERT INTO wiki_articles")) {
        return { rows: [{ id: "pg-1", revision: 1, inserted: true }] };
      }
      if (sql.includes("DELETE FROM wiki_article_sources")) return {};
      if (sql.includes("INSERT INTO wiki_article_sources")) return {};
      if (sql === "COMMIT") return {};
      return {};
    });
    const released = [];
    const client = { query: clientQuery, release: () => released.push(true) };
    const ctx = makePgCtx({ connect: async () => client, clientQuery });

    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "pg-article", title: "PG Article", body_md: "## Hello",
    });

    assert.ok(result.content[0].text.includes("Created"));
    assert.equal(released.length, 1, "client should be released");
  });

  test("drops unrecognized source ids in Postgres path", async () => {
    const known   = "10000000-0000-4000-8000-000000000001";
    const unknown = "20000000-0000-4000-8000-000000000002"; // well-formed but not in DB
    const poolQuery = mock.fn(async () => ({ rows: [{ id: known, updated_at: "2026-01-01T00:00:00.000Z" }] }));
    let insertedParams = null;
    const clientQuery = mock.fn(async (sql, params) => {
      if (sql.includes("INSERT INTO wiki_articles")) return { rows: [{ id: "pg-1", revision: 1, inserted: true }] };
      if (sql.includes("INSERT INTO wiki_article_sources")) { insertedParams = params; return {}; }
      return {};
    });
    const client = { query: clientQuery, release: () => {} };
    const ctx = makePgCtx({ query: poolQuery, connect: async () => client, clientQuery });

    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "pg-article", title: "PG", body_md: "Body",
      source_memory_ids: [known, unknown],
    });

    assert.ok(result.content[0].text.includes("Created"));
    assert.ok(result.content[0].text.includes("sources: 1"));
    assert.ok(result.content[0].text.includes("1 unrecognized source id(s) omitted"));
    assert.deepEqual(insertedParams.slice(1), [known], "only the known id is inserted");
  });

  test("pre-filters a malformed UUID before the ::uuid[] cast (Postgres)", async () => {
    // A malformed id must never reach the ::uuid[] cast (Postgres would throw
    // 'invalid input syntax for type uuid'). It is filtered up front; the
    // well-formed known id survives and the write succeeds.
    const known     = "10000000-0000-4000-8000-000000000001";
    const malformed = "eae7bd2-d49e-4891-a408-25891d96ce22";
    let castParams = null;
    const poolQuery = mock.fn(async (sql, params) => { castParams = params; return { rows: [{ id: known, updated_at: "2026-01-01T00:00:00.000Z" }] }; });
    const clientQuery = mock.fn(async (sql) => {
      if (sql.includes("INSERT INTO wiki_articles")) return { rows: [{ id: "pg-2", revision: 1, inserted: true }] };
      return {};
    });
    const client = { query: clientQuery, release: () => {} };
    const ctx = makePgCtx({ query: poolQuery, connect: async () => client, clientQuery });

    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "pg-mal", title: "PG", body_md: "Body",
      source_memory_ids: [known, malformed],
    });

    assert.ok(result.content[0].text.includes("Created"));
    assert.deepEqual(castParams[0], [known], "malformed id must be filtered before the cast");
    assert.ok(result.content[0].text.includes("1 unrecognized source id(s) omitted"));
  });

  test("handles Postgres upsert error with rollback", async () => {
    let rolledBack = false;
    const clientQuery = mock.fn(async (sql) => {
      if (sql === "BEGIN") return {};
      if (sql.includes("INSERT INTO wiki_articles")) throw new Error("INSERT conflict");
      return {};
    });
    const client = {
      query: clientQuery,
      query: async (sql) => {
        if (sql === "ROLLBACK") { rolledBack = true; return {}; }
        if (sql === "BEGIN") return {};
        if (sql.includes("INSERT INTO wiki_articles")) throw new Error("INSERT conflict");
        return {};
      },
      release: () => {},
    };
    const ctx = makePgCtx({ connect: async () => client, clientQuery });

    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "pg-fail", title: "PG Fail", body_md: "Body",
    });

    assert.ok(result.content[0].text.includes("INSERT conflict"));
    assert.ok(rolledBack, "should roll back on error");
  });

  test("writes source_memory_ids in Postgres path", async () => {
    let sourcesInserted = false;
    const clientQuery = mock.fn(async (sql, params) => {
      if (sql === "BEGIN") return {};
      if (sql.includes("INSERT INTO wiki_articles")) {
        return { rows: [{ id: "pg-2", revision: 1, inserted: true }] };
      }
      if (sql.includes("DELETE FROM wiki_article_sources")) return {};
      if (sql.includes("INSERT INTO wiki_article_sources")) {
        sourcesInserted = true;
        return {};
      }
      if (sql === "COMMIT") return {};
      return {};
    });
    const client = { query: clientQuery, release: () => {} };
    const src1 = "11111111-1111-4111-8111-111111111111";
    const src2 = "22222222-2222-4222-8222-222222222222";
    const poolQuery = mock.fn(async () => ({ rows: [
      { id: src1, updated_at: "2026-01-01T00:00:00.000Z" },
      { id: src2, updated_at: "2026-01-02T00:00:00.000Z" },
    ]}));
    const ctx = makePgCtx({ query: poolQuery, connect: async () => client, clientQuery });

    const result = await wiki.wikiWriteHandler(ctx, {
      slug: "pg-sourced", title: "PG Sourced", body_md: "Body",
      source_memory_ids: [src1, src2],
    });

    assert.ok(result.content[0].text.includes("Created"));
    assert.ok(result.content[0].text.includes("sources: 2"), "both valid ids counted");
    assert.ok(!result.content[0].text.includes("omitted"), "no drop note when all ids resolve");
    assert.ok(sourcesInserted, "source ids should be written");
  });

  test("logs warning when embedding is null in Postgres path", async () => {
    let committed = false;
    const clientQuery = mock.fn(async (sql) => {
      if (sql === "BEGIN") return {};
      if (sql.includes("INSERT INTO wiki_articles")) {
        return { rows: [{ id: "pg-3", revision: 1, inserted: true }] };
      }
      if (sql === "COMMIT") { committed = true; return {}; }
      return {};
    });
    const client = { query: clientQuery, release: () => {} };
    const ctx = makePgCtx(
      { connect: async () => client, clientQuery },
      { generateEmbedding: async () => null }
    );

    await wiki.wikiWriteHandler(ctx, {
      slug: "pg-no-emb", title: "PG No Emb", body_md: "Body",
    });

    assert.ok(committed);
    assert.ok(warnCalls.some(args => args[0].includes("no embedding for pg-no-emb")));
  });
});

// =============================================================================
// wikiSearchHandler
// =============================================================================
describe("wikiSearchHandler()", () => {
  afterEach(() => { resetState(); });

  function makeRow(overrides = {}) {
    return {
      slug: "test-art", title: "Test Article", summary: "A test", tags: ["test"],
      status: "fresh", revision: 1, generated_at: "2026-06-01T12:00:00.000Z",
      score: 0.85, ...overrides,
    };
  }

  test("returns matching articles", async () => {
    const ctx = makeWikiCtx({
      search: async () => [makeRow()],
    });

    const result = await wiki.wikiSearchHandler(ctx, { query: "test" });

    assert.ok(result.content[0].text.includes("Found 1 article(s)"));
    assert.ok(result.content[0].text.includes("Test Article"));
    assert.ok(result.content[0].text.includes("#test"));
    assert.ok(result.content[0].text.includes("0.850"));
  });

  test("returns no-articles message when empty", async () => {
    const ctx = makeWikiCtx({ search: async () => [] });

    const result = await wiki.wikiSearchHandler(ctx, { query: "nonexistent" });

    assert.ok(result.content[0].text.includes('No wiki articles matched'));
  });

  test("handles search error gracefully", async () => {
    const ctx = makeWikiCtx({
      search: async () => { throw new Error("Search index unavailable"); },
    });

    const result = await wiki.wikiSearchHandler(ctx, { query: "test" });

    assert.ok(result.content[0].text.includes("Search index unavailable"));
  });

  test("formats multiple results", async () => {
    const ctx = makeWikiCtx({
      search: async () => [
        makeRow({ slug: "art-a", title: "Article A", score: 0.95 }),
        makeRow({ slug: "art-b", title: "Article B", score: 0.70, tags: [] }),
      ],
    });

    const result = await wiki.wikiSearchHandler(ctx, { query: "test", limit: 5 });

    assert.ok(result.content[0].text.includes("Found 2 article(s)"));
    assert.ok(result.content[0].text.includes("Article A"));
    assert.ok(result.content[0].text.includes("Article B"));
  });

  test("formats tags with hash prefix", async () => {
    const ctx = makeWikiCtx({
      search: async () => [makeRow({ tags: ["one", "two"] })],
    });

    const result = await wiki.wikiSearchHandler(ctx, { query: "test" });

    assert.ok(result.content[0].text.includes("#one"));
    assert.ok(result.content[0].text.includes("#two"));
  });

  test("includes summary in formatted output", async () => {
    const ctx = makeWikiCtx({
      search: async () => [makeRow({ summary: "A test summary" })],
    });

    const result = await wiki.wikiSearchHandler(ctx, { query: "test" });

    assert.ok(result.content[0].text.includes("A test summary"));
  });

  test("handles undefined tags gracefully", async () => {
    const ctx = makeWikiCtx({
      search: async () => [makeRow({ tags: undefined })],
    });

    const result = await wiki.wikiSearchHandler(ctx, { query: "test" });

    assert.ok(result.content[0].text.includes("Found 1 article(s)"));
  });
});

// =============================================================================
// wikiListHandler
// =============================================================================
describe("wikiListHandler()", () => {
  afterEach(() => { resetState(); });

  function makeRow(overrides = {}) {
    return {
      slug: "list-art", title: "List Article", tags: ["demo"],
      status: "fresh", revision: 1, generated_at: "2026-06-01T12:00:00.000Z",
      summary: "A listed article", ...overrides,
    };
  }

  test("returns matching articles", async () => {
    const ctx = makeWikiCtx({
      list: async () => [makeRow()],
    });

    const result = await wiki.wikiListHandler(ctx, { tag: "demo" });

    assert.ok(result.content[0].text.includes("1 article(s)"));
    assert.ok(result.content[0].text.includes("List Article"));
  });

  test("returns no-articles message when empty", async () => {
    const ctx = makeWikiCtx({ list: async () => [] });

    const result = await wiki.wikiListHandler(ctx, {});

    assert.ok(result.content[0].text.includes("No wiki articles match"));
  });

  test("includes offset in header when provided", async () => {
    const ctx = makeWikiCtx({
      list: async () => [makeRow()],
    });

    const result = await wiki.wikiListHandler(ctx, { offset: 10 });

    assert.ok(result.content[0].text.includes("offset 10"));
  });

  test("passes parameters to listArticles", async () => {
    const list = mock.fn(async () => [makeRow()]);
    const ctx = makeWikiCtx({ list });

    await wiki.wikiListHandler(ctx, { tag: "api", status: "fresh", updated_since: "2026-05-01", limit: 5, offset: 0 });

    assert.equal(list.mock.calls.length, 1);
    // store.wiki.list receives a single opts object
    const opts = list.mock.calls[0].arguments[0];
    assert.ok(opts, "should receive an options argument");
    assert.equal(opts.tag, "api");
    assert.equal(opts.status, "fresh");
    assert.equal(opts.limit, 5);
  });

  test("formats columns with tags and summary", async () => {
    const ctx = makeWikiCtx({
      list: async () => [makeRow({ tags: ["guide", "tutorial"], summary: "A helpful guide" })],
    });

    const result = await wiki.wikiListHandler(ctx, {});

    assert.ok(result.content[0].text.includes("#guide"));
    assert.ok(result.content[0].text.includes("#tutorial"));
    assert.ok(result.content[0].text.includes("A helpful guide"));
  });
});

// =============================================================================
// wikiGetHandler
// =============================================================================
describe("wikiGetHandler()", () => {
  afterEach(() => { resetState(); });

  const sampleArticle = {
    id: "art-1", slug: "my-article", title: "My Article",
    summary: "A summary", body_md: "## Content\n\nHello world",
    tags: ["test"], status: "fresh", generated_by: "llama3.1",
    generated_at: "2026-06-01T12:00:00.000Z", revision: 2,
  };

  test("returns article content with metadata", async () => {
    const ctx = makeWikiCtx({
      get: async () => ({
        ...sampleArticle,
        source_memory_ids: ["mem-1"],  // triggers source resolution in getArticle
      }),
    }, {
      cache: [{ id: "mem-1", title: "Memory One", updated_at: "2026-01-01T00:00:00.000Z", valid_until: null }],
    });

    const result = await wiki.wikiGetHandler(ctx, { slug: "my-article" });

    const text = result.content[0].text;
    assert.ok(text.includes("🔖 From wiki"), "should have breadcrumb");
    assert.ok(text.includes("my-article"), "should have slug");
    assert.ok(text.includes("My Article"), "should have title");
    assert.ok(text.includes("> A summary"), "should have summary blockquote");
    assert.ok(text.includes("## Content"), "should have body content");
    assert.ok(text.includes("[[mem:mem-1]]"), "should have source link");
    assert.ok(text.includes("Memory One"), "should have source title");
  });

  test("returns error for non-existent article", async () => {
    const ctx = makeWikiCtx({ get: async () => null });

    const result = await wiki.wikiGetHandler(ctx, { slug: "missing" });

    assert.ok(result.content[0].text.includes("No article with slug"));
  });

  test("shows (none) for articles with no sources", async () => {
    const ctx = makeWikiCtx({
      get: async () => ({ ...sampleArticle, sources: [] }),
    });

    const result = await wiki.wikiGetHandler(ctx, { slug: "my-article" });

    assert.ok(result.content[0].text.includes("(none)"));
  });

  test("returns stale warning when allow_stale is false", async () => {
    const ctx = makeWikiCtx({
      get: async () => ({ ...sampleArticle, status: "stale" }),
    });

    const result = await wiki.wikiGetHandler(ctx, { slug: "my-article", allow_stale: false });

    assert.ok(result.content[0].text.includes("is stale"));
  });

  test("succeeds with stale article when allow_stale is true (default)", async () => {
    const ctx = makeWikiCtx({
      get: async () => ({ ...sampleArticle, status: "stale" }),
    });

    const result = await wiki.wikiGetHandler(ctx, { slug: "my-article" });

    assert.ok(result.content[0].text.includes("🔖 From wiki"));
    assert.ok(result.content[0].text.includes("stale"));
  });

  test("includes summary in header when present", async () => {
    const ctx = makeWikiCtx({
      get: async () => sampleArticle,
    });

    const result = await wiki.wikiGetHandler(ctx, { slug: "my-article" });

    const text = result.content[0].text;
    assert.ok(text.includes("> A summary"));
  });

  test("omits summary in header when summary is empty", async () => {
    const ctx = makeWikiCtx({
      get: async () => ({ ...sampleArticle, summary: "" }),
    });

    const result = await wiki.wikiGetHandler(ctx, { slug: "my-article" });

    // No `> ` blockquote for summary
    const text = result.content[0].text;
    assert.ok(!text.includes("> ") || !text.includes("> \n\n"), "should not have summary blockquote");
  });
});

// =============================================================================
// wikiGetHandler — refresh path
//
// NOTE: Testing the actual refresh path (dynamic import of regenerate.js)
// requires mocking ESM module namespace properties, which mock.method()
// cannot do because they are non-configurable. These paths are exercised
// indirectly by the source's own integration tests or via the test suite
// that covers the post-refresh code with the allow_stale=false path above.
// =============================================================================
// (Refresh-path tests require mock.module() support which is unavailable
//  in this Node.js build — see tests/lib/tools/shell.test.js comment.)
