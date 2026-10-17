// tests/lib/docgraph/backends/postgres.test.js
// Tests for the Postgres docgraph backend.
//
// All read-side functions (search, outline, context, repos, refs, deleteRepo,
// removeOneFile, sweepMissingFiles, setChunkEmbedding) are tested with a
// mock pool that returns controlled rows. The indexer functions
// (indexOneFile, indexRepoFiles) are tested via their "file gone" error path
// since they call readFile/stat from fs/promises (module-level imports).

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ─── Mock pool factory ──────────────────────────────────────────────────────

function makePool(rowsFns) {
  // rowsFns is called with (sql, params) and returns the rows for that query.
  // Default: empty rows.
  const fn = typeof rowsFns === "function" ? rowsFns : () => rowsFns ?? [];
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      const rows = await fn(sql, params);
      return { rows, rowCount: rows.length };
    },
    connect: async () => mockClient(calls, fn),
    _calls: calls,
  };
  return pool;
}

function mockClient(calls, rowsFn) {
  return {
    query: async (sql, params) => {
      calls.push({ sql, params });
      const rows = await rowsFn(sql, params);
      return { rows, rowCount: rows.length };
    },
    release: () => {},
  };
}

function makeStore(rowsFns) {
  const pool = makePool(rowsFns);
  return { pool, _calls: pool._calls };
}

// ─── Dynamic import of the backend ──────────────────────────────────────────

let pg;

before(async () => {
  pg = await import("../../../../lib/docgraph/backends/postgres.js");
});

// =============================================================================
// search
// =============================================================================

describe("search", () => {
  test("fulltext mode when vector is disabled", async () => {
    const store = makeStore(() => [
      { chunk_id: 1, section_id: 10, chunk_text: "Budget overview for Q3", heading: "Budget", level: 1, rel_path: "budget.md", title: "Budget", mime: "text/markdown", root_path: "/repo", score: 0.8 },
    ]);
    const result = await pg.search(store, { query: "budget" }, { vectorEnabled: () => false });
    assert.strictEqual(result.mode, "fulltext");
    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].document.title, "Budget");
    assert.strictEqual(result.matches[0].score, 0.8);
    // Verify the fulltext SQL was sent (to_tsvector used, no vector operator)
    assert.ok(store._calls.length > 0, "pool.query was called");
    const sql = store._calls.map((c) => c.sql).join(" ");
    assert.ok(sql.includes("to_tsvector"), "fulltext query uses tsvector");
    assert.ok(!sql.includes("<=>"), "fulltext query has no vector similarity operator");
  });

  test("hybrid mode when vector is enabled and embedding succeeds", async () => {
    let callCount = 0;
    const store = makeStore(() => {
      callCount++;
      // embedInline calls generateEmbedding then a query — we need to handle
      // the specific query that search sends.
      return [
        { chunk_id: 2, section_id: 20, chunk_text: "Vector embeddings are useful", heading: "Embeddings", level: 2, rel_path: "notes.md", title: "Notes", mime: "text/markdown", root_path: "/repo", score: 0.92 },
      ];
    });
    const result = await pg.search(store, { query: "vector embeddings" }, {
      vectorEnabled: () => true,
      generateEmbedding: async () => new Array(1024).fill(0.1),
    });
    assert.strictEqual(result.mode, "hybrid");
    assert.strictEqual(result.matches.length, 1);
  });

  test("filters by folder (repoId)", async () => {
    const store = makeStore((sql) => {
      // resolveRepoId query
      if (sql.includes("docgraph_repos WHERE root_path")) return [{ id: 42 }];
      // Search query
      return [
        { chunk_id: 3, section_id: 30, chunk_text: "Marketing spend", heading: "Marketing", level: 2, rel_path: "budget.md", title: "Budget", mime: "text/markdown", root_path: "/projects/foo", score: 0.75 },
      ];
    });
    const result = await pg.search(store, { query: "marketing", folder: "/projects/foo" }, { vectorEnabled: () => false });
    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].document.root_path, "/projects/foo");
  });

  test("filters by mime type", async () => {
    const store = makeStore(() => [
      { chunk_id: 4, section_id: 40, chunk_text: "Only plain text", heading: null, level: 1, rel_path: "readme.txt", title: "Readme", mime: "text/plain", root_path: "/repo", score: 0.5 },
    ]);
    const result = await pg.search(store, { query: "text", mime: "text/plain" }, { vectorEnabled: () => false });
    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].document.mime, "text/plain");
  });

  test("returns empty matches when no results", async () => {
    const store = makeStore(() => []);
    const result = await pg.search(store, { query: "nonexistent" }, { vectorEnabled: () => false });
    assert.strictEqual(result.matches.length, 0);
  });

  test("throws userFacing error for ambiguous folder", async () => {
    const store = makeStore((sql) => {
      if (sql.includes("ILIKE")) return [{ id: 1, root_path: "/a" }, { id: 2, root_path: "/b" }];
      return [];
    });
    await assert.rejects(
      () => pg.search(store, { query: "test", folder: "am" }, { vectorEnabled: () => false }),
      (err) => err.userFacing === true && err.message.includes("Ambiguous folder"),
    );
  });
});

