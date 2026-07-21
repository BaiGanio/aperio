// tests/mcp/tools/self-wiki.test.js
// Tests for selfWikiWriteHandler / selfWikiGetHandler. Imports directly from
// the handler module — no MCP server boot. Mirrors tests/mcp/tools/self-memory.test.js
// and tests/lib/handlers/wiki/wikiHandlers.test.js conventions.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  selfWikiWriteHandler,
  selfWikiGetHandler,
} from "../../lib/handlers/wiki/selfWikiHandlers.js";

function makeSelfMem(id, title = "Self memory", updated_at = "2026-01-01T00:00:00.000Z") {
  return { id, title, updated_at };
}

/** store.selfWiki (SQLite path) stub. */
function makeSelfWikiStore(overrides = {}) {
  return {
    upsert: overrides.upsert ?? (async () => ({ id: "sw-1", revision: 1, inserted: true })),
    get:    overrides.get    ?? (async () => null),
  };
}

function makeCtx({ selfWikiOverrides = {}, getSelfById, local = true } = {}) {
  return {
    store: {
      selfWiki: makeSelfWikiStore(selfWikiOverrides),
      getSelfById: getSelfById ?? (async (id) => makeSelfMem(id)),
    },
    providerIsLocal: local,
  };
}

function makePgCtx({ poolOverrides = {}, clientOverrides = {}, getSelfById, local = true } = {}) {
  const clientQuery = clientOverrides.query ?? (async () => ({ rows: [{ id: "pg-sw-1", revision: 1, inserted: true }] }));
  const client = { query: clientQuery, release: clientOverrides.release ?? (() => {}) };
  return {
    store: {
      pool: {
        query:   poolOverrides.query   ?? (async () => ({ rows: [] })),
        connect: poolOverrides.connect ?? (async () => client),
      },
      getSelfById: getSelfById ?? (async (id) => makeSelfMem(id)),
    },
    providerIsLocal: local,
  };
}

const text = (r) => r.content[0].text;

// ─── selfWikiWriteHandler — validation ───────────────────────────────────────
describe("selfWikiWriteHandler — validation", () => {
  test("rejects invalid slug", async () => {
    const out = await selfWikiWriteHandler(makeCtx(), { slug: "UPPER", title: "T", body_md: "B" });
    assert.ok(text(out).includes("slug must be lowercase"));
  });

  test("rejects missing title/body_md", async () => {
    const out = await selfWikiWriteHandler(makeCtx(), { slug: "ok-slug", title: "T" });
    assert.ok(text(out).includes("title and body_md are required"));
  });

  test("rejects a source self-memory id that doesn't resolve", async () => {
    const ctx = makeCtx({ getSelfById: async (id) => (id === "missing" ? null : makeSelfMem(id)) });
    const out = await selfWikiWriteHandler(ctx, {
      slug: "sourced", title: "T", body_md: "B",
      source_self_memory_ids: ["ok-1", "missing"],
    });
    assert.ok(text(out).includes("1 source self-memory id(s) not found"));
  });
});

// ─── selfWikiWriteHandler — local-only gate ──────────────────────────────────
describe("selfWikiWriteHandler / selfWikiGetHandler — cloud gate", () => {
  test("self_wiki_write refuses on cloud without touching the store", async () => {
    let called = false;
    const ctx = makeCtx({ local: false, selfWikiOverrides: { upsert: async () => { called = true; } } });
    const out = await selfWikiWriteHandler(ctx, { slug: "x", title: "T", body_md: "B" });
    assert.ok(text(out).includes("local-only"));
    assert.equal(called, false);
  });

  test("self_wiki_get refuses on cloud without touching the store", async () => {
    let called = false;
    const ctx = makeCtx({ local: false, selfWikiOverrides: { get: async () => { called = true; return null; } } });
    const out = await selfWikiGetHandler(ctx, { slug: "x" });
    assert.ok(text(out).includes("local-only"));
    assert.equal(called, false);
  });
});

// ─── selfWikiWriteHandler — store.selfWiki (SQLite) path ────────────────────
describe("selfWikiWriteHandler — store.selfWiki path", () => {
  test("creates a new article via store.selfWiki.upsert", async () => {
    let received;
    const ctx = makeCtx({
      selfWikiOverrides: { upsert: async (opts) => { received = opts; return { id: "sw-1", revision: 1, inserted: true }; } },
    });
    const out = await selfWikiWriteHandler(ctx, {
      slug: "my-synth", title: "My Synth", summary: "s", body_md: "body", tags: ["t"],
    });
    assert.equal(received.slug, "my-synth");
    assert.ok(received.generated_by);
    assert.ok(received.source_hash);
    assert.ok(text(out).includes("Created"));
    assert.ok(text(out).includes("My Synth"));
  });

  test("returns update verb when upsert reports inserted=false", async () => {
    const ctx = makeCtx({ selfWikiOverrides: { upsert: async () => ({ id: "sw-1", revision: 4, inserted: false }) } });
    const out = await selfWikiWriteHandler(ctx, { slug: "existing", title: "T", body_md: "B" });
    assert.ok(text(out).includes("Updated (rev 4)"));
  });

  test("passes resolved source_self_memory_ids through to upsert", async () => {
    let received;
    const ctx = makeCtx({
      selfWikiOverrides: { upsert: async (opts) => { received = opts; return { id: "sw-1", revision: 1, inserted: true }; } },
    });
    await selfWikiWriteHandler(ctx, {
      slug: "sourced", title: "T", body_md: "B",
      source_self_memory_ids: ["mem-a", "mem-b"],
    });
    assert.deepEqual(received.source_memory_ids, ["mem-a", "mem-b"]);
  });

  test("returns error message when upsert throws", async () => {
    const ctx = makeCtx({ selfWikiOverrides: { upsert: async () => { throw new Error("boom"); } } });
    const out = await selfWikiWriteHandler(ctx, { slug: "failing", title: "T", body_md: "B" });
    assert.ok(text(out).includes("boom"));
  });
});

