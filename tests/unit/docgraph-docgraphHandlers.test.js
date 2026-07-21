// tests/lib/handlers/docgraph/docgraphHandlers.test.js
// Tests for document graph MCP/HTTP handlers.
//
// Handlers wrap backend functions from pickBackend(ctx.store) which checks
// for store.pool (postgres) or store.db (sqlite). We provide a mock pool
// so the real postgres backend functions execute against controlled data.

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";

import logger from "../../../../lib/helpers/logger.js";
import {
  searchHandler,
  reposHandler,
  outlineHandler,
  contextHandler,
  refsHandler,
  deleteRepoHandler,
} from "../../../../lib/handlers/docgraph/docgraphHandlers.js";

// ─── Mock pool — routes SQL content to controlled rows ──────────────────────

function mockPool(routeMap) {
  const routes = Object.entries(routeMap);
  return {
    query: async (sql, params) => {
      for (const [pattern, rows] of routes) {
        if (sql.includes(pattern)) return { rows, rowCount: rows.length };
      }
      // Default: empty rows
      return { rows: [], rowCount: 0 };
    },
  };
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

before(() => {
  mock.method(logger, "error", () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "info",  () => {});
  mock.method(logger, "debug", () => {});
});

after(() => mock.restoreAll());

// ─── Mock ctx factory ────────────────────────────────────────────────────────

function makeCtx(withPool = false, poolRoutes = {}) {
  return {
    store: withPool ? { pool: mockPool(poolRoutes) } : {},
    generateEmbedding: async (text) => new Array(1024).fill(0.01),
    vectorEnabled: () => false, // fulltext only for tests
  };
}

// Convenience: expect the handler result is an error
function isError(result) {
  return result.isError === true || result.content?.[0]?.text?.startsWith("❌");
}

// =============================================================================
// searchHandler
// =============================================================================

describe("searchHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await searchHandler(makeCtx(false), { query: "test" });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("returns results when backend succeeds", async () => {
    const ctx = makeCtx(true, {
      "docgraph_repos WHERE root_path": [],
      "FROM docgraph_chunks": [
        { chunk_id: 1, section_id: 10, chunk_text: "Budget document text", heading: "Budget", level: 1, rel_path: "budget.md", title: "Budget", mime: "text/markdown", root_path: "/repo", score: 0.85 },
      ],
    });
    const result = await searchHandler(ctx, { query: "budget" });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.matches.length, 1);
    assert.strictEqual(payload.matches[0].document.title, "Budget");
    assert.strictEqual(payload.matches[0].score, 0.85);
  });

  test("returns error when backend throws", async () => {
    const pool = { query: async () => { throw new Error("pg down"); } };
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await searchHandler(ctx, { query: "test" });
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("pg down"));
  });
});

// =============================================================================
// reposHandler
// =============================================================================

describe("reposHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await reposHandler(makeCtx(false));
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("returns repo list when backend succeeds", async () => {
    let callIndex = 0;
    const pool = {
      query: async (sql) => {
        callIndex++;
        if (callIndex === 1) return { rows: [{ id: 1, root_path: "/repo/a", last_indexed_at: "2026-06-01T00:00:00Z", docs: 2, chunks: 5, by_mime_raw: {} }], rowCount: 1 };
        if (callIndex === 2) return { rows: [{ mime: "text/markdown", n: 2 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await reposHandler(ctx);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.repos.length, 1);
    assert.strictEqual(payload.repos[0].root_path, "/repo/a");
  });

  test("returns error when backend throws", async () => {
    const pool = { query: async () => { throw new Error("db error"); } };
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await reposHandler(ctx);
    assert.ok(isError(result));
  });
});

// =============================================================================
// outlineHandler
// =============================================================================

describe("outlineHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await outlineHandler(makeCtx(false), { path: "doc.md" });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("returns outline when document found", async () => {
    // outline with no folder skips resolveRepoId; only 2 queries run.
    const pool = mockPool({
      "JOIN docgraph_repos": [{ id: 1, title: "Budget", mime: "text/markdown", summary: "Q3", root_path: "/repo" }],
      "FROM docgraph_sections": [{ id: 10, parent_id: null, ord: 1, level: 1, heading: "Q3 Budget", chunks: 2 }],
    });
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await outlineHandler(ctx, { path: "budget.md" });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.title, "Budget");
    assert.strictEqual(payload.sections.length, 1);
  });

  test("returns error when document not found", async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await outlineHandler(ctx, { path: "missing.md" });
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("No indexed document"));
  });
});

// =============================================================================
// contextHandler
// =============================================================================

describe("contextHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await contextHandler(makeCtx(false), { chunk_id: 5 });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("returns chunk context when found", async () => {
    const pool = mockPool({
      "docgraph_chunks c": [{ text: "Chunk text content", ord: 0, heading: "Section 1", rel_path: "doc.md", root_path: "/repo" }],
    });
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await contextHandler(ctx, { chunk_id: 5 });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.text, "Chunk text content");
    assert.strictEqual(payload.heading, "Section 1");
  });

  test("returns error when chunk not found", async () => {
    const pool = mockPool({});
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await contextHandler(ctx, { chunk_id: 999 });
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("chunk_id=999"));
  });
});

// =============================================================================
// refsHandler
// =============================================================================

describe("refsHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await refsHandler(makeCtx(false), { ref: "https://example.com" });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("returns ref matches when found", async () => {
    // refs with no folder skips resolveRepoId; only 1 query runs.
    const pool = mockPool({
      "FROM docgraph_refs": [{ kind: "url", value: "https://example.com", section_id: 10, heading: "Links", rel_path: "doc.md", title: "Doc", mime: "text/markdown", root_path: "/repo" }],
    });
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await refsHandler(ctx, { ref: "https://example.com" });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.ref, "https://example.com");
    assert.strictEqual(payload.matches.length, 1);
  });

  test("returns userFacing error when ref is missing", async () => {
    const pool = mockPool({});
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await refsHandler(ctx, {});
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("ref is required"));
  });
});

// =============================================================================
// deleteRepoHandler
// =============================================================================

describe("deleteRepoHandler", () => {
  test("returns NOT_AVAILABLE when no backend", async () => {
    const result = await deleteRepoHandler(makeCtx(false), { path: "/repo" });
    assert.strictEqual(result.isError, true);
    assert.ok(result.content[0].text.includes("Postgres") || result.content[0].text.includes("SQLite"));
  });

  test("deletes repo when path provided", async () => {
    const pool = mockPool({
      "DELETE FROM docgraph_repos": [],
    });
    // Need rowCount > 0 for deleted: true. Override the default mock.
    pool.query = async () => ({ rows: [], rowCount: 1 });
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await deleteRepoHandler(ctx, { path: "/repo/a" });
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.deleted, true);
  });

  test("returns userFacing error when path is missing", async () => {
    const pool = mockPool({});
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await deleteRepoHandler(ctx, {});
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("path is required"));
  });

  test("returns error when backend throws", async () => {
    const pool = { query: async () => { throw new Error("delete failed"); } };
    const ctx = { store: { pool }, generateEmbedding: async () => null, vectorEnabled: () => false };
    const result = await deleteRepoHandler(ctx, { path: "/repo" });
    assert.ok(isError(result));
    assert.ok(result.content[0].text.includes("delete failed"));
  });
});