// =============================================================================
// outline
// =============================================================================

describe("outline", () => {
  test("returns document outline with sections", async () => {
    let callIdx = 0;
    const store = makeStore((sql) => {
      callIdx++;
      if (callIdx === 1) return [{ id: 1, title: "Budget", mime: "text/markdown", summary: "Q3 plan", root_path: "/repo" }];
      return [
        { id: 10, parent_id: null, ord: 1, level: 1, heading: "Q3 Budget", chunks: 2 },
        { id: 11, parent_id: 10, ord: 2, level: 2, heading: "Marketing", chunks: 1 },
      ];
    });
    const result = await pg.outline(store, { path: "budget.md" });
    assert.strictEqual(result.title, "Budget");
    assert.strictEqual(result.sections.length, 2);
    assert.strictEqual(result.sections[0].heading, "Q3 Budget");
    assert.strictEqual(result.sections[1].heading, "Marketing");
  });

  test("returns null when document not found", async () => {
    const store = makeStore(() => []);
    const result = await pg.outline(store, { path: "missing.md" });
    assert.strictEqual(result, null);
  });

  test("accepts folder filter", async () => {
    let callIdx = 0;
    const store = makeStore((sql) => {
      callIdx++;
      if (callIdx === 1) return [{ id: 42 }]; // resolveRepoId
      if (callIdx === 2) return [{ id: 1, title: "Doc", mime: "text/md", summary: "A doc", root_path: "/repo" }];
      return [{ id: 10, parent_id: null, ord: 1, level: 1, heading: "Section A", chunks: 0 }];
    });
    const result = await pg.outline(store, { path: "doc.md", folder: "/repo" });
    assert.strictEqual(result.title, "Doc");
  });
});

// =============================================================================
// context
// =============================================================================

describe("context", () => {
  test("returns chunk context by chunk_id", async () => {
    const store = makeStore(() => [
      { text: "The chunk text", ord: 0, heading: "Section 1", rel_path: "file.md", root_path: "/repo" },
    ]);
    const result = await pg.context(store, { chunk_id: 5 });
    assert.strictEqual(result.mode, "chunk");
    assert.strictEqual(result.text, "The chunk text");
    assert.strictEqual(result.heading, "Section 1");
  });

  test("returns section context by section_id", async () => {
    const store = makeStore(() => [
      { heading: "Full Section", text: "The complete section text content.", rel_path: "file.md", root_path: "/repo" },
    ]);
    const result = await pg.context(store, { section_id: 10 });
    assert.strictEqual(result.mode, "section");
    assert.strictEqual(result.text, "The complete section text content.");
  });

  test("returns null when section_id not found", async () => {
    const store = makeStore(() => []);
    const result = await pg.context(store, { section_id: 999 });
    assert.strictEqual(result, null);
  });

  test("returns null when chunk_id not found", async () => {
    const store = makeStore(() => []);
    const result = await pg.context(store, { chunk_id: 999 });
    assert.strictEqual(result, null);
  });

  test("throws when both section_id and chunk_id are missing", async () => {
    const store = makeStore(() => []);
    await assert.rejects(
      () => pg.context(store, { path: "file.md" }),
      (err) => err.message.includes("section_id or chunk_id"),
    );
  });
});

