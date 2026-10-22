// lib/codegraph/graphCache.js
// Per-process cache of a repo's materialized { nodes, edges } graph plus its
// built adjacency index (graph.js buildGraph()), keyed by (store, repoId,
// graph_revision). loadGraph() re-fetches every symbol/edge row on every call;
// for repos nearing 100k nodes that's wasted I/O + rebuild work on repeated
// shallow neighbors/path queries against an unchanged graph (#322 item 3).
//
// Invalidation is free: graph_revision already increments on every successful
// symbol/edge mutation (issue #283's compare-before-commit analysis snapshot
// uses the same counter), so a stale cache entry is detected by a single
// cheap row read instead of diffing the graph itself.
//
// Two things a naive version of this cache would get wrong, both addressed
// here:
//  - Retention: keyed by store via WeakMap so entries never outlive the store
//    instance, AND bounded per store via LRU eviction — a long-lived store
//    that has ever queried many repos (or repos later deleted without going
//    through evictRepo()) must not accumulate an unbounded number of full
//    node/edge snapshots. deleteRepo() in each backend calls evictRepo() so a
//    removed repo's snapshot doesn't linger until LRU pressure happens to
//    push it out.
//  - Stampede: concurrent callers hitting the same (repoId, revision) miss at
//    once (e.g. a burst of neighbors/path requests right after startup or a
//    mutation) would otherwise each independently re-fetch and rebuild the
//    whole graph. The in-flight load is cached as a promise, so concurrent
//    misses join the one fetch already underway instead of duplicating it.

import { buildGraph } from './graph.js';

// Small on purpose: each entry can be a full repo's symbol/edge rows plus an
// adjacency index. This bounds worst-case retained memory to a handful of
// repos' graphs, not "every repo ever queried by this process."
export const MAX_ENTRIES_PER_STORE = 16;

const cacheByStore = new WeakMap(); // store → Map(repoId → { pending } | { entry }), in LRU-recency order

function getCache(store) {
  let cache = cacheByStore.get(store);
  if (!cache) { cache = new Map(); cacheByStore.set(store, cache); }
  return cache;
}

// Mark repoId most-recently-used and evict the coldest entry once over the cap.
function touch(cache, repoId, value) {
  cache.delete(repoId);
  cache.set(repoId, value);
  if (cache.size > MAX_ENTRIES_PER_STORE) {
    const coldest = cache.keys().next().value;
    cache.delete(coldest);
  }
}

/**
 * Load a repo's graph, reusing the cached snapshot when graph_revision is
 * unchanged since the last load, and joining an in-flight load if one is
 * already underway for this repo. Returns { nodes, edges, graph, revision } —
 * `graph` is the already-built adjacency index, so traversal callers don't
 * need a separate buildGraph() call either.
 */
export async function loadCachedGraph(mod, store, repoId) {
  const cache = getCache(store);

  const rev = await mod.readRevisions(store, repoId);
  const revision = rev ? Number(rev.graph_revision) : null;

  // Re-read after the await: another concurrent call may have already
  // registered an in-flight load (or a fresh entry) for this repo. Only join
  // a pending load if it was started for this same revision — otherwise a
  // request that observes a newer revision could join a stale in-flight
  // fetch and (via ensureAnalysis) persist an old graph's analysis stamped
  // with the new revision number, making it look current when it isn't.
  const cached = cache.get(repoId);
  if (cached) {
    if (cached.pending && cached.revision === revision) { touch(cache, repoId, cached); return cached.pending; }
    if (!cached.pending && revision != null && cached.entry.revision === revision) { touch(cache, repoId, cached); return cached.entry; }
  }

  const pending = (async () => {
    const { nodes, edges } = await mod.loadGraph(store, repoId);
    return { revision, nodes, edges, graph: buildGraph(nodes, edges) };
  })();

  const inFlight = { pending, revision };
  touch(cache, repoId, inFlight);

  try {
    const entry = await pending;
    // Only promote to the settled form if we're still the registered attempt
    // — a newer load may have already superseded us (e.g. an eviction raced
    // in, or another revision bump started a fresher fetch).
    if (cache.get(repoId) === inFlight) touch(cache, repoId, { entry });
    return entry;
  } catch (err) {
    if (cache.get(repoId) === inFlight) cache.delete(repoId);
    throw err;
  }
}

// Explicit eviction for a repo that no longer exists — deleteRepo() in each
// backend calls this so a removed repo's snapshot doesn't linger in memory
// until LRU pressure happens to push it out.
export function evictRepo(store, repoId) {
  cacheByStore.get(store)?.delete(repoId);
}

// Test instrumentation: how many repos are currently cached for a store.
export function _cacheSize(store) { return cacheByStore.get(store)?.size ?? 0; }
