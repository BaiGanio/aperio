// tests/lib/docgraph/incremental.test.js
// Phase 7: incremental single-document ops (indexFile / removeFile /
// sweepMissing) the watcher relies on, against a real SqliteStore.
// Phase 6: lightweight guard that the Postgres backend module loads, exposes
// the same surface as SQLite, and is selected by pickBackend for a pool store
// (full pg behavior needs a live database, exercised in CI with DATABASE_URL).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { installMemfs } from "../../helpers/memfs.js";

// In-memory fs + ':memory:' DB → zero real disk access. Install BEFORE importing
// the indexer/backend (their fs/promises named imports must bind to the patched
// module), so those are imported dynamically in before().
const mem = installMemfs({ root: "/mem/docg-inc" });
let indexFile, removeFile, sweepMissing, deleteRepo, pickBackend, docgraph, pgBackend, bridgeTag;

// Incremental indexFile defers embedding to the watcher's async queue, so it
// takes no embedding fn — it returns `pending` chunks for the queue to drain.
const opts = {};

let dir, oldPath, oldDims, store;

before(async () => {
  ({ indexFile, removeFile, sweepMissing, deleteRepo, pickBackend } = await import("../../../lib/docgraph/indexer.js"));
  ({ bridgeTag } = await import("../../../lib/docgraph/memory-bridge.js"));
  docgraph  = await import("../../../lib/docgraph/backends/sqlite.js");
  pgBackend = await import("../../../lib/docgraph/backends/postgres.js");

  oldPath = process.env.SQLITE_PATH; oldDims = process.env.EMBEDDING_DIMS;
  process.env.SQLITE_PATH = ":memory:";
  process.env.EMBEDDING_DIMS = "1024";
  dir = join(mem.root, "docs");
  mem.mkdirp(dir);
  mem.writeFile(join(dir, "a.md"), "# A\nalpha content");
  mem.writeFile(join(dir, "b.md"), "# B\nbeta content");

  const { SqliteStore } = await import("../../../db/sqlite.js");
  store = await SqliteStore.init();
});

after(async () => {
  await store?.close?.().catch(() => {});
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  if (oldDims) process.env.EMBEDDING_DIMS = oldDims; else delete process.env.EMBEDDING_DIMS;
  mem.restore();
});

describe("docgraph incremental (Phase 7)", () => {
  test("indexFile adds a document; re-index is a no-op", async () => {
    const r1 = await indexFile(store, dir, "a.md", opts);
    assert.equal(r1.skipped, false);
    assert.ok(r1.sectionCount >= 1);
    // Deferred embedding: the chunks come back as pending for the queue to drain.
    assert.ok(Array.isArray(r1.pending) && r1.pending.length >= 1);

    const r2 = await indexFile(store, dir, "a.md", opts);
    assert.equal(r2.skipped, true);
    assert.equal(r2.reason, "unchanged");
  });

  test("indexFile re-indexes after content change", async () => {
    mem.writeFile(join(dir, "a.md"), "# A\nalpha content edited with more words");
    const r = await indexFile(store, dir, "a.md", opts);
    assert.equal(r.skipped, false);
  });

  test("removeFile drops the document", async () => {
    await indexFile(store, dir, "b.md", opts);
    const before = await docgraph.repos(store);
    assert.ok(before.repos.find((x) => x.root_path === dir).docs >= 2);

    const r = await removeFile(store, dir, "b.md");
    assert.equal(r.removed, true);
    const after = await docgraph.repos(store);
    assert.equal(after.repos.find((x) => x.root_path === dir).docs, 1);
  });

  test("sweepMissing drops rows for files deleted on disk", async () => {
    mem.rm(join(dir, "a.md"));
    const r = await sweepMissing(store, dir);
    assert.equal(r.removed, 1);
    const after = await docgraph.repos(store);
    const repo = after.repos.find((x) => x.root_path === dir);
    assert.equal(repo ? repo.docs : 0, 0);
  });

  test("unsupported extension is skipped", async () => {
    mem.writeFile(join(dir, "ignore.bin"), "x");
    const r = await indexFile(store, dir, "ignore.bin", opts);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "unsupported extension");
  });
});