// =============================================================================
// repos
// =============================================================================

describe("repos", () => {
  test("returns repo list with stats", async () => {
    let callIdx = 0;
    const store = makeStore((sql) => {
      callIdx++;
      if (callIdx === 1) return [
        { id: 1, root_path: "/repo/a", last_indexed_at: "2026-06-01T00:00:00Z", docs: 3, chunks: 12, by_mime_raw: { "text/markdown": 1, "text/plain": 1 } },
      ];
      // per-repo mime query
      return [{ mime: "text/markdown", n: 2 }, { mime: "text/plain", n: 1 }];
    });
    const result = await pg.repos(store);
    assert.strictEqual(result.repos.length, 1);
    assert.strictEqual(result.repos[0].root_path, "/repo/a");
    assert.strictEqual(result.repos[0].by_mime["text/markdown"], 2);
  });

  test("returns empty list when no repos exist", async () => {
    const store = makeStore(() => []);
    const result = await pg.repos(store);
    assert.strictEqual(result.repos.length, 0);
  });
});

// =============================================================================
// batch — sha256 trust (llamacpp-multiturn-latency.md Step 3 review, round 3, P1)
// =============================================================================

describe("batch — sha256 trust", () => {
  test("overwrites a model-supplied sha256 with the value actually stored for the candidate's id before dedup uses it", async () => {
    let callIdx = 0;
    const store = makeStore((sql) => {
      callIdx++;
      // Call 1: withTrustedSha256Postgres's own id -> sha256 lookup. Returns
      // document B's REAL sha256, deliberately different from whatever the
      // caller supplied below — simulating a stale/copied hash in the
      // request payload (e.g. the model echoing an old manifest row).
      if (callIdx === 1) return [{ id: 42, sha256: "real-sha-b" }];
      // Call 2: readBatch's own content query.
      return [{ id: 42, mime: "text/markdown", title: "Doc B", rel_path: "doc-b.md", root_path: "/repo", text: "Document B's real content." }];
    });

    const result = await pg.batch(store, {
      candidates: [{ id: 42, rel_path: "doc-b.md", size: 10, sha256: "stale-sha-a-copied-by-mistake" }],
    });

    assert.equal(result.documents[0].status, "read");
    assert.equal(result.documents[0].text, "Document B's real content.");
    // The trust lookup ran, keyed by id — not by the caller's untrusted sha256.
    assert.match(store._calls[0].sql, /sha256/);
    assert.deepEqual(store._calls[0].params, [[42]]);
  });

  test("falls back to sha256: null (reported as skipped, never a phantom dedup hit) for a candidate id no longer in the index", async () => {
    const store = makeStore(() => []);
    const result = await pg.batch(store, {
      candidates: [{ id: 999, rel_path: "gone.md", size: 10, sha256: "whatever-the-caller-supplied" }],
    });
    assert.equal(result.documents[0].status, "skipped");
  });

  test("refreshes the FULL current identity (not just sha256) for a dedup hit — a stale candidate path never wins over the current DB row (round 8, P1)", async () => {
    let callIdx = 0;
    const store = makeStore(() => {
      callIdx++;
      // Call 1: trust lookup for the FIRST batch — the row still has the old path.
      if (callIdx === 1) return [{ id: 42, sha256: "stable-sha", rel_path: "old-name.md", mime: "text/markdown", title: "Rename Doc", root_path: "/repo" }];
      // Call 2: readBatch content read for the FIRST batch.
      if (callIdx === 2) return [{ id: 42, mime: "text/markdown", title: "Rename Doc", rel_path: "old-name.md", root_path: "/repo", text: "Same content, Amount Due: 5.00 BGN on 01.07.2026." }];
      // Call 3: trust lookup for the SECOND batch — the file was renamed on
      // disk and re-indexed, so the CURRENT row's rel_path has changed.
      if (callIdx === 3) return [{ id: 42, sha256: "stable-sha", rel_path: "new-name.md", mime: "text/markdown", title: "Rename Doc", root_path: "/repo" }];
      return [];
    });

    // First batch primes the session dedup cache under the stable sha256.
    await pg.batch(store, {
      candidates: [{ id: 42, rel_path: "old-name.md", size: 10, sha256: "stable-sha" }],
      sessionId: "pg-rename-session",
    });

    // Second batch: the model's candidate is stale (still old-name.md), but
    // the trust lookup refreshes identity from the CURRENT row, so the dedup
    // hit must return new-name.md — not the cached original read's old path.
    const result = await pg.batch(store, {
      candidates: [{ id: 42, rel_path: "old-name.md", size: 10, sha256: "stable-sha" }],
      sessionId: "pg-rename-session",
    });
    const doc = result.documents[0];
    assert.equal(doc.dedup, true, "sanity: same id + same content still dedups");
    assert.equal(doc.rel_path, "new-name.md", "dedup-hit identity comes from the CURRENT DB row via the trust refresh");
  });

  test("the content read fetches sha256 from the SAME row as the text, so a concurrent re-index can never cache new text under an old hash (round 9, P2)", async () => {
    let callIdx = 0;
    const store = makeStore(() => {
      callIdx++;
      // Call 1: trust lookup for the FIRST batch — snapshot taken BEFORE the
      // concurrent re-index commits (stale hash).
      if (callIdx === 1) return [{ id: 42, sha256: "hash-before-reindex", rel_path: "doc.md", mime: "text/markdown", title: "Doc", root_path: "/repo" }];
      // Call 2: the content read — the re-index has committed by now, so the
      // row carries the NEW hash alongside the NEW text.
      if (callIdx === 2) return [{ id: 42, sha256: "hash-after-reindex", mime: "text/markdown", title: "Doc", rel_path: "doc.md", root_path: "/repo", text: "Content that was re-indexed between the two queries." }];
      // Call 3: trust lookup for the SECOND batch — current manifest hash.
      if (callIdx === 3) return [{ id: 42, sha256: "hash-after-reindex", rel_path: "doc.md", mime: "text/markdown", title: "Doc", root_path: "/repo" }];
      return [];
    });

    await pg.batch(store, {
      candidates: [{ id: 42, rel_path: "doc.md", size: 10, sha256: "hash-before-reindex" }],
      sessionId: "pg-hash-race-session",
    });
    // The content query must itself select sha256 — that is what lets
    // retrieveInBatches key the cache by the hash read with the text.
    assert.match(store._calls[1].sql, /sha256/, "the content read must fetch sha256 in the same query as the text");

    // Follow-up request with the current manifest hash: dedups against
    // content that genuinely has that hash — never a hash/content mismatch.
    const second = await pg.batch(store, {
      candidates: [{ id: 42, rel_path: "doc.md", size: 10, sha256: "hash-after-reindex" }],
      sessionId: "pg-hash-race-session",
    });
    const doc = second.documents[0];
    assert.equal(doc.dedup, true, "content read under hash-after-reindex must be findable by hash-after-reindex");
    assert.equal(doc.text, "Content that was re-indexed between the two queries.");
  });
});

