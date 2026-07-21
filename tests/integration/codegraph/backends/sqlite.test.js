// tests/lib/codegraph/backends/sqlite.test.js
//
// Tests for the SQLite codegraph backend. Creates a real better-sqlite3
// in-memory database with the required schema (cg_repos, cg_files,
// cg_symbols, cg_edges, cg_symbols_fts) so the backend functions operate
// against a real database.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "path";

// ─── Schema definitions ──────────────────────────────────────────────────
// Mirrors db/migrations-sqlite/002_settings.sql and 003_codegraph.sql.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cg_repos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    root_path       TEXT    NOT NULL UNIQUE,
    last_indexed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS cg_files (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id  INTEGER NOT NULL REFERENCES cg_repos(id) ON DELETE CASCADE,
    path     TEXT    NOT NULL,
    language TEXT,
    sha256   TEXT,
    mtime    TEXT,
    UNIQUE(repo_id, path)
  );

  CREATE TABLE IF NOT EXISTS cg_symbols (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id   INTEGER NOT NULL REFERENCES cg_files(id) ON DELETE CASCADE,
    kind      TEXT    NOT NULL,
    name      TEXT    NOT NULL,
    qualified TEXT    NOT NULL,
    start_line INTEGER,
    end_line   INTEGER,
    signature  TEXT,
    doc        TEXT
  );

  CREATE TABLE IF NOT EXISTS cg_edges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    src_symbol_id   INTEGER REFERENCES cg_symbols(id) ON DELETE CASCADE,
    dst_symbol_id   INTEGER,
    dst_unresolved  TEXT,
    kind            TEXT,
    src_line        INTEGER
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS cg_symbols_fts USING fts5(
    name, signature, doc,
    content='cg_symbols',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  -- Triggers to keep FTS in sync (simplified for testing)
  CREATE TRIGGER IF NOT EXISTS cg_symbols_ai AFTER INSERT ON cg_symbols BEGIN
    INSERT INTO cg_symbols_fts (rowid, name, signature, doc)
    VALUES (new.id, new.name, new.signature, new.doc);
  END;

  CREATE TRIGGER IF NOT EXISTS cg_symbols_ad AFTER DELETE ON cg_symbols BEGIN
    INSERT INTO cg_symbols_fts (cg_symbols_fts, rowid, name, signature, doc)
    VALUES ('delete', old.id, old.name, old.signature, old.doc);
  END;

  CREATE TRIGGER IF NOT EXISTS cg_symbols_au AFTER UPDATE ON cg_symbols BEGIN
    INSERT INTO cg_symbols_fts (cg_symbols_fts, rowid, name, signature, doc)
    VALUES ('delete', old.id, old.name, old.signature, old.doc);
    INSERT INTO cg_symbols_fts (rowid, name, signature, doc)
    VALUES (new.id, new.name, new.signature, new.doc);
  END;
`;

// ─── Test helpers ────────────────────────────────────────────────────────

function createDb() {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

// ─── Dynamic import ──────────────────────────────────────────────────────

let sqliteBackend;

before(async () => {
  const mod = await import("../../../../lib/codegraph/backends/sqlite.js");
  sqliteBackend = mod;
});

// =============================================================================
// repos
// =============================================================================
describe("repos()", () => {
  test("returns empty list when no repos exist", async () => {
    const store = { db: createDb() };
    const result = await sqliteBackend.repos(store);
    assert.deepEqual(result.repos, []);
  });

  test("returns indexed repos with file/symbol counts", async () => {
    const store = { db: createDb() };
    const db = store.db;

    db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo/a");
    db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo/b");

    const result = await sqliteBackend.repos(store);
    assert.equal(result.repos.length, 2);
    assert.ok(result.repos.some(r => r.root_path === "/repo/a"));
  });
});

// =============================================================================
// indexRepoFiles — empty-folder cleanup
// =============================================================================
describe("indexRepoFiles()", () => {
  test("a folder with zero indexable code files leaves no repo row", async () => {
    const store = { db: createDb() };
    async function* noFiles() {}
    const counts = await sqliteBackend.indexRepoFiles(store, "/docs-only", noFiles(), {
      generateEmbedding: async () => null,
    });
    assert.equal(counts.files, 0);
    const repo = store.db.prepare(`SELECT id FROM cg_repos WHERE root_path = ?`).get("/docs-only");
    assert.equal(repo, undefined, "empty repo row should be dropped, not left to clutter the panel");
  });
});

// =============================================================================
// deleteRepo
// =============================================================================
describe("deleteRepo()", () => {
  test("returns deleted:false when repo does not exist", async () => {
    const store = { db: createDb() };
    const result = await sqliteBackend.deleteRepo(store, "/nonexistent");
    assert.equal(result.deleted, false);
  });

  test("deletes existing repo", async () => {
    const store = { db: createDb() };
    store.db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo/x");
    const result = await sqliteBackend.deleteRepo(store, "/repo/x");
    assert.equal(result.deleted, true);
    const count = store.db.prepare(`SELECT COUNT(*) AS c FROM cg_repos`).get();
    assert.equal(count.c, 0);
  });
});

// =============================================================================
// outline
// =============================================================================
describe("outline()", () => {
  test("returns empty symbols for nonexistent file", async () => {
    const store = { db: createDb() };
    const result = await sqliteBackend.outline(store, { path: "no_file.js" });
    assert.deepEqual(result.symbols, []);
  });

  test("returns symbols for a file", async () => {
    const store = { db: createDb() };
    const db = store.db;
    const repoInfo = db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo");
    const repoId = Number(repoInfo.lastInsertRowid);
    const fileInfo = db.prepare(`INSERT INTO cg_files (repo_id, path, language) VALUES (?, ?, ?)`).run(repoId, "src/main.js", "js");
    const fileId = Number(fileInfo.lastInsertRowid);
    db.prepare(`INSERT INTO cg_symbols (file_id, kind, name, qualified, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(fileId, "function", "hello", "src/main.js::hello", 1, 3);

    const result = await sqliteBackend.outline(store, { path: "src/main.js" });
    assert.equal(result.symbols.length, 1);
    assert.equal(result.symbols[0].name, "hello");
    assert.equal(result.symbols[0].kind, "function");
  });

  test("supports repo filter", async () => {
    const store = { db: createDb() };
    const db = store.db;
    const repoInfo = db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo/main");
    const repoId = Number(repoInfo.lastInsertRowid);
    const fileInfo = db.prepare(`INSERT INTO cg_files (repo_id, path) VALUES (?, ?)`).run(repoId, "util.js");
    const fileId = Number(fileInfo.lastInsertRowid);
    db.prepare(`INSERT INTO cg_symbols (file_id, kind, name, qualified) VALUES (?, ?, ?, ?)`)
      .run(fileId, "function", "util", "util.js::util");

    const result = await sqliteBackend.outline(store, { path: "util.js", repo: "/repo/main" });
    assert.equal(result.symbols.length, 1);
  });
});

