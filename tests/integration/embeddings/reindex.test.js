// tests/integration/embeddings/reindex.test.js
//
// WS1 of issue #287: per-store embedding signature (vec_meta), mark-stale
// instead of delete, FTS-only degradation, and the resumable reindex driver.
//
// Runs against a real SqliteStore so the migration, the store CRUD, and the
// driver are exercised together — the failure mode this feature exists to
// prevent (similarity scores computed across two different embedding spaces)
// is invisible to a mocked store.

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Env before any project import: db/sqlite/store.js freezes SQLITE_PATH and
// EMBEDDING_DIMS into module-level constants at import time.
const oldPath = process.env.SQLITE_PATH;
const oldDims = process.env.EMBEDDING_DIMS;
const oldProvider = process.env.EMBEDDING_PROVIDER;
process.env.SQLITE_PATH = ":memory:";
process.env.EMBEDDING_DIMS = "1024";
process.env.EMBEDDING_PROVIDER = "transformers";

const { SqliteStore } = await import("../../../db/sqlite.js");
const {
  VECTOR_STORES, VEC_STATUS, signatureString, supportsVecMeta,
  isVectorSearchable, vectorGate, ensureVecMeta,
  canPersistEmbedding, embedForStore, markReindexing,
} = await import("../../../lib/helpers/vecMeta.js");
const { rememberHandler, updateMemoryHandler } = await import("../../../lib/handlers/memory/memoryHandlers.js");
const { wikiWriteHandler } = await import("../../../lib/handlers/wiki/wikiHandlers.js");
const { runReindex, listPendingStores } = await import("../../../lib/embeddings/reindex.js");
const { checkEmbeddingProvider, getEmbeddingSignature } = await import("../../../lib/helpers/embeddings.js");

const SIG_A = "transformers:mixedbread-ai/mxbai-embed-large-v1:1024";
const SIG_B = "voyage:voyage-3:1024";

function fakeVector(dims = 1024) {
  return Array.from({ length: dims }, (_, i) => (i % 7) / 10);
}

// Counts calls so tests can assert on embedding work, not wall time.
function countingEmbedder(dims = 1024) {
  const fn = async () => { fn.calls++; return fakeVector(dims); };
  fn.calls = 0;
  return fn;
}

async function freshStore() {
  return SqliteStore.init();
}

after(() => {
  if (oldPath !== undefined) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  if (oldDims !== undefined) process.env.EMBEDDING_DIMS = oldDims; else delete process.env.EMBEDDING_DIMS;
  if (oldProvider !== undefined) process.env.EMBEDDING_PROVIDER = oldProvider; else delete process.env.EMBEDDING_PROVIDER;
});

// =============================================================================
// WS1.1 — vec_meta table and seeding
// =============================================================================
describe("WS1.1 — vec_meta migration and seeding", () => {
  let store;
  before(async () => { store = await freshStore(); });
  after(async () => { await store?.close?.(); });

  test("the store exposes the vec_meta surface the state machine needs", () => {
    assert.equal(supportsVecMeta(store), true);
  });

  test("seeding creates exactly one row per known vector store, all current", async () => {
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
    const rows = await store.listVecMeta();
    assert.deepEqual(rows.map(r => r.store_name).sort(), [...VECTOR_STORES].sort());
    assert.equal(rows.length, 5);
    for (const r of rows) {
      assert.equal(r.status, VEC_STATUS.CURRENT);
      assert.equal(r.signature, SIG_A);
      assert.equal(r.dims, 1024);
    }
  });

  test("seeding is idempotent and never clobbers recorded state", async () => {
    // A store mid-reindex must survive a re-seed, or every restart would
    // silently restart its reindex from scratch.
    await store.updateVecMeta("memories", { status: VEC_STATUS.REINDEXING });
    await ensureVecMeta(store, { signature: SIG_B, dims: 1024 });
    const row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.REINDEXING);
    assert.equal(row.signature, SIG_A, "re-seeding must not overwrite an existing signature");
    assert.equal((await store.listVecMeta()).length, 5);
  });

  test("an upgraded database seeds at its legacy fingerprint, not the running config", async () => {
    // The vectors in a pre-vec_meta database belong to whatever the old global
    // fingerprint recorded. Seeding at the *running* config instead would
    // declare them current and serve cross-space results forever.
    const upgraded = await freshStore();
    try {
      const legacy = { provider: "voyage", model: "voyage-3", dims: 1024 };
      await upgraded.setSetting("embedding_provider", legacy);
      await checkEmbeddingProvider(upgraded);

      const rows = await upgraded.listVecMeta();
      for (const r of rows) {
        assert.equal(r.status, VEC_STATUS.STALE, `${r.store_name} should be stale after an upgrade with a different provider`);
        assert.equal(r.signature, signatureString(getEmbeddingSignature()));
      }
    } finally {
      await upgraded.close?.();
    }
  });
});

// =============================================================================
// WS1.2 — one canonical signature
// =============================================================================
describe("WS1.2 — canonical signature", () => {
  test("signatureString is the only notion of sameness, and matches the running config", () => {
    const sig = getEmbeddingSignature();
    assert.equal(signatureString(sig), SIG_A);
    // Structural equality is deliberately NOT how staleness is decided; the
    // string is. Two configs differing only in dims must not collide.
    assert.notEqual(
      signatureString({ ...sig, dims: 768 }),
      signatureString(sig)
    );
  });

  test("VECTOR_STORES matches what the backend actually clears", async () => {
    // Guards the "a sixth store gets added and silently never reindexes" hole.
    const store = await freshStore();
    try {
      for (const name of VECTOR_STORES) {
        await assert.doesNotReject(
          () => store.clearStoreEmbeddings(name),
          `${name} must be clearable — VECTOR_STORES and the backend table map have drifted`
        );
      }
      await assert.rejects(() => store.clearStoreEmbeddings("not_a_store"), /unknown store/);
    } finally {
      await store.close?.();
    }
  });
});