// =============================================================================
// refs
// =============================================================================

describe("refs", () => {
  test("returns matching references", async () => {
    const store = makeStore(() => [
      { kind: "url", value: "https://example.com", section_id: 10, heading: "Links", rel_path: "doc.md", title: "Doc", mime: "text/markdown", root_path: "/repo" },
    ]);
    const result = await pg.refs(store, { ref: "https://example.com" });
    assert.strictEqual(result.ref, "https://example.com");
    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].kind, "url");
    assert.strictEqual(result.matches[0].document.title, "Doc");
  });

  test("returns empty matches when no references found", async () => {
    const store = makeStore(() => []);
    const result = await pg.refs(store, { ref: "unknown" });
    assert.strictEqual(result.matches.length, 0);
  });

  test("accepts limit and folder parameters", async () => {
    let callIdx = 0;
    const store = makeStore((sql) => {
      callIdx++;
      if (callIdx === 1) return [{ id: 42 }]; // resolveRepoId
      return [
        { kind: "url", value: "https://example.com", section_id: 10, heading: "Links", rel_path: "doc.md", title: "Doc", mime: "text/markdown", root_path: "/repo" },
      ];
    });
    const result = await pg.refs(store, { ref: "https://example.com", folder: "/repo", limit: 10 });
    assert.strictEqual(result.matches.length, 1);
  });
});

