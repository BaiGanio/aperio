// tests/unit/codegraph/graphCache.test.js
//
// loadCachedGraph() is the (repoId, graph_revision)-keyed cache in front of
// backend.loadGraph() (A2D: "Codegraph loadGraph caching"). Neither the
// existing traversal tests nor the analysis-invalidation tests actually prove
// a warm read skips loadGraph — ensureAnalysis short-circuits before ever
// calling it. These tests exercise the cache module directly with a fake
// backend, asserting the thing that matters: loadGraph is called once per
// distinct revision, not once per request.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadCachedGraph, evictRepo, _cacheSize, MAX_ENTRIES_PER_STORE } from "../../../lib/codegraph/graphCache.js";

function fakeMod(revisionRef) {
  let loadGraphCalls = 0;
  return {
    loadGraphCalls: () => loadGraphCalls,
    async readRevisions() { return { graph_revision: revisionRef.value }; },
    async loadGraph() {
      loadGraphCalls++;
      return {
        nodes: [{ id: 1, qualified: "a", kind: "function", name: "a" }],
        edges: [],
      };
    },
  };
}

describe("loadCachedGraph()", () => {
  test("warm reads reuse the cached entry — loadGraph runs once", async () => {
    const store = {};
    const mod = fakeMod({ value: 1 });

    const first = await loadCachedGraph(mod, store, 1);
    const second = await loadCachedGraph(mod, store, 1);

    assert.equal(mod.loadGraphCalls(), 1, "second call must not re-hit loadGraph");
    assert.equal(second, first, "warm read returns the same cached entry object");
    assert.equal(first.graph.nodeCount, 1, "built adjacency index is included");
  });

  test("a graph_revision bump forces exactly one reload", async () => {
    const store = {};
    const rev = { value: 1 };
    const mod = fakeMod(rev);

    const first = await loadCachedGraph(mod, store, 1);
    rev.value = 2;
    const second = await loadCachedGraph(mod, store, 1);
    const third = await loadCachedGraph(mod, store, 1);

    assert.equal(mod.loadGraphCalls(), 2, "one reload for the new revision, then reused");
    assert.notEqual(second, first, "stale entry is replaced, not mutated in place");
    assert.equal(third, second, "post-bump reads are warm again");
  });

  test("different store instances never share a cache entry for the same repoId", async () => {
    const storeA = {};
    const storeB = {};
    const mod = fakeMod({ value: 1 });

    await loadCachedGraph(mod, storeA, 1);
    await loadCachedGraph(mod, storeB, 1);

    assert.equal(mod.loadGraphCalls(), 2, "each store gets its own cache, keyed off the store instance");
  });

  test("an unknown repo (readRevisions → null) is never cached", async () => {
    const store = {};
    const mod = {
      loadGraphCalls: 0,
      async readRevisions() { return null; },
      async loadGraph() { this.loadGraphCalls++; return { nodes: [], edges: [] }; },
    };

    await loadCachedGraph(mod, store, 999);
    await loadCachedGraph(mod, store, 999);

    assert.equal(mod.loadGraphCalls, 2, "no revision to key on means no caching, every read is a reload");
  });

  test("concurrent misses coalesce into a single loadGraph call", async () => {
    const store = {};
    let loadGraphCalls = 0;
    let resolveLoad;
    const mod = {
      async readRevisions() { return { graph_revision: 1 }; },
      async loadGraph() {
        loadGraphCalls++;
        return new Promise((resolve) => { resolveLoad = resolve; });
      },
    };

    const p1 = loadCachedGraph(mod, store, 1);
    const p2 = loadCachedGraph(mod, store, 1);

    // Let both calls run up through their readRevisions await before the
    // fetch resolves, without hardcoding a specific number of hops.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    assert.equal(loadGraphCalls, 1, "second concurrent miss must join the in-flight load, not start its own");
    resolveLoad({ nodes: [], edges: [] });

    const [entry1, entry2] = await Promise.all([p1, p2]);
    assert.equal(entry1, entry2, "both concurrent callers resolve to the same entry");
  });

  test("a newer revision does not join a stale in-flight load", async () => {
    const store = {};
    let loadGraphCalls = 0;
    let resolveOld;
    const revRef = { value: 1 };
    const mod = {
      async readRevisions() { return { graph_revision: revRef.value }; },
      async loadGraph() {
        loadGraphCalls++;
        if (loadGraphCalls === 1) return new Promise((resolve) => { resolveOld = resolve; });
        return { nodes: [{ id: 2, qualified: "b", kind: "function", name: "b" }], edges: [] };
      },
    };

    const p1 = loadCachedGraph(mod, store, 1); // kicks off a load for revision 1, hangs
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(loadGraphCalls, 1, "first load in flight");

    revRef.value = 2; // graph mutates while the revision-1 load is still pending
    const p2 = loadCachedGraph(mod, store, 1); // observes revision 2

    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(loadGraphCalls, 2, "a newer revision must start its own fetch, not join the stale in-flight one");

    const entry2 = await p2;
    assert.equal(entry2.revision, 2, "the fresh request resolves to the new revision's data");

    resolveOld({ nodes: [{ id: 1, qualified: "a", kind: "function", name: "a" }], edges: [] });
    const entry1 = await p1;
    assert.equal(entry1.revision, 1, "the stale caller still gets its own result, it just doesn't clobber the cache");

    const entry3 = await loadCachedGraph(mod, store, 1);
    assert.equal(entry3, entry2, "the late-resolving stale load must not overwrite the fresher cached entry");
    assert.equal(loadGraphCalls, 2, "reading the still-warm fresh entry triggers no extra reload");
  });

  test("a failed load is not cached — the next read retries", async () => {
    const store = {};
    let attempt = 0;
    const mod = {
      async readRevisions() { return { graph_revision: 1 }; },
      async loadGraph() {
        attempt++;
        if (attempt === 1) throw new Error("transient failure");
        return { nodes: [], edges: [] };
      },
    };

    await assert.rejects(loadCachedGraph(mod, store, 1), /transient failure/);
    const entry = await loadCachedGraph(mod, store, 1);

    assert.equal(attempt, 2, "a rejected load leaves no stale/poisoned cache entry behind");
    assert.ok(entry.graph);
  });

  test("evictRepo removes a cached entry immediately", async () => {
    const store = {};
    const mod = fakeMod({ value: 1 });

    await loadCachedGraph(mod, store, 1);
    assert.equal(_cacheSize(store), 1);

    evictRepo(store, 1);
    assert.equal(_cacheSize(store), 0);

    await loadCachedGraph(mod, store, 1);
    assert.equal(mod.loadGraphCalls(), 2, "post-eviction read is a real reload, e.g. after a repo is deleted");
  });

  test("cache size is bounded per store — LRU evicts the coldest repo", async () => {
    const store = {};
    const mod = fakeMod({ value: 1 });
    const repoCount = MAX_ENTRIES_PER_STORE + 5;

    for (let repoId = 1; repoId <= repoCount; repoId++) {
      await loadCachedGraph(mod, store, repoId);
    }

    assert.equal(_cacheSize(store), MAX_ENTRIES_PER_STORE, "cache never grows past its bound regardless of how many repos were queried");

    const before = mod.loadGraphCalls();
    await loadCachedGraph(mod, store, 1); // the coldest repo, queried first
    assert.equal(mod.loadGraphCalls(), before + 1, "an LRU-evicted repo reloads instead of phantom-hitting a stale entry");
  });
});