// =============================================================================
// WS1.3 — stale stores degrade to FTS-only
// =============================================================================
describe("WS1.3 — stale and reindexing stores never serve vector results", () => {
  let store;
  beforeEach(async () => {
    await store?.close?.();
    store = await freshStore();
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
  });
  after(async () => { await store?.close?.(); });

  test("a current store is vector-searchable", async () => {
    assert.equal(await isVectorSearchable(store, "memories"), true);
  });

  for (const status of [VEC_STATUS.STALE, VEC_STATUS.REINDEXING]) {
    test(`a ${status} store is not vector-searchable`, async () => {
      await store.updateVecMeta("memories", { status });
      assert.equal(await isVectorSearchable(store, "memories"), false);
      // Other stores are unaffected — staleness is per store, not global.
      assert.equal(await isVectorSearchable(store, "wiki"), true);
    });
  }

  test("a store marked current under a different process's signature is not searchable (review finding P1)", async () => {
    // Simulates a second Aperio process (Postgres multi-agent mode, or an
    // operator's CLI run under a different EMBEDDING_PROVIDER) finishing its
    // own reindex and finalizing this exact store to `current` — but toward
    // SIG_B, not the signature this process's own active configuration
    // (SIG_A, per the env set at the top of this file) would produce.
    // `status === current` alone can't distinguish that from a genuine
    // current-for-me store, and scoring this process's query embedding
    // (computed under SIG_A) against SIG_B's vectors is exactly the
    // cross-space comparison vec_meta exists to prevent.
    await store.updateVecMeta("memories", { status: VEC_STATUS.CURRENT, signature: SIG_B });
    assert.equal(await isVectorSearchable(store, "memories"), false);

    // The mirror case: current under this process's own signature is still
    // searchable — the new check must not reject every current store.
    await store.updateVecMeta("memories", { status: VEC_STATUS.CURRENT, signature: SIG_A });
    assert.equal(await isVectorSearchable(store, "memories"), true);
  });

  test("vectorGate returns a synchronous predicate, never a promise", async () => {
    // The codegraph/docgraph backends do `vectorEnabled?.() ?? false` inline.
    // A promise there is always truthy, which would re-enable vector search
    // for exactly the stores that must not have it.
    await store.updateVecMeta("codegraph", { status: VEC_STATUS.STALE });

    const gate = await vectorGate(store, "codegraph", () => true);
    assert.equal(typeof gate, "function");
    const verdict = gate();
    assert.equal(typeof verdict, "boolean", "gate must return a boolean, not a thenable");
    assert.equal(verdict, false);

    const okGate = await vectorGate(store, "wiki", () => true);
    assert.equal(okGate(), true);
  });

  test("vectorGate stays false when vector support is off entirely", async () => {
    const gate = await vectorGate(store, "memories", () => false);
    assert.equal(gate(), false);
  });

  test("recall skips the query embedding while memories is stale", async () => {
    const { recallHandler } = await import("../../../lib/handlers/memory/memoryHandlers.js");
    const embedder = countingEmbedder();
    const ctx = { store, generateEmbedding: embedder, vectorEnabled: () => true, providerIsLocal: true };

    await recallHandler(ctx, { query: "anything", limit: 1 });
    assert.equal(embedder.calls, 1, "a current store should embed the query");

    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    await recallHandler(ctx, { query: "anything", limit: 1 });
    assert.equal(embedder.calls, 1, "a stale store must not embed the query — that is the FTS-only path");
  });

  test("an explicit semantic search is downgraded to full-text, not left unfiltered", async () => {
    // Both backends compute useText as `mode !== "semantic"`. Withholding the
    // embedding while still passing "semantic" turns off vector AND full-text
    // search, so recall degenerates into an unfiltered importance listing.
    const { recallHandler } = await import("../../../lib/handlers/memory/memoryHandlers.js");
    await store.insert({ type: "fact", title: "alpha unique-token-zzz", content: "alpha body" }, null);
    await store.insert({ type: "fact", title: "beta", content: "beta body" }, null);
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });

    const seen = [];
    const ctx = {
      store,
      generateEmbedding: countingEmbedder(),
      vectorEnabled: () => true,
      providerIsLocal: true,
    };
    const spy = { ...ctx, store: new Proxy(store, {
      get(t, k) {
        if (k === "recall") return (args) => { seen.push(args.mode); return t.recall(args); };
        const v = t[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) };

    await recallHandler(spy, { query: "unique-token-zzz", search_mode: "semantic", limit: 5 });
    assert.deepEqual(seen, ["fulltext"], "a stale store must receive fulltext mode, not semantic");
  });

  test("a status lookup failure fails closed rather than re-enabling vector search", async () => {
    // Guessing "searchable" on an error means silently wrong results; guessing
    // "not searchable" only means worse ones.
    const broken = new Proxy(store, {
      get(t, k) {
        if (k === "getVecMeta") return async () => { throw new Error("database is locked"); };
        const v = t[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    assert.equal(await isVectorSearchable(broken, "memories"), false);
    const gate = await vectorGate(broken, "codegraph", () => true);
    assert.equal(gate(), false);
  });

  test("dedup refuses to run against a stale store", async () => {
    // Dedup merges rows, so acting on cross-space "similarity" destroys data.
    const { dedupHandler } = await import("../../../lib/handlers/memory/memoryHandlers.js");
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    const res = await dedupHandler({ store, vectorEnabled: () => true }, { dry_run: true });
    assert.match(res.content[0].text, /reindex/i);
  });
});

// =============================================================================
// WS1.4 — resumable reindex
// =============================================================================
describe("WS1.4 — reindex is resumable and never double-embeds", () => {
  let store;

  before(async () => {
    store = await freshStore();
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
    for (let i = 0; i < 50; i++) {
      await store.insert({ type: "fact", title: `row ${String(i).padStart(2, "0")}`, content: `content ${i}` }, null);
    }
  });
  after(async () => { await store?.close?.(); });

  test("a killed reindex resumes and costs exactly one embedding call per row", async () => {
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });

    // Not 50: SqliteStore seeds baseline memories on a fresh database, and
    // those need embedding too. Derive the real figure rather than assuming.
    const total = (await store.listWithoutEmbeddings()).length;
    assert.ok(total >= 50, `expected at least the 50 inserted rows, got ${total}`);

    // Run 1: abort partway, simulating a killed process.
    const controller = new AbortController();
    const first = countingEmbedder();
    const abortingEmbedder = async (text) => {
      const v = await first(text);
      if (first.calls >= 20) controller.abort();
      return v;
    };
    await runReindex(store, {
      generateEmbedding: abortingEmbedder, signature: SIG_A, dims: 1024,
      stores: ["memories"], signal: controller.signal,
    });

    assert.equal(first.calls, 20);
    let row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.REINDEXING, "an interrupted store must stay reindexing, not fall back to stale");

    // Run 2: resume. Must not clear what run 1 completed.
    const second = countingEmbedder();
    await runReindex(store, {
      generateEmbedding: second, signature: SIG_A, dims: 1024, stores: ["memories"],
    });

    assert.equal(second.calls, total - 20, "resume must embed only the rows the first run did not reach");
    assert.equal(first.calls + second.calls, total, "total embedding calls must equal the row count exactly");

    row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.CURRENT);
    assert.equal((await store.listWithoutEmbeddings()).length, 0);
    assert.equal(await isVectorSearchable(store, "memories"), true);
  });

  test("a restart does not restart the reindex — checkEmbeddingProvider preserves reindexing state", async () => {
    // The real resume path. On restart checkEmbeddingProvider runs again; if it
    // reset a reindexing store back to stale, every restart would re-clear the
    // vectors and the reindex would never finish on a large corpus.
    await store.updateVecMeta("memories", { status: VEC_STATUS.REINDEXING });
    const pendingBefore = (await store.listWithoutEmbeddings()).length;

    await checkEmbeddingProvider(store);

    const row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.REINDEXING, "an unchanged signature must leave reindexing state alone");
    assert.equal(
      (await store.listWithoutEmbeddings()).length, pendingBefore,
      "a restart must not re-clear vectors that a previous run already rebuilt"
    );
  });

  test("a store with nothing to embed completes instead of sticking in reindexing", async () => {
    // The "killed on the very last row" edge case: on resume there is no work
    // left, and the store must still reach current.
    await store.updateVecMeta("self_memories", { status: VEC_STATUS.REINDEXING });
    const embedder = countingEmbedder();
    await runReindex(store, {
      generateEmbedding: embedder, signature: SIG_A, dims: 1024, stores: ["self_memories"],
    });
    const row = await store.getVecMeta("self_memories");
    assert.equal(row.status, VEC_STATUS.CURRENT);
  });

  test("a provider that returns nothing leaves the store reindexing for the next run", async () => {
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    const dead = async () => null;
    const { results } = await runReindex(store, {
      generateEmbedding: dead, signature: SIG_A, dims: 1024, stores: ["memories"],
    });
    assert.equal(results[0].completed, false);
    assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.REINDEXING);
    assert.equal(await isVectorSearchable(store, "memories"), false);

    // And a later healthy run finishes the job.
    const good = countingEmbedder();
    await runReindex(store, { generateEmbedding: good, signature: SIG_A, dims: 1024, stores: ["memories"] });
    assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.CURRENT);
  });

  test("only stale/reindexing stores are touched", async () => {
    const pending = await listPendingStores(store);
    assert.equal(pending.length, 0, "everything should be current by now");

    const embedder = countingEmbedder();
    const { results } = await runReindex(store, { generateEmbedding: embedder, signature: SIG_A, dims: 1024 });
    assert.deepEqual(results, []);
    assert.equal(embedder.calls, 0, "a fully current database must cost zero embedding calls");
  });
});