// =============================================================================
// context
// =============================================================================
describe("context()", () => {
  test("returns null for nonexistent symbol", async () => {
    const store = { db: createDb() };
    const result = await sqliteBackend.context(store, { qualified: "nonexistent" });
    assert.equal(result, null);
  });

  test("returns symbol details", async () => {
    const store = { db: createDb() };
    const db = store.db;
    const repoInfo = db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo");
    const repoId = Number(repoInfo.lastInsertRowid);
    const fileInfo = db.prepare(`INSERT INTO cg_files (repo_id, path) VALUES (?, ?)`).run(repoId, "src/calc.js");
    const fileId = Number(fileInfo.lastInsertRowid);
    db.prepare(`INSERT INTO cg_symbols (file_id, kind, name, qualified, start_line, end_line, signature, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(fileId, "function", "add", "src/calc.js::add", 1, 3, "add(a, b)", "Adds two numbers");

    const result = await sqliteBackend.context(store, { qualified: "src/calc.js::add" });
    assert.ok(result, "should find symbol");
    assert.equal(result.name, "add");
    assert.equal(result.kind, "function");
    assert.equal(result.signature, "add(a, b)");
    assert.equal(result.doc, "Adds two numbers");
    assert.equal(result.path, "src/calc.js");
  });
});

// =============================================================================
// search (FTS-only path — no vector)
// =============================================================================
describe("search() — FTS-only", () => {
  test("returns empty matches for nonexistent query", async () => {
    const store = { db: createDb() };
    const result = await sqliteBackend.search(store,
      { query: "zzz_nonexistent", limit: 10 },
      { generateEmbedding: async () => null, vectorEnabled: () => false }
    );
    assert.deepEqual(result.matches, []);
    assert.equal(result.mode, "fulltext");
  });

  test("returns FTS matches for a query", async () => {
    const store = { db: createDb() };
    const db = store.db;
    const repoInfo = db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo");
    const repoId = Number(repoInfo.lastInsertRowid);
    const fileInfo = db.prepare(`INSERT INTO cg_files (repo_id, path, language) VALUES (?, ?, ?)`).run(repoId, "src/greet.js", "js");
    const fileId = Number(fileInfo.lastInsertRowid);
    db.prepare(`INSERT INTO cg_symbols (file_id, kind, name, qualified, start_line, end_line, signature, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(fileId, "function", "greet", "src/greet.js::greet", 1, 3, "greet(name)", "Greets a user by name");

    // FTS trigger auto-populates cg_symbols_fts from the INSERT

    const result = await sqliteBackend.search(store,
      { query: "greet", limit: 10 },
      { generateEmbedding: async () => null, vectorEnabled: () => false }
    );
    assert.ok(result.matches.length >= 1, "should find greet symbol");
    assert.equal(result.matches[0].name, "greet");
    assert.equal(result.mode, "fulltext");
  });

  test("filters by kind", async () => {
    const store = { db: createDb() };
    const db = store.db;
    const repoInfo = db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo");
    const repoId = Number(repoInfo.lastInsertRowid);
    const fileInfo = db.prepare(`INSERT INTO cg_files (repo_id, path) VALUES (?, ?)`).run(repoId, "test.js");
    const fileId = Number(fileInfo.lastInsertRowid);
    db.prepare(`INSERT INTO cg_symbols (file_id, kind, name, qualified) VALUES (?, ?, ?, ?)`)
      .run(fileId, "function", "funcA", "test.js::funcA");
    db.prepare(`INSERT INTO cg_symbols (file_id, kind, name, qualified) VALUES (?, ?, ?, ?)`)
      .run(fileId, "class", "ClassB", "test.js::ClassB");

    const result = await sqliteBackend.search(store,
      { query: "funcA", kind: "function", limit: 10 },
      { generateEmbedding: async () => null, vectorEnabled: () => false }
    );
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].name, "funcA");
  });
});