// =============================================================================
// finalizeRepoDelete (#360: the atomic close of deleteRepo's paging loop —
// folds the last documents-delete and the repo-row delete into ONE
// transaction via pool.connect(), so nothing can slip in between them)
// =============================================================================

describe("finalizeRepoDelete", () => {
  test("returns deleted: true and the deleted rel_paths when the repo existed", async () => {
    const store = makeStore((sql) => {
      if (sql.includes("SELECT id FROM docgraph_repos")) return [{ id: 1 }];
      if (sql.includes("DELETE FROM docgraph_documents")) return [{ rel_path: "a.md" }, { rel_path: "b.md" }];
      if (sql.includes("DELETE FROM docgraph_repos")) return [{ id: 1 }]; // non-empty → rowCount > 0
      return []; // BEGIN / COMMIT
    });
    const result = await pg.finalizeRepoDelete(store, "/repo/a");
    assert.strictEqual(result.deleted, true);
    assert.deepEqual(result.relPaths.slice().sort(), ["a.md", "b.md"]);
  });

  test("returns deleted: false and rolls back when the repo did not exist", async () => {
    const calls = [];
    const store = makeStore((sql) => { calls.push(sql); return []; }); // repo lookup finds nothing
    const result = await pg.finalizeRepoDelete(store, "/repo/nonexistent");
    assert.strictEqual(result.deleted, false);
    assert.deepEqual(result.relPaths, []);
    assert.ok(calls.some(sql => sql.includes("ROLLBACK")), "must roll back rather than leave the transaction open");
  });

  test("rolls back and rethrows when a query inside the transaction fails", async () => {
    const calls = [];
    const store = makeStore((sql) => {
      calls.push(sql);
      if (sql.includes("SELECT id FROM docgraph_repos")) return [{ id: 1 }];
      if (sql.includes("DELETE FROM docgraph_documents")) throw new Error("simulated transient failure");
      return [];
    });
    await assert.rejects(() => pg.finalizeRepoDelete(store, "/repo/a"), /simulated transient failure/);
    assert.ok(calls.some(sql => sql.includes("ROLLBACK")), "a failed statement must still roll back the transaction");
  });
});

// =============================================================================
// removeOneFile
// =============================================================================

describe("removeOneFile", () => {
  test("returns removed: true when file existed", async () => {
    // The DELETE query must return rowCount > 0. Return a non-empty array
    // so rowCount = rows.length > 0.
    const store = makeStore(() => [{ id: 1 }]);
    const result = await pg.removeOneFile(store, "/repo", "doc.md");
    assert.strictEqual(result.removed, true);
  });

  test("returns removed: false when repo not found", async () => {
    const store = makeStore(() => []);
    const result = await pg.removeOneFile(store, "/repo", "doc.md");
    assert.strictEqual(result.removed, false);
  });
});

// =============================================================================
// sweepMissingFiles
// =============================================================================