// =============================================================================
// A write failure must fail only that row, not the whole run (review finding P2)
// =============================================================================
describe("a persist failure degrades to a retryable row, not a crashed run", () => {
  test("the store closing mid-write (e.g. graceful shutdown) fails only that row", async () => {
    // Models a graceful shutdown whose 1.5s budget elapses while a row's
    // embedding call is still in flight (see lib/server/shutdown.js): the
    // outer process moves on and may close the store before this loop's next
    // write lands. Before this fix, setEmbedding throwing here (e.g. "database
    // connection is not open") would escape reindexOne's row loop entirely —
    // aborting every remaining row and store in this run, not just this one.
    const store = await freshStore();
    try {
      await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
      for (let i = 0; i < 5; i++) {
        await store.insert({ type: "fact", title: `row ${i}`, content: `content ${i}` }, null);
      }
      await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
      const total = (await store.listWithoutEmbeddings()).length;
      assert.ok(total >= 5, `expected at least the 5 inserted rows, got ${total}`);

      let calls = 0;
      const flaky = new Proxy(store, {
        get(t, k) {
          if (k === "setEmbedding") {
            return async (...args) => {
              calls++;
              if (calls === 1) throw new Error("database connection is not open");
              return t.setEmbedding(...args);
            };
          }
          const v = t[k];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });

      const { results } = await runReindex(flaky, {
        generateEmbedding: countingEmbedder(), signature: SIG_A, dims: 1024, stores: ["memories"],
      });

      assert.equal(results[0].failed, 1, "exactly the one failed write must be counted");
      assert.equal(results[0].completed, false, "a failed row must keep the store out of `current`");
      assert.equal(
        (await store.getVecMeta("memories")).status, VEC_STATUS.REINDEXING,
        "must stay reindexing, not crash the run or silently finalize"
      );

      // The failed row is retried on the very next run rather than lost.
      const retry = countingEmbedder();
      await runReindex(store, { generateEmbedding: retry, signature: SIG_A, dims: 1024, stores: ["memories"] });
      assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.CURRENT);
      assert.equal((await store.listWithoutEmbeddings()).length, 0);
    } finally {
      await store.close?.();
    }
  });
});

// =============================================================================
// WS1.3 + 1.4 — a provider change goes stale, then heals
// =============================================================================
describe("provider change end-to-end", () => {
  test("changing provider marks stale without deleting, then reindex restores search", async () => {
    const store = await freshStore();
    try {
      const kept = await store.insert({ type: "fact", title: "kept", content: "body" }, fakeVector());
      await checkEmbeddingProvider(store);
      assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.CURRENT);
      assert.equal(await store.hasEmbedding(kept.id), true);

      // Flip the provider.
      process.env.EMBEDDING_PROVIDER = "voyage";
      try {
        await checkEmbeddingProvider(store);

        const row = await store.getVecMeta("memories");
        assert.equal(row.status, VEC_STATUS.STALE);
        assert.equal(row.signature, SIG_B);
        assert.equal(await isVectorSearchable(store, "memories"), false);

        // Mark-stale, not delete: the old vector is still on disk at this point.
        assert.equal(await store.hasEmbedding(kept.id), true, "the old vector must survive detection — deletion happens at reindex, not at detection");

        const embedder = countingEmbedder();
        await runReindex(store, { generateEmbedding: embedder, signature: SIG_B, dims: 1024 });
        assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.CURRENT);
        assert.equal(await isVectorSearchable(store, "memories"), true);
        assert.equal(await store.hasEmbedding(kept.id), true, "reindex must have re-embedded the row in the new space");
      } finally {
        process.env.EMBEDDING_PROVIDER = "transformers";
      }
    } finally {
      await store.close?.();
    }
  });
});

// =============================================================================
// WS1.6 — dimension change through the tracked path
// =============================================================================
describe("WS1.6 — dimension change", () => {
  test("a dims change resizes storage, marks every store stale, and reindexes at the new width", async () => {
    const store = await freshStore();
    try {
      const before = await store.insert({ type: "fact", title: "before", content: "body" }, fakeVector(1024));
      await checkEmbeddingProvider(store);
      assert.equal(await store.getVectorDims(), 1024);

      process.env.EMBEDDING_PROVIDER = "voyage";
      process.env.VOYAGE_MODEL = "voyage-3-large";
      process.env.EMBEDDING_DIMS = "512";
      try {
        await checkEmbeddingProvider(store);

        assert.equal(await store.getVectorDims(), 512, "vector storage must be physically resized");
        const rows = await store.listVecMeta();
        for (const r of rows) {
          assert.equal(r.status, VEC_STATUS.STALE, `${r.store_name} must be stale — a resize destroys every vector`);
          assert.equal(r.dims, 512);
        }

        // Backfill at the new width must actually be storable.
        const embedder = countingEmbedder(512);
        await runReindex(store, { generateEmbedding: embedder, signature: "voyage:voyage-3-large:512", dims: 512 });

        const memories = await store.getVecMeta("memories");
        assert.equal(memories.status, VEC_STATUS.CURRENT);
        assert.equal(memories.dims, 512);
        assert.equal(await store.hasEmbedding(before.id), true);
        assert.equal(await isVectorSearchable(store, "memories"), true);
      } finally {
        process.env.EMBEDDING_PROVIDER = "transformers";
        process.env.EMBEDDING_DIMS = "1024";
        delete process.env.VOYAGE_MODEL;
      }
    } finally {
      await store.close?.();
    }
  });
});

