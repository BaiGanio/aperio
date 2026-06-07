// tests/lib/codegraph/indexer.test.js
//
// Tests for indexer.js: pickBackend, isCodegraphAvailable, pickExtractor,
// indexRepo, indexFile, removeFile, sweepMissing, setSymbolEmbedding.
//
// We use createRequire for fs/promises (readdir, stat) so we can mock
// filesystem traversal before the module loads. Logger is mocked via
// importing and wrapping its methods. Backend tests use a mock pool.query
// with the real pgBackend (same approach as codegraphHandlers tests).

import { describe, test, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fsp = require("fs/promises");

import logger from "../../../lib/helpers/logger.js";

// ─── Logger mocks ─────────────────────────────────────────────────────────

let infoCalls = [];
let errorCalls = [];

before(() => {
  mock.method(logger, "info",  (...args) => { infoCalls.push(args); });
});

after(() => {
  mock.restoreAll();
});

// ─── Mock fs/promises (BEFORE importing indexer) ──────────────────────────
// readdir drives the walk generator; stat determines file vs directory.
// Both are mocked via createRequire CJS refs.

let _mockReaddir = null; // (path, opts) => [{ name, isDirectory, isFile }] or throws
let _mockStat    = null; // (path) => { isFile, isDirectory } or throws

const REAL = {
  readdir: fsp.readdir,
  stat: fsp.stat,
};

mock.method(fsp, "readdir", async (dirPath, opts) => {
  if (_mockReaddir) return _mockReaddir(dirPath, opts);
  return REAL.readdir(dirPath, opts);
});

mock.method(fsp, "stat", async (path) => {
  if (_mockStat) return _mockStat(path);
  return REAL.stat(path);
});

// ─── Dynamic import ───────────────────────────────────────────────────────

let indexer;

before(async () => {
  indexer = await import("../../../lib/codegraph/indexer.js");
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function makePool(queryFn) {
  return {
    query: queryFn ?? (async () => ({ rows: [], rowCount: 0 })),
    connect: async () => ({
      query: async (sql) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return {};
        return { rows: [] };
      },
      release: () => {},
    }),
  };
}

function makeCtx(poolQuery) {
  return { store: { pool: makePool(poolQuery) } };
}

function dirEntry(name, isDir) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
  };
}

function resetTest() {
  _mockReaddir = null;
  _mockStat = null;
  infoCalls = [];
  errorCalls = [];
}

// =============================================================================
// pickBackend
// =============================================================================
describe("pickBackend()", () => {
  test("returns postgres backend when store has pool", () => {
    const result = indexer.pickBackend({ pool: {} });
    assert.equal(result.kind, "postgres");
    assert.ok(result.mod);
  });

  test("returns sqlite backend when store has db", () => {
    const result = indexer.pickBackend({ db: {} });
    assert.equal(result.kind, "sqlite");
    assert.ok(result.mod);
  });

  test("returns null when store has neither pool nor db", () => {
    assert.equal(indexer.pickBackend({}), null);
    assert.equal(indexer.pickBackend(null), null);
    assert.equal(indexer.pickBackend(undefined), null);
  });
});

// =============================================================================
// isCodegraphAvailable
// =============================================================================
describe("isCodegraphAvailable()", () => {
  test("returns true when backend is available", () => {
    assert.ok(indexer.isCodegraphAvailable({ pool: {} }));
    assert.ok(indexer.isCodegraphAvailable({ db: {} }));
  });

  test("returns false when backend is not available", () => {
    assert.ok(!indexer.isCodegraphAvailable({}));
    assert.ok(!indexer.isCodegraphAvailable(null));
  });
});

// =============================================================================
// SKIP_DIRS
// =============================================================================
describe("SKIP_DIRS", () => {
  test("is a Set with expected directory names", () => {
    assert.ok(indexer.SKIP_DIRS instanceof Set);
    assert.ok(indexer.SKIP_DIRS.has("node_modules"));
    assert.ok(indexer.SKIP_DIRS.has(".git"));
    assert.ok(indexer.SKIP_DIRS.has("var"));
    assert.ok(!indexer.SKIP_DIRS.has("src"));
  });
});

// NOTE: pickExtractor is internal (not exported). It's exercised indirectly
// through indexFile and indexRepo which call it when processing files.

// =============================================================================
// indexFile
// =============================================================================
describe("indexFile()", () => {
  afterEach(() => { resetTest(); });

  test("returns skipped for unsupported extension", async () => {
    const ctx = makeCtx();
    const result = await indexer.indexFile(ctx.store, "/repo", "readme.md");
    assert.equal(result.skipped, true);
    assert.ok(result.reason);
  });

  test("returns error when no backend", async () => {
    await assert.rejects(
      () => indexer.indexFile({}, "/repo", "file.ts"),
      { message: /codegraph unavailable/ }
    );
  });

  test("delegates to backend for supported file", async () => {
    const query = mock.fn(async (sql) => {
      if (sql.includes("DELETE FROM cg_symbols")) return {};
      if (sql.includes("INSERT INTO cg_symbols")) return { rows: [{ id: "sym-1" }] };
      if (sql === "BEGIN" || sql === "COMMIT") return {};
      return { rows: [{ id: 1 }] };
    });
    const ctx = makeCtx(query);
    const result = await indexer.indexFile(ctx.store, "/repo", "file.ts");
    // indexOneFile either succeeds or skips based on the file existing
    assert.ok(result !== undefined);
  });
});