// =============================================================================
// removeOneFile
// =============================================================================
describe("removeOneFile()", () => {
  test("returns removed:false when repo does not exist", async () => {
    const store = { db: createDb() };
    const result = await sqliteBackend.removeOneFile(store, "/nonexistent", "file.js");
    assert.deepEqual(result, { removed: false });
  });

  test("removes a file from an existing repo", async () => {
    const store = { db: createDb() };
    const db = store.db;
    const repoInfo = db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo");
    const repoId = Number(repoInfo.lastInsertRowid);
    db.prepare(`INSERT INTO cg_files (repo_id, path) VALUES (?, ?)`).run(repoId, "old.js");

    const result = await sqliteBackend.removeOneFile(store, "/repo", "old.js");
    assert.equal(result.removed, true);

    const count = db.prepare(`SELECT COUNT(*) AS c FROM cg_files WHERE repo_id = ?`).get(repoId);
    assert.equal(count.c, 0);
  });

  test("returns removed:false when file does not exist", async () => {
    const store = { db: createDb() };
    const db = store.db;
    const repoInfo = db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo");
    const repoId = Number(repoInfo.lastInsertRowid);

    const result = await sqliteBackend.removeOneFile(store, "/repo", "no_file.js");
    assert.equal(result.removed, false);
  });
});