// =============================================================================
// WS1.5 — the CLI
// =============================================================================
describe("WS1.5 — embeddings:reindex CLI", () => {
  let store;
  let embedCalls;

  before(async () => {
    // Drive the real generateEmbedding path with a stub pipeline rather than
    // loading the ONNX model — this is the seam embeddings.js already exposes.
    const { _setTransformersPipeline } = await import("../../../lib/helpers/embeddings.js");
    _setTransformersPipeline(async () => {
      embedCalls++;
      return { data: Float32Array.from(fakeVector(1024)) };
    });
  });

  after(async () => {
    const { _setTransformersPipeline } = await import("../../../lib/helpers/embeddings.js");
    _setTransformersPipeline(null);
    await store?.close?.();
  });

  beforeEach(async () => {
    await store?.close?.();
    store = await freshStore();
    embedCalls = 0;
  });

  // The store is injected, so the CLI runs against exactly the database the
  // test seeded and does not close it out from under the next test.
  async function runCli(argv) {
    const { main } = await import("../../../scripts/embeddings-reindex.js");
    const lines = [];
    const code = await main(argv, {
      log: (m) => lines.push(String(m)),
      error: (m) => lines.push(String(m)),
      store,
    });
    return { code, out: lines.join("\n") };
  }

  test("--status reports every store and reindexes nothing", async () => {
    const { code, out } = await runCli(["--status"]);
    assert.equal(code, 0, out);
    for (const name of VECTOR_STORES) assert.match(out, new RegExp(name));
    assert.equal(embedCalls, 0, "--status must never embed anything");
  });

  test("exits 0 with nothing to do when every store is current", async () => {
    const { code, out } = await runCli([]);
    assert.equal(code, 0, out);
    assert.match(out, /Nothing to do/i);
    assert.equal(embedCalls, 0);
  });

  test("rejects an unknown --store with a non-zero exit", async () => {
    const { code, out } = await runCli(["--store", "nope"]);
    assert.equal(code, 2);
    assert.match(out, /Unknown store/i);
  });

  test("reindexes only the stale stores and leaves current ones untouched", async () => {
    await store.insert({ type: "fact", title: "cli row", content: "body" }, null);
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    await store.updateVecMeta("wiki", { status: VEC_STATUS.STALE });

    const { code, out } = await runCli([]);
    assert.equal(code, 0, out);

    assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.CURRENT);
    assert.equal((await store.getVecMeta("wiki")).status, VEC_STATUS.CURRENT);
    // The three stores that were already current must not have been rebuilt.
    for (const name of ["self_memories", "codegraph", "docgraph"]) {
      assert.doesNotMatch(out, new RegExp(`${name}\\s+\\d+/\\d+ embedded`), `${name} should not have been reindexed`);
    }
    assert.ok(embedCalls > 0, "the stale stores' rows should actually have been embedded");
  });

  test("--store limits the run to the named stores", async () => {
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    await store.updateVecMeta("wiki", { status: VEC_STATUS.STALE });

    const { code } = await runCli(["--store", "memories"]);
    assert.equal(code, 0);
    assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.CURRENT);
    assert.equal((await store.getVecMeta("wiki")).status, VEC_STATUS.STALE, "an unselected store must be left alone");
  });

  // Review follow-up: the server guards a disabled provider in
  // hydrateRuntime.js, but the CLI reaches runReindex directly and had no
  // equivalent guard — it would clear a stale store's vectors, fail every row
  // against the null provider, and strand the store in `reindexing`.
  test("refuses to reindex when embeddings are disabled, without clearing vectors", async () => {
    const kept = await store.insert({ type: "fact", title: "kept", content: "body" }, fakeVector());
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });

    const oldProvider = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = "none";
    let code, out;
    try {
      ({ code, out } = await runCli([]));
    } finally {
      process.env.EMBEDDING_PROVIDER = oldProvider;
    }

    assert.equal(code, 1, out);
    assert.match(out, /disabled/i);
    assert.equal(embedCalls, 0, "a disabled provider must never trigger an embed call");
    assert.equal(await store.hasEmbedding(kept.id), true, "the existing vector must survive");
    assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.STALE, "must not be left claimed mid-reindex");
  });

  // --status must still work read-only while embeddings are disabled — only
  // an actual reindex attempt is refused.
  test("--status still reports while embeddings are disabled", async () => {
    const oldProvider = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = "none";
    let code, out;
    try {
      ({ code, out } = await runCli(["--status"]));
    } finally {
      process.env.EMBEDDING_PROVIDER = oldProvider;
    }
    assert.equal(code, 0, out);
    assert.equal(embedCalls, 0);
  });
});