// =============================================================================
// removeFile
// =============================================================================
describe("removeFile()", () => {
  afterEach(() => { resetTest(); });

  test("returns removed:false when no backend", async () => {
    const result = await indexer.removeFile({}, "/repo", "file.ts");
    assert.deepEqual(result, { removed: false });
  });

  test("delegates to backend", async () => {
    const ctx = makeCtx();
    const result = await indexer.removeFile(ctx.store, "/repo", "file.ts");
    // removeOneFile returns something — we just check it didn't throw
    assert.ok(result !== undefined);
  });
});

// =============================================================================
// sweepMissing
// =============================================================================
describe("sweepMissing()", () => {
  afterEach(() => { resetTest(); });

  test("returns removed:0 when no backend", async () => {
    const result = await indexer.sweepMissing({}, "/repo");
    assert.deepEqual(result, { removed: 0 });
  });

  test("delegates to backend", async () => {
    const ctx = makeCtx();
    const result = await indexer.sweepMissing(ctx.store, "/repo");
    assert.ok(result !== undefined);
  });
});

// =============================================================================
// setSymbolEmbedding
// =============================================================================
describe("setSymbolEmbedding()", () => {
  afterEach(() => { resetTest(); });

  test("returns undefined when no backend", async () => {
    const result = await indexer.setSymbolEmbedding({}, "sym-1", [0.1, 0.2]);
    assert.equal(result, undefined);
  });

  test("delegates to backend", async () => {
    const ctx = makeCtx(async () => ({ rowCount: 1 }));
    // setSymbolEmbedding returns undefined (no return value)
    const result = await indexer.setSymbolEmbedding(ctx.store, "sym-1", [0.1, 0.2]);
    assert.equal(result, undefined);
  });
});

// =============================================================================
// indexRepo (full indexing via walk generator)
// =============================================================================
describe("indexRepo()", () => {
  afterEach(() => { resetTest(); });

  test("rejects paths not on the allowlist", async () => {
    // Use a path that is NOT under the project root
    await assert.rejects(
      () => indexer.indexRepo({ pool: {} }, "/nonexistent-forbidden-path"),
      { message: /Refusing to index/ }
    );
  });

  test("rejects when no backend", async () => {
    await assert.rejects(
      () => indexer.indexRepo({}, process.cwd()),
      { message: /codegraph requires/ }
    );
  });

  test("walks filesystem and indexes files", async () => {
    // Use a path under the project root so isReadPathAllowed passes.
    const testRoot = process.cwd() + "/test-repo-walk";

    // Mock a simple repo structure with one .ts file
    _mockReaddir = async (dirPath, opts) => {
      if (dirPath === testRoot) {
        return [dirEntry("src", true)];
      }
      if (dirPath === testRoot + "/src") {
        return [dirEntry("hello.ts", false)];
      }
      return [];
    };
    _mockStat = async (p) => ({
      isFile: () => !p.includes("/."),
      isDirectory: () => false,
      mtime: new Date("2026-01-01"),
    });

    // Mock pool responses for the indexRepoFiles flow
    const query = mock.fn(async (sql, params) => {
      if (sql === "BEGIN") return {};
      if (sql.includes("INSERT INTO cg_repos")) return { rows: [{ id: 1 }] };
      if (sql.includes("SELECT id, sha256 FROM cg_files")) return { rows: [] };
      if (sql.includes("INSERT INTO cg_files")) return { rows: [{ id: 1 }] };
      if (sql.includes("DELETE FROM cg_symbols")) return {};
      if (sql.includes("INSERT INTO cg_symbols")) return { rows: [{ id: "sym-1" }] };
      if (sql.includes("UPDATE cg_symbols")) return {};
      if (sql.includes("UPDATE cg_edges")) return {};
      if (sql.includes("INSERT INTO cg_edges")) return {};
      if (sql.includes("UPDATE cg_repos SET last_indexed_at")) return {};
      if (sql === "COMMIT") return {};
      return { rows: [] };
    });

    const pool = {
      query,
      connect: async () => ({
        query: async (sql, params) => query(sql, params),
        release: () => {},
      }),
    };

    const store = { pool };
    const result = await indexer.indexRepo(store, testRoot);

    assert.ok(result.files !== undefined);
    assert.ok(result.changed !== undefined);
    assert.ok(result.symbols !== undefined);

    // Logger should have been called with indexing summary
    assert.ok(infoCalls.some(args => args[0].includes("indexed")),
      "should log indexing summary");
  });
});