// ─── selfWikiWriteHandler — Postgres path ────────────────────────────────────
describe("selfWikiWriteHandler — Postgres path", () => {
  test("writes article via Postgres INSERT", async () => {
    let sourcesInserted = false;
    const clientQuery = async (sql) => {
      if (sql === "BEGIN") return {};
      if (sql.includes("INSERT INTO self_wiki_articles")) return { rows: [{ id: "pg-1", revision: 1, inserted: true }] };
      if (sql.includes("DELETE FROM self_wiki_article_sources")) return {};
      if (sql.includes("INSERT INTO self_wiki_article_sources")) { sourcesInserted = true; return {}; }
      if (sql === "COMMIT") return {};
      return {};
    };
    let released = false;
    const ctx = makePgCtx({ clientOverrides: { query: clientQuery, release: () => { released = true; } } });

    const out = await selfWikiWriteHandler(ctx, {
      slug: "pg-article", title: "PG", body_md: "Body", source_self_memory_ids: ["mem-1"],
    });

    assert.ok(text(out).includes("Created"));
    assert.ok(sourcesInserted);
    assert.ok(released);
  });

  test("rolls back and returns the error on failure", async () => {
    let rolledBack = false;
    const clientQuery = async (sql) => {
      if (sql === "BEGIN") return {};
      if (sql.includes("INSERT INTO self_wiki_articles")) throw new Error("constraint violation");
      if (sql === "ROLLBACK") { rolledBack = true; return {}; }
      return {};
    };
    const ctx = makePgCtx({ clientOverrides: { query: clientQuery } });

    const out = await selfWikiWriteHandler(ctx, { slug: "pg-fail", title: "T", body_md: "B" });
    assert.ok(text(out).includes("constraint violation"));
    assert.ok(rolledBack);
  });

  test("rejects missing source self-memory ids before opening a transaction", async () => {
    const ctx = makePgCtx({ getSelfById: async () => null });
    const out = await selfWikiWriteHandler(ctx, {
      slug: "pg-article", title: "T", body_md: "B", source_self_memory_ids: ["missing"],
    });
    assert.ok(text(out).includes("1 source self-memory id(s) not found"));
  });
});

// ─── selfWikiGetHandler ───────────────────────────────────────────────────────
describe("selfWikiGetHandler()", () => {
  const sampleArticle = {
    id: "art-1", slug: "my-article", title: "My Article", summary: "A summary",
    body_md: "## Content", tags: ["t"], status: "fresh", generated_by: "test",
    generated_at: "2026-06-01T12:00:00.000Z", revision: 2,
  };

  test("returns article content with metadata", async () => {
    const ctx = makeCtx({
      selfWikiOverrides: { get: async () => ({ ...sampleArticle, source_memory_ids: ["mem-1"] }) },
      getSelfById: async (id) => makeSelfMem(id, "Memory One"),
    });
    const out = await selfWikiGetHandler(ctx, { slug: "my-article" });
    const t = text(out);
    assert.ok(t.includes("🗂️ Self-wiki"));
    assert.ok(t.includes("My Article"));
    assert.ok(t.includes("> A summary"));
    assert.ok(t.includes("## Content"));
    assert.ok(t.includes("[[self-mem:mem-1]]"));
    assert.ok(t.includes("Memory One"));
  });

  test("returns error for a missing slug", async () => {
    const ctx = makeCtx({ selfWikiOverrides: { get: async () => null } });
    const out = await selfWikiGetHandler(ctx, { slug: "missing" });
    assert.ok(text(out).includes("No self-wiki article with slug"));
  });

  test("shows (none) when there are no sources", async () => {
    const ctx = makeCtx({ selfWikiOverrides: { get: async () => ({ ...sampleArticle, source_memory_ids: [] }) } });
    const out = await selfWikiGetHandler(ctx, { slug: "my-article" });
    assert.ok(text(out).includes("(none)"));
  });

  test("notes staleness and prompts a refresh instead of auto-regenerating", async () => {
    const ctx = makeCtx({
      selfWikiOverrides: { get: async () => ({ ...sampleArticle, status: "stale", source_memory_ids: [] }) },
    });
    const out = await selfWikiGetHandler(ctx, { slug: "my-article" });
    const t = text(out);
    assert.ok(t.includes("stale"));
    assert.ok(t.includes("call self_wiki_write again to refresh"));
  });
});