// =============================================================================
// Concurrent runners — atomic claim + lease (review follow-up)
// =============================================================================
describe("reindex ownership across concurrent runners", () => {
  let store;
  beforeEach(async () => {
    await store?.close?.();
    store = await freshStore();
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
    for (let i = 0; i < 5; i++) {
      await store.insert({ type: "fact", title: `row ${i}`, content: `content ${i}` }, null);
    }
  });
  after(async () => { await store?.close?.(); });

  test("only one runner can claim a store", async () => {
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    const first = await store.claimVecMetaReindex("memories", "runner-a", 60_000);
    assert.equal(first.claimed, true);
    assert.equal(first.previousStatus, VEC_STATUS.STALE, "the claim must report the pre-claim status");

    const second = await store.claimVecMetaReindex("memories", "runner-b", 60_000);
    assert.equal(second.claimed, false, "a live lease must block a second runner");

    // The same runner re-entering is fine (a resumed run reclaims its store).
    assert.equal((await store.claimVecMetaReindex("memories", "runner-a", 60_000)).claimed, true);
  });

  test("a current store cannot be claimed at all", async () => {
    assert.equal((await store.claimVecMetaReindex("memories", "runner-a", 60_000)).claimed, false);
  });

  test("an expired lease is reclaimable, so a crashed runner cannot block a store forever", async () => {
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    assert.equal((await store.claimVecMetaReindex("memories", "dead-runner", -1000)).claimed, true);
    const taken = await store.claimVecMetaReindex("memories", "live-runner", 60_000);
    assert.equal(taken.claimed, true, "an expired lease must be takeable");
    assert.equal(taken.previousStatus, VEC_STATUS.REINDEXING);
  });

  // Review follow-up: without binding the claim to the target signature, a
  // configuration change landing between listPendingStores() and this claim
  // let the runner claim, clear and rebuild a row that had already moved on
  // to a different target, then finalize it as current under its own stale
  // signature — cross-space vectors served as current.
  test("a claim bound to a stale signature is refused once the row is retargeted", async () => {
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE, signature: SIG_A });
    // Simulate another process retargeting the row before this claim lands.
    await store.updateVecMeta("memories", { signature: SIG_B });

    const claim = await store.claimVecMetaReindex("memories", "runner-a", 60_000, SIG_A);
    assert.equal(claim.claimed, false, "a claim bound to the old target must not win a retargeted row");

    const row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.STALE, "the retargeted row must be untouched by the refused claim");
    assert.equal(row.reindex_owner, null);
  });

  test("runReindex end-to-end: a row retargeted before the claim is left for the new target", async () => {
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    // The row has already moved on to SIG_B by the time this call's own claim
    // runs, even though it called runReindex targeting SIG_A.
    await store.updateVecMeta("memories", { signature: SIG_B });

    const embedder = countingEmbedder();
    const { results } = await runReindex(store, {
      generateEmbedding: embedder, signature: SIG_A, dims: 1024, stores: ["memories"], owner: "stale-runner",
    });

    assert.equal(embedder.calls, 0, "a retargeted row must not be embedded toward the caller's stale signature");
    assert.equal(results[0].skipped, true);
    const row = await store.getVecMeta("memories");
    assert.equal(row.signature, SIG_B, "the new target must survive untouched by the stale caller");
    assert.equal(row.status, VEC_STATUS.STALE);
  });

  test("renew fails once another runner owns the store", async () => {
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    await store.claimVecMetaReindex("memories", "runner-a", -1000);
    await store.claimVecMetaReindex("memories", "runner-b", 60_000);
    assert.equal(await store.renewVecMetaLease("memories", "runner-a", 60_000), false);
    assert.equal(await store.renewVecMetaLease("memories", "runner-b", 60_000), true);
  });

  test("a second runner skips a store that is already claimed instead of double-embedding", async () => {
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    // Simulate a live runner holding the store.
    await store.claimVecMetaReindex("memories", "other-process", 60_000);

    const embedder = countingEmbedder();
    const { results } = await runReindex(store, {
      generateEmbedding: embedder, signature: SIG_A, dims: 1024, stores: ["memories"], owner: "me",
    });

    assert.equal(embedder.calls, 0, "a claimed store must not be embedded by a second runner");
    assert.equal(results[0].skipped, true);
    // And the other runner's work is untouched: still reindexing, still owned.
    const row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.REINDEXING);
    assert.equal(row.reindex_owner, "other-process");
  });

  test("a completed reindex releases the lease", async () => {
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    await runReindex(store, {
      generateEmbedding: countingEmbedder(), signature: SIG_A, dims: 1024, stores: ["memories"], owner: "me",
    });
    const row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.CURRENT);
    assert.equal(row.reindex_owner, null, "a finished store must not stay claimed");
  });

  test("a lease lost mid-embedding stops the run before it writes or marks current", async () => {
    // The window this closes: one slow embedding call outlasting the lease. The
    // runner used to wake up, write into a store another process now owns, and
    // — on the last row — call markCurrent, which also drops the new owner's
    // lease and declares their half-rebuilt store current.
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });

    let embedded = 0;
    const slowEmbedder = async () => {
      embedded++;
      // The takeover happens while this call is in flight.
      if (embedded === 1) {
        await store.updateVecMeta("memories", {
          reindex_owner: "other-process",
          reindex_expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      return fakeVector();
    };

    const { results } = await runReindex(store, {
      generateEmbedding: slowEmbedder, signature: SIG_A, dims: 1024, stores: ["memories"], owner: "me",
    });

    assert.equal(results[0].completed, false, "a runner that lost its store must not complete it");
    assert.equal(results[0].done, 0, "the vector produced by the in-flight call must not be written");
    assert.equal(embedded, 1, "the loop must stop at the first lost-ownership check, not keep embedding");

    const row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.REINDEXING, "the store must not be flipped to current by a runner that lost it");
    assert.equal(row.reindex_owner, "other-process", "the real owner's lease must survive");
    assert.equal(await isVectorSearchable(store, "memories"), false);
  });
});

// =============================================================================
// The clear checkpoint — crash between claiming and clearing (review follow-up)
// =============================================================================
describe("reindex clears exactly once, even across a crash", () => {
  let store;
  beforeEach(async () => {
    await store?.close?.();
    store = await freshStore();
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
  });
  after(async () => { await store?.close?.(); });

  test("a crash between the status write and the clear does not leave old vectors declared current", async () => {
    // Reproduces the window directly: claim the store (status → reindexing),
    // then die before clearing. Every row still has its old-space vector, so a
    // resume that trusts the status alone finds nothing pending and marks the
    // store current — serving the previous provider's vectors as if they
    // matched the running configuration.
    const kept = await store.insert({ type: "fact", title: "kept", content: "body" }, fakeVector());
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE, signature: SIG_B });

    // The dead runner's lease is left to age out, as a killed process leaves it.
    const claim = await store.claimVecMetaReindex("memories", "crashed-runner", -1000);
    assert.equal(claim.claimed, true);
    assert.equal(claim.vectorsCleared, false, "a fresh claim on a stale store has not cleared anything yet");
    assert.equal(await store.hasEmbedding(kept.id), true, "the crash happens before the clear");

    // The pending scan does not see the kept row: it still has its old-space
    // vector. So if the resumed run clears as it must, it embeds one row more
    // than the scan currently reports — and if it wrongly trusts the status and
    // skips the clear, it embeds exactly the scan's count and then declares the
    // store current with an old-space vector still in it.
    const pendingBeforeResume = (await store.listWithoutEmbeddings()).length;

    const embedder = countingEmbedder();
    const { results } = await runReindex(store, {
      generateEmbedding: embedder, signature: SIG_B, dims: 1024, stores: ["memories"], owner: "resumed-runner",
    });

    assert.equal(
      embedder.calls, pendingBeforeResume + 1,
      "the resumed run must clear and re-embed the row whose vector was never cleared"
    );
    assert.equal(results[0].completed, true);
    assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.CURRENT);
    assert.equal((await store.listWithoutEmbeddings()).length, 0);
  });

  test("a resume after the clear does not clear again", async () => {
    // The other direction: once the checkpoint is set, re-clearing would throw
    // away every row an earlier run already rebuilt.
    for (let i = 0; i < 5; i++) {
      await store.insert({ type: "fact", title: `row ${i}`, content: `body ${i}` }, null);
    }
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });

    const controller = new AbortController();
    const first = countingEmbedder();
    const abortingEmbedder = async (text) => {
      const v = await first(text);
      if (first.calls >= 3) controller.abort();
      return v;
    };
    await runReindex(store, {
      generateEmbedding: abortingEmbedder, signature: SIG_A, dims: 1024,
      stores: ["memories"], signal: controller.signal,
    });

    const row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.REINDEXING);
    assert.ok(row.vectors_cleared, "the clear must be checkpointed once it has happened");
    const embeddedAfterFirst = 3;

    const remaining = (await store.listWithoutEmbeddings()).length;
    const second = countingEmbedder();
    await runReindex(store, {
      generateEmbedding: second, signature: SIG_A, dims: 1024, stores: ["memories"],
    });
    assert.equal(second.calls, remaining, "a resume must not re-clear and re-embed what run 1 finished");
    assert.equal(first.calls, embeddedAfterFirst);
  });

  test("re-staling a store resets the checkpoint so the next reindex clears again", async () => {
    // A second configuration change while a reindex is in flight must start
    // over: the half-rebuilt vectors belong to a space nothing will use.
    await store.updateVecMeta("memories", { status: VEC_STATUS.REINDEXING, vectors_cleared: true });
    await store.updateVecMeta("memories", { signature: SIG_B });

    const { markStaleWhereChanged } = await import("../../../lib/helpers/vecMeta.js");
    await markStaleWhereChanged(store, { signature: SIG_A, dims: 1024 });

    const row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.STALE);
    assert.ok(!row.vectors_cleared, "a new target must re-arm the clear");
  });
});