// =============================================================================
// sweepMissingFiles
// =============================================================================
describe("sweepMissingFiles()", () => {
  test("returns removed:0 when repo does not exist", async () => {
    const store = { db: createDb() };
    const result = await sqliteBackend.sweepMissingFiles(store, "/nonexistent", async () => {});
    assert.deepEqual(result, { removed: 0 });
  });

  test("removes files that no longer exist on disk", async () => {
    const store = { db: createDb() };
    const db = store.db;
    const repoInfo = db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo");
    const repoId = Number(repoInfo.lastInsertRowid);
    const fileInfo = db.prepare(`INSERT INTO cg_files (repo_id, path) VALUES (?, ?)`).run(repoId, "gone.ts");
    const fileId = Number(fileInfo.lastInsertRowid);
    db.prepare(`INSERT INTO cg_symbols (file_id, kind, name, qualified) VALUES (?, ?, ?, ?)`)
      .run(fileId, "class", "Gone", "gone.ts::Gone");

    // statFn throws for this file — simulates file gone from disk
    const statFn = async () => { throw new Error("ENOENT"); };

    const result = await sqliteBackend.sweepMissingFiles(store, "/repo", statFn);
    assert.equal(result.removed, 1);

    const count = db.prepare(`SELECT COUNT(*) AS c FROM cg_files`).get();
    assert.equal(count.c, 0, "file should be removed from DB");
  });
});

// =============================================================================
// callers / callees
// =============================================================================
describe("callers() / callees()", () => {
  test("callers returns null for nonexistent symbol", async () => {
    const store = { db: createDb() };
    const result = await sqliteBackend.callers(store, { qualified: "no.sym" });
    assert.equal(result, null);
  });

  test("callees returns null for nonexistent symbol", async () => {
    const store = { db: createDb() };
    const result = await sqliteBackend.callees(store, { qualified: "no.sym" });
    assert.equal(result, null);
  });

  test("returns callers for a symbol", async () => {
    const store = { db: createDb() };
    const db = store.db;
    const repoInfo = db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run("/repo");
    const repoId = Number(repoInfo.lastInsertRowid);
    const fileInfo = db.prepare(`INSERT INTO cg_files (repo_id, path) VALUES (?, ?)`).run(repoId, "main.js");
    const fileId = Number(fileInfo.lastInsertRowid);
    db.prepare(`INSERT INTO cg_symbols (file_id, kind, name, qualified) VALUES (?, ?, ?, ?)`)
      .run(fileId, "function", "caller1", "main.js::caller1");
    db.prepare(`INSERT INTO cg_symbols (file_id, kind, name, qualified) VALUES (?, ?, ?, ?)`)
      .run(fileId, "function", "helper", "main.js::helper");

    // Add a call edge: caller1 → helper
    const helper = db.prepare(`SELECT id FROM cg_symbols WHERE qualified = ?`).get("main.js::helper");
    const caller1 = db.prepare(`SELECT id FROM cg_symbols WHERE qualified = ?`).get("main.js::caller1");
    db.prepare(`INSERT INTO cg_edges (src_symbol_id, dst_symbol_id, dst_unresolved, kind, src_line) VALUES (?, ?, NULL, ?, ?)`)
      .run(caller1.id, caller1.id, "calls", 1);
    // Re-insert with correct dst
    db.prepare(`DELETE FROM cg_edges`);
    db.prepare(`INSERT INTO cg_edges (src_symbol_id, dst_symbol_id, dst_unresolved, kind, src_line) VALUES (?, ?, NULL, ?, ?)`)
      .run(caller1.id, helper.id, "calls", 3);

    const result = await sqliteBackend.callers(store, { qualified: "main.js::helper" });
    assert.ok(Array.isArray(result), "should return an array");
    assert.ok(result.length >= 1, "should have at least one caller");
    assert.equal(result[0].qualified, "main.js::caller1");
  });
});
