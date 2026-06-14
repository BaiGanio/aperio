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
let indexFile, removeFile, sweepMissing, pickBackend, docgraph, pgBackend;

// Incremental indexFile defers embedding to the watcher's async queue, so it
// takes no embedding fn — it returns `pending` chunks for the queue to drain.
const opts = {};

let dir, oldPath, oldDims, store;

before(async () => {
  ({ indexFile, removeFile, sweepMissing, pickBackend } = await import("../../../lib/docgraph/indexer.js"));
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

describe("docgraph Postgres backend (Phase 6) — routing + surface", () => {
  test("pickBackend routes a pool store to postgres", () => {
    assert.equal(pickBackend({ pool: {} })?.kind, "postgres");
    assert.equal(pickBackend({ db: {} })?.kind, "sqlite");
    assert.equal(pickBackend({}), null);
  });

  test("pg backend exposes the same surface as the sqlite backend", () => {
    for (const fn of ["indexRepoFiles", "indexOneFile", "setChunkEmbedding", "removeOneFile", "sweepMissingFiles",
      "deleteRepo", "search", "outline", "context", "repos", "refs"]) {
      assert.equal(typeof pgBackend[fn], "function", `pg backend missing ${fn}`);
    }
  });
});