// =============================================================================
// Finalizing a completed reindex — atomic against a concurrent target change
// (review follow-up: a separate renew-then-markCurrent pair left a window
// where a config change landing between the two calls got overwritten by the
// old runner's unconditional final write.)
// =============================================================================
describe("finalizing a completed reindex is atomic against a concurrent target change", () => {
  let store;
  beforeEach(async () => {
    await store?.close?.();
    store = await freshStore();
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
  });
  after(async () => { await store?.close?.(); });

  test("a config change between the last embed and finalize is not overwritten", async () => {
    const { finalizeCurrent, markStaleWhereChanged } = await import("../../../lib/helpers/vecMeta.js");

    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    const claim = await store.claimVecMetaReindex("memories", "runner-a", 60_000);
    assert.equal(claim.claimed, true);

    // The runner has finished embedding every row toward SIG_A and is about
    // to finalize — exactly when another process reassigns the store to a
    // new target. This is the race a separate renew-then-markCurrent pair
    // could straddle; finalizeCurrent must not be able to.
    await markStaleWhereChanged(store, { signature: SIG_B, dims: 1024 });

    const finalized = await finalizeCurrent(store, "memories", "runner-a", { signature: SIG_A, dims: 1024 });
    assert.equal(finalized, false, "finalize must refuse once the target moved out from under it");

    const row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.STALE, "the new target's stale status must survive the old runner's finalize");
    assert.equal(row.signature, SIG_B, "the new target's signature must not be overwritten by the old runner's target");
  });

  test("finalize succeeds when nothing raced it", async () => {
    const { finalizeCurrent } = await import("../../../lib/helpers/vecMeta.js");

    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    await store.claimVecMetaReindex("memories", "runner-a", 60_000);

    const finalized = await finalizeCurrent(store, "memories", "runner-a", { signature: SIG_A, dims: 1024 });
    assert.equal(finalized, true);

    const row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.CURRENT);
    assert.equal(row.reindex_owner, null, "a finished store must not stay claimed");
  });
});

// =============================================================================
// Multi-source (codegraph/docgraph) adapters — a source already swept must be
// re-swept before the store finalizes (code review follow-up on issue #287:
// a root's watcher.js can defer its own embedding to this driver, trusting it
// hasn't passed that root yet; `sources` is only snapshotted once per store,
// so without a re-sweep, a root visited early in the run could gain new
// pending rows from that watcher after this driver moved on, and those rows
// would never be embedded by anyone once the store reaches `current`).
// =============================================================================
describe("reindexOne re-sweeps sources before finalizing a multi-root store", () => {
  let store;
  beforeEach(async () => {
    await store?.close?.();
    store = await freshStore();
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
    await store.updateVecMeta("codegraph", { status: VEC_STATUS.STALE });
  });
  after(async () => { await store?.close?.(); });

  // Mirrors tests/integration/codegraph/backends/sqlite.test.js's direct
  // seeding helper — bypasses indexRepo/chokidar entirely since this test
  // only needs rows in cg_repos/cg_files/cg_symbols, not real files on disk.
  async function seedSymbol(db, { name, root }) {
    db.prepare(`INSERT OR IGNORE INTO cg_repos (root_path) VALUES (?)`).run(root);
    const repoId = db.prepare(`SELECT id FROM cg_repos WHERE root_path = ?`).get(root).id;
    db.prepare(`INSERT INTO cg_files (repo_id, path, language, sha256, mtime) VALUES (?, ?, 'js', 'x', 'x')`)
      .run(repoId, `${name}.js`);
    const fileId = db.prepare(`SELECT id FROM cg_files WHERE repo_id = ? AND path = ?`).get(repoId, `${name}.js`).id;
    const info = db.prepare(`
      INSERT INTO cg_symbols (file_id, kind, name, qualified, start_line, end_line)
      VALUES (?, 'function', ?, ?, 1, 1)
    `).run(fileId, name, name);
    return Number(info.lastInsertRowid);
  }

  test("a row inserted into an already-swept root mid-run still gets embedded", async () => {
    const rootA = "/repo/root-a";
    const rootB = "/repo/root-b";
    await seedSymbol(store.db, { name: "fnA1", root: rootA });
    await seedSymbol(store.db, { name: "fnB1", root: rootB });

    // listRepoRoots orders by root_path, so root-a is swept before root-b.
    // While the driver embeds root-b's row, simulate a watcher's indexRepo
    // pass landing a brand-new unembedded symbol back into root-a — a root
    // this run already found empty and moved past.
    let calls = 0;
    const embedder = async () => {
      calls++;
      if (calls === 2) {
        await seedSymbol(store.db, { name: "fnA2-late", root: rootA });
      }
      return fakeVector();
    };

    const { results } = await runReindex(store, {
      generateEmbedding: embedder, signature: SIG_A, dims: 1024, stores: ["codegraph"], owner: "me",
    });

    assert.equal(results[0].completed, true, "the run must finalize once every source is truly quiescent");
    assert.equal(calls, 3, "the late row must cost exactly one more embedding call, not zero");

    const { listPendingEmbeddings } = await import("../../../lib/codegraph/indexer.js");
    const stillPending = await listPendingEmbeddings(store, rootA, { limit: 10 });
    assert.deepEqual(stillPending, [], "the late row must not be left permanently unembedded");

    const row = await store.getVecMeta("codegraph");
    assert.equal(row.status, VEC_STATUS.CURRENT);
  });

  test("exhausting settle rounds under sustained concurrent writes leaves the store reindexing, not current (review finding P2)", async () => {
    const rootA = "/repo/root-a";
    const rootB = "/repo/root-b";
    await seedSymbol(store.db, { name: "fnA1", root: rootA });
    await seedSymbol(store.db, { name: "fnB1", root: rootB });

    // Every embedded row lands one fresh row on the *other* root — a
    // stand-in for two watchers under sustained concurrent writes, each
    // landing new work while this run is mid-sweep of the other root's
    // pending scan. Neither root is ever quiet at the same time, so no
    // settle round can find "nothing left anywhere" and it is the round
    // budget, not quiescence, that has to stop the run.
    let aIdx = 2;
    let bIdx = 2;
    const embedder = async (text) => {
      if (text.startsWith("fnA")) {
        await seedSymbol(store.db, { name: `fnB${bIdx++}`, root: rootB });
      } else {
        await seedSymbol(store.db, { name: `fnA${aIdx++}`, root: rootA });
      }
      return fakeVector();
    };

    const { results } = await runReindex(store, {
      generateEmbedding: embedder, signature: SIG_A, dims: 1024, stores: ["codegraph"], owner: "me",
    });

    assert.equal(results[0].failed, 0, "every embedding call succeeds in this scenario");
    assert.equal(results[0].completed, false, "sustained writes must not let the run finalize as current");

    const row = await store.getVecMeta("codegraph");
    assert.equal(row.status, VEC_STATUS.REINDEXING, "the store must stay reindexing so a later run can resume and confirm quiescence");
  });
});

