// tests/lib/handlers/codegraph/codegraphHandlers.test.js
//
// Tests for all 7 codegraph handlers via the real pgBackend with a
// mock pool.query. pickBackend returns the real postgres backend when
// store.pool is present; we control what the backend returns by seeding
// pool.query responses.

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeCtx(poolQuery, overrides = {}) {
  return {
    store: {
      pool: {
        query: poolQuery ?? (async () => ({ rows: [], rowCount: 0 })),
        connect: overrides.poolConnect ?? (async () => ({
          query: overrides.clientQuery ?? (async () => ({ rows: [] })),
          release: () => {},
        })),
      },
    },
    generateEmbedding: overrides.generateEmbedding ?? (async () => [0.1]),
    vectorEnabled: overrides.vectorEnabled ?? (() => false),
  };
}

let cg;

before(async () => {
  cg = await import("../../../../lib/handlers/codegraph/codegraphHandlers.js");
});

// =============================================================================
// no backend
// =============================================================================
describe("no backend available", () => {
  for (const name of ["searchHandler", "reposHandler", "outlineHandler",
    "contextHandler", "callersHandler", "calleesHandler", "deleteRepoHandler"]) {
    test(`${name} returns NOT_AVAILABLE`, async () => {
      const result = await cg[name]({ store: {} }, {});
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes("codegraph requires"));
    });
  }
});

// =============================================================================
// searchHandler
// =============================================================================
describe("searchHandler", () => {
  test("returns search results as JSON", async () => {
    const ctx = makeCtx(async () => ({
      rows: [{
        qualified: "Math.add", kind: "function", name: "add",
        signature: "add(a,b)", start_line: 5, end_line: 8,
        path: "src/math.js", root_path: "/repo", score: 0.95,
      }], rowCount: 1,
    }));
    const result = await cg.searchHandler(ctx, { query: "add" });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.mode, "fulltext");
    assert.equal(parsed.matches[0].qualified, "Math.add");
  });

  test("returns empty matches gracefully", async () => {
    const ctx = makeCtx(async () => ({ rows: [], rowCount: 0 }));
    const result = await cg.searchHandler(ctx, { query: "zzz" });
    const parsed = JSON.parse(result.content[0].text);
    assert.deepEqual(parsed.matches, []);
  });

  test("wraps internal errors", async () => {
    const ctx = makeCtx(async () => { throw new Error("db timeout"); });
    const result = await cg.searchHandler(ctx, { query: "test" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("failed"));
  });
});

// =============================================================================
// reposHandler
// =============================================================================
describe("reposHandler", () => {
  test("returns repo list", async () => {
    const ctx = makeCtx(async () => ({
      rows: [{ id: 1, root_path: "/repo/a", last_indexed_at: null, files: 10, symbols: 5 }],
      rowCount: 1,
    }));
    const result = await cg.reposHandler(ctx);
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(parsed.repos));
    assert.equal(parsed.repos.length, 1);
  });

  test("returns empty array", async () => {
    const ctx = makeCtx(async () => ({ rows: [], rowCount: 0 }));
    const result = await cg.reposHandler(ctx);
    assert.deepEqual(JSON.parse(result.content[0].text), { repos: [] });
  });
});

// =============================================================================
// outlineHandler
// =============================================================================
describe("outlineHandler", () => {
  test("returns outline for a file", async () => {
    const ctx = makeCtx(async () => ({
      rows: [{
        kind: "function", name: "hello", qualified: "hello",
        start_line: 1, end_line: 5, signature: "hello()",
        root_path: "/repo",
      }], rowCount: 1,
    }));
    const result = await cg.outlineHandler(ctx, { path: "src/main.js" });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.path, "src/main.js");
    assert.equal(parsed.symbols[0].name, "hello");
  });
});

// =============================================================================
// contextHandler
// =============================================================================
describe("contextHandler", () => {
  test("returns no-symbol message", async () => {
    const ctx = makeCtx(async () => ({ rows: [], rowCount: 0 }));
    const result = await cg.contextHandler(ctx, { qualified: "nonexistent" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("No symbol matches"));
  });

  test("returns symbol info with source snippet", async () => {
    // The context function queries cg_symbols JOIN cg_files JOIN cg_repos
    const ctx = makeCtx(async (sql, params) => {
      if (sql.includes("cg_symbols")) {
        return { rows: [{
          qualified: "Math.add", kind: "function", name: "add",
          start_line: 1, end_line: 3, signature: "add(a,b)",
          doc: "Adds numbers",
          path: "src/math.js", root_path: "/repo",
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const result = await cg.contextHandler(ctx, { qualified: "Math.add" });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.qualified, "Math.add");
    assert.equal(parsed.kind, "function");
    // The source file doesn't exist on disk — handler falls back to
    // a file-not-found snippet
    assert.ok(parsed.source.includes("file not found"));
  });
});

// =============================================================================
// callersHandler
// =============================================================================
describe("callersHandler", () => {
  test("returns no-symbol message", async () => {
    const ctx = makeCtx(async () => ({ rows: [], rowCount: 0 }));
    const result = await cg.callersHandler(ctx, { qualified: "nonexistent" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("No symbol matches"));
  });

  test("returns callers list", async () => {
    // walkEdges queries cg_symbols first, then cg_edges
    let callCount = 0;
    const ctx = makeCtx(async (sql) => {
      callCount++;
      if (callCount === 1) {
        // Symbol lookup: cg_symbols WHERE qualified
        return { rows: [{ id: "sym-1" }], rowCount: 1 };
      }
      // Edges walk: cg_edges JOIN cg_symbols
      return { rows: [] }; // no callers found
    });
    const result = await cg.callersHandler(ctx, { qualified: "helper" });
    // When walkEdges returns an empty array, the handler treats it as
    // a valid result (not null), so callers is an empty array
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.qualified, "helper");
    assert.ok(Array.isArray(parsed.callers));
  });
});

// =============================================================================
// calleesHandler
// =============================================================================
describe("calleesHandler", () => {
  test("returns no-symbol message", async () => {
    const ctx = makeCtx(async () => ({ rows: [], rowCount: 0 }));
    const result = await cg.calleesHandler(ctx, { qualified: "nonexistent" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("No symbol matches"));
  });

  test("returns callees list", async () => {
    let callCount = 0;
    const ctx = makeCtx(async (sql) => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ id: "sym-2" }], rowCount: 1 };
      }
      return { rows: [] };
    });
    const result = await cg.calleesHandler(ctx, { qualified: "main" });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.qualified, "main");
    assert.ok(Array.isArray(parsed.callees));
  });
});

// =============================================================================
// deleteRepoHandler
// =============================================================================
describe("deleteRepoHandler", () => {
  test("returns error when path missing", async () => {
    const ctx = makeCtx();
    const result = await cg.deleteRepoHandler(ctx, {});
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("path is required"));
  });

  test("deletes repo", async () => {
    const ctx = makeCtx(async () => ({ rowCount: 1 }));
    const result = await cg.deleteRepoHandler(ctx, { path: "/repo" });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.deleted, true);
  });
});