// #360: removeFile/sweepMissing/deleteRepo must retire the bridge-owned
// memory for a document once it leaves the docgraph index, but must never
// touch a real user memory even if it carries a colliding dag:* tag.
describe("docgraph → memory bridge lifecycle reconciliation (#360)", () => {
  const bridgeMemory = (stablePath, overrides = {}) => ({
    type: "fact", title: "bill summary — 2026-06", content: "bill summary — 2026-06: 64.80 BGN.",
    tags: ["fact", "bill", "docgraph", bridgeTag(stablePath)],
    importance: 4, tier: 2, source: "docgraph", confidence: 1.0,
    ...overrides,
  });

  test("removeFile retires the bridge memory for the removed document", async () => {
    mem.writeFile(join(dir, "gone.md"), "# Gone\ncontent");
    await indexFile(store, dir, "gone.md", opts);
    const stablePath = `${dir}/gone.md`;
    const created = await store.insert(bridgeMemory(stablePath), null);

    const r = await removeFile(store, dir, "gone.md");
    assert.equal(r.removed, true);
    assert.equal(await store.getById(created.id), null);
  });

  test("removeFile deletes only the bridge-owned memory, leaving a user memory with the same colliding dag:* tag untouched", async () => {
    mem.writeFile(join(dir, "userowned.md"), "# U\ncontent");
    await indexFile(store, dir, "userowned.md", opts);
    const stablePath = `${dir}/userowned.md`;
    const bridgeMem = await store.insert(bridgeMemory(stablePath), null);
    const userMemory = await store.insert(
      bridgeMemory(stablePath, { source: "manual", title: "my own note" }), null);

    await removeFile(store, dir, "userowned.md");
    assert.equal(await store.getById(bridgeMem.id), null, "the bridge-owned memory must be retired");
    assert.ok(await store.getById(userMemory.id), "a user-owned memory sharing a dag:* tag must survive removeFile");
  });

  test("sweepMissing retires bridge memories for every file gone from disk, not just one", async () => {
    mem.writeFile(join(dir, "sweep-a.md"), "# A\ncontent");
    mem.writeFile(join(dir, "sweep-b.md"), "# B\ncontent");
    await indexFile(store, dir, "sweep-a.md", opts);
    await indexFile(store, dir, "sweep-b.md", opts);
    const memA = await store.insert(bridgeMemory(`${dir}/sweep-a.md`), null);
    const memB = await store.insert(bridgeMemory(`${dir}/sweep-b.md`), null);

    mem.rm(join(dir, "sweep-a.md"));
    mem.rm(join(dir, "sweep-b.md"));
    const r = await sweepMissing(store, dir);
    assert.equal(r.removed, 2);
    assert.equal(await store.getById(memA.id), null);
    assert.equal(await store.getById(memB.id), null);
  });

  test("deleteRepo retires every bridge memory under that root before dropping the repo", async () => {
    const repoDir = join(mem.root, "delete-repo-docs");
    mem.mkdirp(repoDir);
    mem.writeFile(join(repoDir, "one.md"), "# One\ncontent");
    mem.writeFile(join(repoDir, "two.md"), "# Two\ncontent");
    await indexFile(store, repoDir, "one.md", opts);
    await indexFile(store, repoDir, "two.md", opts);
    const memOne = await store.insert(bridgeMemory(`${repoDir}/one.md`), null);
    const memTwo = await store.insert(bridgeMemory(`${repoDir}/two.md`), null);
    const userMemory = await store.insert(
      bridgeMemory(`${repoDir}/one.md`, { source: "manual", title: "unrelated user note" }), null);

    const r = await deleteRepo(store, repoDir);
    assert.equal(r.deleted, true);
    assert.equal(await store.getById(memOne.id), null);
    assert.equal(await store.getById(memTwo.id), null);
    assert.ok(await store.getById(userMemory.id), "a user memory colliding on the same dag:* tag must survive deleteRepo");
  });

  // P2 (review): retireBridgeMemory used to go through recall(), whose
  // hybrid-search cap tops out at 50 and its own default at 5 — a document
  // with more matching rows than the requested `limit` could leave bridge
  // duplicates behind uncounted. deleteByTagsAndSource has no such cap.
  test("retires every bridge-owned memory sharing a tag, even past recall()'s old 5-row cap", async () => {
    mem.writeFile(join(dir, "duped.md"), "# D\ncontent");
    await indexFile(store, dir, "duped.md", opts);
    const stablePath = `${dir}/duped.md`;

    // Simulates concurrent promotions racing past the dedup check (#314) —
    // more bridge-owned rows for one tag than the old recall(limit:5) cap.
    const bridgeMems = [];
    for (let i = 0; i < 7; i++) {
      bridgeMems.push(await store.insert(bridgeMemory(stablePath, { title: `dup ${i}` }), null));
    }
    // A crowd of user memories sharing the same tag by coincidence — under
    // the old rank-and-cap recall() these alone could fill the 5-row window
    // and hide every bridge-owned row.
    const userMems = [];
    for (let i = 0; i < 5; i++) {
      userMems.push(await store.insert(bridgeMemory(stablePath, { source: "manual", title: `user note ${i}` }), null));
    }

    await removeFile(store, dir, "duped.md");
    for (const m of bridgeMems) {
      assert.equal(await store.getById(m.id), null, `bridge duplicate "${m.title}" must be retired`);
    }
    for (const m of userMems) {
      assert.ok(await store.getById(m.id), `user memory "${m.title}" sharing the tag must survive`);
    }
  });

  // P1 (review): the old implementation ran one recall() + delete() per
  // document, so deleting a large repository cost N round trips even when
  // DOCGRAPH_AUTO_MEMORY is off and no bridge memories exist. Prove the new
  // path is batched, not per-document, by comparing the raw query count for
  // a 3-document repo against a 24-document repo (both well under the
  // batch size) — an unbatched N+1 implementation would scale with N; a
  // batched one issues the same small, bounded number of queries either way.
  test("deleteRepo's bridge-memory cleanup issues a bounded number of queries, not one per document (#360)", async () => {
    async function deleteRepoQueryCount(repoName, fileCount) {
      const repoDir = join(mem.root, repoName);
      mem.mkdirp(repoDir);
      for (let i = 0; i < fileCount; i++) {
        mem.writeFile(join(repoDir, `doc-${i}.md`), `# Doc ${i}\ncontent`);
        await indexFile(store, repoDir, `doc-${i}.md`, opts);
        await store.insert(bridgeMemory(`${repoDir}/doc-${i}.md`), null);
      }
      const realPrepare = store.db.prepare.bind(store.db);
      let calls = 0;
      store.db.prepare = (sql) => { calls++; return realPrepare(sql); };
      try {
        await deleteRepo(store, repoDir);
      } finally {
        store.db.prepare = realPrepare;
      }
      return calls;
    }

    const small = await deleteRepoQueryCount("bounded-small", 3);
    const large = await deleteRepoQueryCount("bounded-large", 24);
    // Both repos fit in deleteByTagsAndSource's single default batch (500),
    // so query count must be flat regardless of document count — an N+1
    // implementation would instead grow roughly linearly with file count.
    assert.equal(large, small,
      `query count must not scale with document count: 3 docs used ${small}, 24 docs used ${large}`);
  });

  test("deleteDocumentsPage deletes-and-returns bounded slices, in a stable order, and [] once exhausted", async () => {
    const repoDir = join(mem.root, "page-contract-repo");
    mem.mkdirp(repoDir);
    const relPaths = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    for (const rel of relPaths) {
      mem.writeFile(join(repoDir, rel), `# ${rel}\ncontent`);
      await indexFile(store, repoDir, rel, opts);
    }

    const seen = [];
    for (;;) {
      const page = await docgraph.deleteDocumentsPage(store, repoDir, 2);
      if (!page.length) break;
      assert.ok(page.length <= 2, "a page must never exceed the requested limit");
      seen.push(...page);
    }
    assert.deepEqual(seen.slice().sort(), relPaths.slice().sort(),
      "paging to exhaustion must cover every document exactly once, in total");
    assert.equal(new Set(seen).size, seen.length, "no document may appear on more than one page");
    // Since each page actually DELETES its rows (not just reads them), no
    // repeated call needs an offset — and the documents are really gone.
    const after = await docgraph.repos(store);
    const repo = after.repos.find((x) => x.root_path === repoDir);
    assert.equal(repo ? repo.docs : 0, 0);
  });

  // #360 review (P2): retiring memories BEFORE confirming the repo delete
  // succeeded meant a transient failure on the final delete could destroy
  // valid memories for documents that were never actually removed.
  // deleteDocumentsPage deletes-and-returns each page atomically, so a
  // memory is only ever retired once its document's row is confirmed gone.
  test("a page whose deletion fails leaves both its documents AND their memories intact, and never deletes the repo row", async () => {
    const repoDir = join(mem.root, "failing-page-repo");
    mem.mkdirp(repoDir);
    const relPath = "surviving.md";
    mem.writeFile(join(repoDir, relPath), "# S\ncontent");
    await indexFile(store, repoDir, relPath, opts);
    const survivingMem = await store.insert(bridgeMemory(`${repoDir}/${relPath}`), null);

    // Simulate a transient DB error on the delete itself by making the
    // underlying db.prepare throw for exactly this statement, rather than
    // reassigning the (frozen) ESM module export.
    const realPrepare = store.db.prepare.bind(store.db);
    store.db.prepare = (sql) => {
      if (sql.includes("DELETE FROM docgraph_documents")) throw new Error("simulated transient DB error");
      return realPrepare(sql);
    };
    try {
      // A genuine backend failure propagates as a real error rather than a
      // quiet { deleted: false } — the caller must be able to tell "the repo
      // never existed" apart from "deletion actually failed" (#360 review).
      await assert.rejects(() => deleteRepo(store, repoDir), /simulated transient DB error/);
    } finally {
      store.db.prepare = realPrepare;
    }

    assert.ok(await store.getById(survivingMem.id), "the memory must survive a failed page delete");
    const after = await docgraph.repos(store);
    const repo = after.repos.find((x) => x.root_path === repoDir);
    assert.ok(repo, "the repo row itself must survive — its document was never actually deleted");
    assert.equal(repo.docs, 1, "the document row must survive a failed page delete");
  });

  // #360 review round 2 (P1): a document added (and already promoted into a
  // bridge memory by a concurrent doc_batch) in the gap between the paging
  // loop's last page and the repo-row delete used to survive as an orphan —
  // the repo-row delete's cascade would remove the document without ever
  // routing it through purgeOrphanedBridgeMemories. finalizeRepoDelete's
  // single transaction closes that gap: whatever exists for this repo at
  // the instant it runs is captured and retired together with the repo row.
  test("finalizeRepoDelete catches a document (and its already-promoted memory) added in the gap after the last page, before the repo row is dropped", async () => {
    const repoDir = join(mem.root, "concurrent-add-repo");
    mem.mkdirp(repoDir);
    mem.writeFile(join(repoDir, "first.md"), "# First\ncontent");
    await indexFile(store, repoDir, "first.md", opts);
    const firstMem = await store.insert(bridgeMemory(`${repoDir}/first.md`), null);

    // Simulate a concurrent index + doc_batch promotion landing in exactly
    // the gap the review identified: right after the paging loop's page
    // delete commits (this repo has only one document, so this is also its
    // LAST page), a second document appears with its bridge memory already
    // written — before finalizeRepoDelete's closing transaction runs.
    const realPrepare = store.db.prepare.bind(store.db);
    let injected = false;
    let concurrentMem;
    store.db.prepare = (sql) => {
      const stmt = realPrepare(sql);
      if (!injected && sql.includes("WHERE id IN (SELECT id FROM docgraph_documents WHERE repo_id")) {
        injected = true;
        const realAll = stmt.all.bind(stmt);
        stmt.all = (...args) => {
          const result = realAll(...args);
          const repoRow = realPrepare(`SELECT id FROM docgraph_repos WHERE root_path = ?`).get(repoDir);
          realPrepare(`
            INSERT INTO docgraph_documents (repo_id, rel_path, mime, size, mtime, sha256, indexed_at)
            VALUES (?, 'concurrent.md', 'text/markdown', 10, ?, 'fakehash', ?)
          `).run(repoRow.id, new Date().toISOString(), new Date().toISOString());
          return result;
        };
      }
      return stmt;
    };
    try {
      concurrentMem = await store.insert(bridgeMemory(`${repoDir}/concurrent.md`), null);
      await deleteRepo(store, repoDir);
    } finally {
      store.db.prepare = realPrepare;
    }

    assert.equal(await store.getById(firstMem.id), null, "the originally-paged document's memory must still be retired");
    assert.equal(await store.getById(concurrentMem.id), null,
      "the concurrently-added document's already-promoted memory must be retired too — not left as the orphan #360 exists to prevent");
    const after = await docgraph.repos(store);
    assert.ok(!after.repos.find((x) => x.root_path === repoDir), "the repo row itself must be fully gone");
  });

  // P2 (review): deleteRepo used to load every rel_path for the repository
  // in one unpaginated query before purging — peak memory proportional to
  // corpus size. It now pages through deleteDocumentsPage in bounded
  // chunks (RECONCILE_PAGE_SIZE = 500 in indexer.js). Prove paging is
  // actually exercised — not just fast for a small repo — with a corpus one
  // document past a single page, and that every document across BOTH pages
  // gets its bridge memory retired, not only the first page's.
  test("deleteRepo retires bridge memories across every page, not just the first, for a repo spanning a page boundary", async () => {
    const repoDir = join(mem.root, "paged-repo");
    mem.mkdirp(repoDir);
    const PAGE_BOUNDARY = 500; // must match indexer.js's RECONCILE_PAGE_SIZE
    const fileCount = PAGE_BOUNDARY + 1; // forces a second page
    const created = [];
    for (let i = 0; i < fileCount; i++) {
      const relPath = `doc-${i}.md`;
      mem.writeFile(join(repoDir, relPath), `# Doc ${i}\ncontent`);
      await indexFile(store, repoDir, relPath, opts);
      created.push(await store.insert(bridgeMemory(`${repoDir}/${relPath}`), null));
    }

    const r = await deleteRepo(store, repoDir);
    assert.equal(r.deleted, true);

    let survivors = 0;
    for (const mem_ of created) {
      if (await store.getById(mem_.id)) survivors++;
    }
    assert.equal(survivors, 0,
      `every bridge memory across both pages must be retired; ${survivors}/${fileCount} survived`);
  });
});

describe("docgraph Postgres backend (Phase 6) — routing + surface", () => {
  test("pickBackend routes a pool store to postgres", () => {
    assert.equal(pickBackend({ pool: {} })?.kind, "postgres");
    assert.equal(pickBackend({ db: {} })?.kind, "sqlite");
    assert.equal(pickBackend({}), null);
  });

  test("pg backend exposes the same surface as the sqlite backend", () => {
    for (const fn of ["indexRepoFiles", "indexOneFile", "setChunkEmbedding", "removeOneFile", "sweepMissingFiles",
      "deleteDocumentsPage", "finalizeRepoDelete", "search", "outline", "context", "repos", "refs"]) {
      assert.equal(typeof pgBackend[fn], "function", `pg backend missing ${fn}`);
    }
  });
});