// =============================================================================
// Issue #340 — ordinary writes must not plant a foreign-signature vector
//
// isVectorSearchable() gates the READ path. Until this, nothing gated the
// WRITE path: any ordinary write persisted whatever the *writing process's*
// EMBEDDING_PROVIDER produced, with no reference to the target store's
// vec_meta status. Because vectors are opaque blobs with no per-row
// provenance, a foreign-space vector landing on a freshly-cleared row is
// invisible afterwards — the row stops matching the driver's missing-vector
// pending scan, the settle pass finds nothing left, and the store finalizes
// `current` holding two embedding spaces under a store-level signature that
// looks perfectly correct.
// =============================================================================
describe("issue #340 — write-time signature gate", () => {
  let store;
  beforeEach(async () => {
    await store?.close?.();
    store = await freshStore();
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
  });
  after(async () => { await store?.close?.(); });

  const ctxFor = (embedder, extra = {}) => ({
    store, generateEmbedding: embedder, vectorEnabled: () => true, ...extra,
  });

  // A fresh store ships with seeded memories and wiki articles, all of them
  // unembedded — so "is there an unembedded row" proves nothing here. Every
  // assertion below has to name the row the test actually wrote.
  const rememberedId = (res) => {
    const m = res.content[0].text.match(/\(id: ([0-9a-f-]{36})\)/i);
    assert.ok(m, `could not read the new memory id out of: ${res.content[0].text}`);
    return m[1];
  };

  test("canPersistEmbedding refuses exactly what isVectorSearchable refuses", async () => {
    // One notion of "this store's vectors are mine", both directions. If these
    // ever diverge, a store can be readable but unwritable (or worse).
    for (const status of [VEC_STATUS.CURRENT, VEC_STATUS.STALE, VEC_STATUS.REINDEXING]) {
      await store.updateVecMeta("memories", { status });
      assert.equal(
        await canPersistEmbedding(store, "memories"),
        await isVectorSearchable(store, "memories"),
        `write gate and read gate disagree at status=${status}`
      );
    }
  });

  for (const status of [VEC_STATUS.STALE, VEC_STATUS.REINDEXING]) {
    test(`remember writes the row bare while the store is ${status}`, async () => {
      await store.updateVecMeta("memories", { status });
      const embedder = countingEmbedder();

      const res = await rememberHandler(ctxFor(embedder), { title: "t", content: "c" });

      assert.equal(embedder.calls, 0, "a closed gate must skip the inference entirely, not just discard it");
      assert.equal(await store.hasEmbedding(rememberedId(res)), false, "no vector may land while the store is not ours to write");
      assert.match(res.content[0].text, /reindexed/, "the tool result must say why semantic search is missing");
    });
  }

  test("remember writes the row bare while the store is current under ANOTHER process's signature", async () => {
    // The nastiest case: status is `current`, so a status-only check would
    // wave this through. Only the signature comparison catches it.
    await store.updateVecMeta("memories", { signature: SIG_B, status: VEC_STATUS.CURRENT });
    const embedder = countingEmbedder();

    const res = await rememberHandler(ctxFor(embedder), { title: "t", content: "c" });

    assert.equal(embedder.calls, 0);
    assert.equal(await store.hasEmbedding(rememberedId(res)), false);
  });

  test("a gate that closes DURING the embedding call still blocks the write", async () => {
    // This is the whole reason the gate is checked on both sides of the model
    // call. The embedding is by far the slowest thing on the write path; an
    // early-only check would leave a window the length of a full inference for
    // a reindex to claim the store, and the vector would land anyway.
    const embedder = async () => {
      await markReindexing(store, "memories");
      return fakeVector();
    };

    const res = await rememberHandler(ctxFor(embedder), { title: "t", content: "c" });

    assert.equal(
      await store.hasEmbedding(rememberedId(res)), false,
      "a reindex that started mid-inference must still win — this is the late check's only job"
    );
  });

  test("a deferred write is never handed to the retry queue", async () => {
    // The queue would re-race the same gate three times and then drop the row
    // anyway. Worse, a queue held open for the length of a reindex is
    // unbounded growth on a busy store.
    await markReindexing(store, "memories");
    const enqueued = [];
    const embedder = countingEmbedder();
    await rememberHandler(
      ctxFor(embedder, { embeddingQueue: { enqueue: (id, text) => enqueued.push({ id, text }) } }),
      { title: "t", content: "c" }
    );
    assert.equal(embedder.calls, 0, "gate must have refused — otherwise this test proves nothing");
    assert.deepEqual(enqueued, [], "the reindex driver owns this row, not the retry queue");
  });

  test("embedForStore reports deferral distinctly from an ordinary embedding failure", async () => {
    // Callers branch on this: `deferred` means "the reindex driver owns this
    // row, do not queue it"; a null embedding without `deferred` is a provider
    // failure and must still go to the retry queue. Collapsing the two would
    // either abandon rows during an outage or re-race the gate forever.
    const failing = async () => null;
    assert.deepEqual(
      await embedForStore(store, "memories", failing),
      { embedding: null, deferred: false }
    );

    await markReindexing(store, "memories");
    assert.deepEqual(
      await embedForStore(store, "memories", async () => fakeVector()),
      { embedding: null, deferred: true }
    );
  });

  test("wiki_write is gated too — wiki is a tracked vector store", async () => {
    // Not in issue #340's original file list, but `wiki` is one of the five
    // VECTOR_STORES and wikiWriteHandler wrote its vector unconditionally.
    await markReindexing(store, "wiki");
    const embedder = countingEmbedder();

    const res = await wikiWriteHandler({ store, generateEmbedding: embedder },
      { slug: "a-page", title: "A Page", summary: "s", body_md: "body" });

    assert.match(res.content[0].text, /Created|Updated/, "the article itself must still be written");
    assert.equal(embedder.calls, 0, "no embedding may be computed for a store being reindexed");
    const pending = await store.wiki.listWithoutEmbeddings({ limit: 100, offset: 0 });
    assert.ok(
      pending.some(r => r.title === "A Page"),
      "the article must be left for the wiki reindex adapter to embed"
    );
  });

  test("an update that cannot embed does not queue the new row for retry", async () => {
    const mem = await store.insert({ type: "fact", title: "old", content: "body" }, fakeVector());
    await markReindexing(store, "memories");

    const enqueued = [];
    const embedder = countingEmbedder();
    await updateMemoryHandler(
      ctxFor(embedder, { embeddingQueue: { enqueue: (id) => enqueued.push(id) } }),
      { id: mem.id, content: "new body" }
    );
    assert.equal(embedder.calls, 0, "gate must have refused — otherwise this test proves nothing");
    assert.deepEqual(enqueued, []);
  });

  test("the reindex driver's own writes stay ungated", async () => {
    // The driver deliberately writes while status is `reindexing`. Gating its
    // adapters (or the shared low-level setters they call) would deadlock the
    // feature: nothing could ever leave `reindexing`.
    const mem = await store.insert({ type: "fact", title: "t", content: "c" }, null);
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });

    const embedder = countingEmbedder();
    await runReindex(store, { generateEmbedding: embedder, signature: SIG_A, dims: 1024, stores: ["memories"] });

    assert.ok(embedder.calls > 0, "the driver must embed while the store is reindexing");
    assert.equal(await store.hasEmbedding(mem.id), true);
    assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.CURRENT);
    assert.equal((await store.listWithoutEmbeddings()).length, 0);
  });

  test("end-to-end: a concurrent write mid-reindex is picked up by the driver, not planted", async () => {
    // The full mechanism from the issue. A "second process" lands an ordinary
    // remember() while this run is embedding. Before the write gate, that row
    // arrived WITH a vector from the other embedding space, dropped out of the
    // driver's missing-vector scan, and the store finalized `current` over a
    // mixed space. Now it arrives bare, the settle pass re-finds it, and the
    // driver embeds it under the signature that owns the store.
    await store.insert({ type: "fact", title: "existing", content: "body" }, null);
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });

    const otherProcess = countingEmbedder();
    let concurrentId = null;
    const driverEmbedder = async () => {
      if (!concurrentId) {
        concurrentId = rememberedId(
          await rememberHandler(ctxFor(otherProcess), { title: "concurrent", content: "landed mid-reindex" })
        );
      }
      return fakeVector();
    };

    const { results } = await runReindex(store, {
      generateEmbedding: driverEmbedder, signature: SIG_A, dims: 1024, stores: ["memories"], owner: "runner-a",
    });

    assert.equal(otherProcess.calls, 0, "the concurrent write must not have computed a vector at all");
    assert.equal(results[0].completed, true, "the driver must still be able to finish");
    assert.equal(
      await store.hasEmbedding(concurrentId), true,
      "the concurrently-written row must have been embedded by the driver's settle pass, in the driver's space"
    );
    assert.equal((await store.listWithoutEmbeddings()).length, 0);
    assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.CURRENT);
    assert.equal(await isVectorSearchable(store, "memories"), true);
  });
});