describe("sweepMissingFiles", () => {
  test("removes files that no longer exist", async () => {
    // Pattern-matched rather than positional (#360 review round 4, P1 & P2):
    // the delete+purge now happens inside a locked transaction (BEGIN, a
    // FOR UPDATE lock, wiki staleness, the memories delete, COMMIT), which
    // adds calls between "list docs" and the confirmed-delete result.
    const store = makeStore((sql) => {
      if (sql.includes("FOR UPDATE")) return [{ id: 1 }];
      if (sql.includes("SELECT id FROM docgraph_repos")) return [{ id: 1 }];
      if (sql.includes("SELECT rel_path FROM docgraph_documents")) return [{ rel_path: "gone.md" }, { rel_path: "still-here.md" }];
      if (sql.includes("DELETE FROM docgraph_documents")) return [{ rel_path: "gone.md" }]; // confirmed by RETURNING
      return []; // BEGIN / wiki UPDATE / memories DELETE / COMMIT
    });
    const statFn = async (p) => {
      if (p.endsWith("gone.md")) throw new Error("ENOENT");
    };
    const result = await pg.sweepMissingFiles(store, "/repo", statFn);
    assert.strictEqual(result.removed, 1);
  });

  test("removes nothing when all files exist", async () => {
    const store = makeStore((sql) => {
      if (sql.includes("SELECT id FROM docgraph_repos")) return [{ id: 1 }];
      if (sql.includes("SELECT rel_path FROM docgraph_documents")) return [{ rel_path: "exists.md" }];
      return [];
    });
    const statFn = async () => {};
    const result = await pg.sweepMissingFiles(store, "/repo", statFn);
    assert.strictEqual(result.removed, 0);
  });

  test("returns removed:0 when repo not found", async () => {
    const store = makeStore(() => []);
    const result = await pg.sweepMissingFiles(store, "/repo", async () => {});
    assert.strictEqual(result.removed, 0);
  });
});

// =============================================================================
// setChunkEmbedding
// =============================================================================

describe("setChunkEmbedding", () => {
  test("updates chunk embedding via SQL", async () => {
    let capturedSql, capturedParams;
    const store = {
      pool: {
        query: async (sql, params) => {
          capturedSql = sql;
          capturedParams = params;
          return { rows: [], rowCount: 1 };
        },
      },
    };
    await pg.setChunkEmbedding(store, 5, [0.1, 0.2, 0.3]);
    assert.ok(capturedSql.includes("UPDATE docgraph_chunks"));
    assert.ok(capturedSql.includes("embedding"));
    assert.strictEqual(capturedParams[0], "[0.1,0.2,0.3]");
    assert.strictEqual(capturedParams[1], 5);
  });
});

// =============================================================================
// indexOneFile (error path — file doesn't exist)
// =============================================================================