// =============================================================================
// A platform without sqlite-vec must not pay for embeddings it cannot use
// =============================================================================
describe("no vector support — stale is preserved, nothing is embedded", () => {
  let store;

  before(async () => {
    store = await freshStore();
    await ensureVecMeta(store, { signature: SIG_A, dims: 1024 });
    for (let i = 0; i < 5; i++) {
      await store.insert({ type: "fact", title: `unsupported ${i}`, content: `body ${i}` }, null);
    }
    // What SqliteStore.init() records on win32-arm64, where sqlite-vec has no
    // prebuilt extension: the sidecars exist as ordinary tables, so writes and
    // joins work and only `embedding MATCH ?` is impossible.
    store._vectorSupported = false;
  });
  after(async () => { await store?.close?.(); });

  test("runReindex costs zero embedding calls and leaves the store stale", async () => {
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });
    const pendingBefore = (await store.listWithoutEmbeddings()).length;
    assert.ok(pendingBefore > 0, "the fixture must actually have rows to embed");

    const embedder = countingEmbedder();
    const { supported, results } = await runReindex(store, {
      generateEmbedding: embedder, signature: SIG_A, dims: 1024, stores: ["memories"],
    });

    assert.equal(embedder.calls, 0, "an unsearchable store must never be embedded");
    assert.equal(supported, false);
    assert.deepEqual(results, []);

    // The marker is the record that this store owes a rebuild once the database
    // is opened where the extension loads — the guard must preserve it, not
    // clear it, and must not have taken the destructive clear step either.
    const row = await store.getVecMeta("memories");
    assert.equal(row.status, VEC_STATUS.STALE, "the stale marker must survive the skip");
    assert.equal(
      (await store.listWithoutEmbeddings()).length, pendingBefore,
      "no row may have been cleared or embedded"
    );
    assert.equal(await isVectorSearchable(store, "memories"), false);
  });

  test("the CLI refuses with a non-zero exit instead of silently doing nothing", async () => {
    await store.updateVecMeta("memories", { status: VEC_STATUS.STALE });

    const { main } = await import("../../../scripts/embeddings-reindex.js");
    const lines = [];
    const code = await main([], {
      log: (m) => lines.push(String(m)),
      error: (m) => lines.push(String(m)),
      store,
    });
    const out = lines.join("\n");

    assert.equal(code, 1, out);
    assert.match(out, /Vector search is unavailable/i);
    assert.equal((await store.getVecMeta("memories")).status, VEC_STATUS.STALE);
  });
});