describe("indexOneFile", () => {
  test("returns skipped when file does not exist", async () => {
    const store = makeStore(() => []);
    const result = await pg.indexOneFile(store, "/repo", "nonexistent.md", {
      mime: "text/markdown",
      extract: async () => ({ sections: [] }),
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "file gone");
  });
});

// =============================================================================
// indexRepoFiles
// =============================================================================

describe("indexRepoFiles", () => {
  test("handles empty file iterator", async () => {
    async function* emptyIter() {}
    const store = {
      pool: {
        connect: async () => ({
          query: async () => ({ rows: [{ id: 1 }], rowCount: 1 }),
          release: () => {},
        }),
        query: async () => ({ rows: [{ id: 1 }], rowCount: 1 }),
      },
    };
    const result = await pg.indexRepoFiles(store, "/repo", emptyIter());
    assert.strictEqual(result.docs, 0);
    assert.strictEqual(result.changed, 0);
    assert.strictEqual(result.skipped, 0);
  });

  test("skips files that throw during read/stat", async () => {
    async function* errIter() {
      yield { abs: "/nonexistent/file.md", rel: "file.md", mime: "text/markdown", extract: async () => ({ sections: [] }) };
    }
    const store = {
      pool: {
        connect: async () => ({
          query: async () => ({ rows: [{ id: 1 }], rowCount: 1 }),
          release: () => {},
        }),
        query: async () => ({ rows: [{ id: 1 }], rowCount: 1 }),
      },
    };
    const result = await pg.indexRepoFiles(store, "/repo", errIter());
    assert.strictEqual(result.skipped, 1);
  });

  test("a bad file is isolated by a savepoint; later files still index", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docgraph-pg-"));
    const a = path.join(dir, "bad.md");
    const b = path.join(dir, "good.md");
    await writeFile(a, "bad");
    await writeFile(b, "good");
    async function* iter() {
      yield { abs: a, rel: "bad.md", mime: "text/markdown",
        extract: async () => ({ sections: [{ localId: 1, ord: 0, level: 1, heading: "FAIL", text: "x" }] }) };
      yield { abs: b, rel: "good.md", mime: "text/markdown",
        extract: async () => ({ sections: [{ localId: 1, ord: 0, level: 1, heading: "OK", text: "y" }] }) };
    }
    const verbs = [];
    const client = {
      query: async (sql, params) => {
        verbs.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
        // The section INSERT for the "bad" doc throws, like a NUL/constraint error.
        if (/INSERT INTO docgraph_sections/.test(sql) && params?.includes("FAIL")) {
          throw new Error("invalid byte sequence");
        }
        return { rows: [{ id: 1, sha256: null }], rowCount: 1 };
      },
      release: () => {},
    };
    const store = { pool: { connect: async () => client } };
    const result = await pg.indexRepoFiles(store, dir, iter());
    await rm(dir, { recursive: true, force: true });

    assert.strictEqual(result.skipped, 1, "bad file skipped");
    assert.strictEqual(result.changed, 1, "good file still indexed after the bad one");
    assert.ok(verbs.includes("ROLLBACK TO SAVEPOINT"), "rolled the bad file's savepoint back");
    assert.ok(verbs.includes("COMMIT"), "batch still committed");
  });

  test("strips NUL bytes from text before insert", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docgraph-pg-"));
    const f = path.join(dir, "nul.md");
    await writeFile(f, "x");
    async function* iter() {
      yield { abs: f, rel: "nul.md", mime: "text/markdown",
        extract: async () => ({ title: "t\u0000", sections: [{ localId: 1, ord: 0, level: 1, heading: "h\u0000", text: "a\u0000b" }] }) };
    }
    const inserted = [];
    const client = {
      query: async (sql, params) => {
        if (/INSERT INTO docgraph_(sections|chunks)|UPDATE docgraph_documents SET title/.test(sql)) inserted.push(params);
        return { rows: [{ id: 1, sha256: null }], rowCount: 1 };
      },
      release: () => {},
    };
    const store = { pool: { connect: async () => client } };
    await pg.indexRepoFiles(store, dir, iter());
    await rm(dir, { recursive: true, force: true });

    for (const params of inserted) {
      for (const p of params) {
        assert.ok(typeof p !== "string" || !p.includes("\u0000"), `NUL leaked: ${JSON.stringify(p)}`);
      }
    }
  });
});

// =============================================================================
// Helper: snippetOf (exercised through search but tested directly here)
// =============================================================================

describe("snippetOf (internal, exercised via search)", () => {
  test("search returns short text unsnipped", async () => {
    const store = makeStore(() => [
      { chunk_id: 1, section_id: 10, chunk_text: "Short text.", heading: null, level: 1, rel_path: "f.md", title: "F", mime: "text/plain", root_path: "/repo", score: 0.5 },
    ]);
    const result = await pg.search(store, { query: "short" }, { vectorEnabled: () => false });
    assert.strictEqual(result.matches[0].snippet, "Short text.");
  });

  test("search return snippet is never empty", async () => {
    const store = makeStore(() => [
      { chunk_id: 1, section_id: 10, chunk_text: "A somewhat longer text about budgets and marketing strategy for 2026.", heading: null, level: 1, rel_path: "f.md", title: "F", mime: "text/plain", root_path: "/repo", score: 0.5 },
    ]);
    const result = await pg.search(store, { query: "budgets" }, { vectorEnabled: () => false });
    assert.ok(result.matches[0].snippet.length > 0);
    assert.ok(result.matches[0].snippet.includes("budgets"));
  });
});
