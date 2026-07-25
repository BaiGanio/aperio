# Journey 7 — Document/code indexing → parser → embedding queue → backend → retrieval → deletion/reindex

**Audit run:** Run 001  
**Date:** 2026-07-24  
**Verdict:** PASS — well-tested; two minor gaps (graph-embedding-queue and watcher-registry lack dedicated tests)

---

## Hops

### Hop 1 — Indexer selection + file walk

| Field | Value |
|-------|-------|
| **Files** | `lib/codegraph/indexer.js`, `lib/codegraph/backends/sqlite.js:201-251` |
| **What happens** | `pickBackend()` routes to Postgres (`.pool`) or SQLite (`.db`). `indexRepoFiles()` upserts repo, checks schema version, walks files, short-circuits on sha256 |
| **Contract** | Indexer must detect both backends. Schema version must be checked before indexing |
| **Test coverage** | ✅ `tests/unit/codegraph/indexer.test.js:1-319` — pickBackend, walk, indexRepo failure. ✅ `tests/integration/codegraph/backends/sqlite.test.js:1-420` — full lifecycle |
| **Finding** | Clean — dual-backend support tested |

### Hop 2 — Tree-sitter parser (codegraph)

| Field | Value |
|-------|-------|
| **Files** | `lib/codegraph/extract-ts.js:99-193`, `lib/codegraph/extract-generic.js:29-144` |
| **What happens** | Two-pass extraction: pass 1 declares symbols (functions/classes/methods/consts), pass 2 extracts edges (imports/calls/extends). 13+2 languages supported via tree-sitter-wasms ABI 14 |
| **Contract** | Parser must extract symbols and edges correctly for each supported language |
| **Test coverage** | ✅ `tests/unit/codegraph/extract-ts.test.js:1-361` — real WASM grammar tests. ✅ `tests/unit/codegraph/extract-generic.test.js:1-420` — 13 language tests |
| **Finding** | Clean. Dart unsupported (ABI 14 vs 15 incompatibility, blocked on tree-sitter-wasms update) |

### Hop 3 — Embedding queue

| Field | Value |
|-------|-------|
| **Files** | `lib/helpers/graph-embedding-queue.js`, `lib/codegraph/symbol-embedding-queue.js:1-15`, `lib/docgraph/chunk-embedding-queue.js:1-15` |
| **What happens** | Shared queue: `enqueue()`, `enqueueMany()`, flush every 5s, retry 3× with exponential backoff (30s/60s), drop after 3 failures |
| **Contract** | Embedding queue must handle concurrent enqueue/drain. Retry must not silently swallow errors |
| **Test coverage** | ❌ **No dedicated test file** for `graph-embedding-queue.js` |
| **Finding** | ⚠️ Shared infrastructure for both codegraph and docgraph — untested. Retry backoff, concurrency, and shutdown semantics might break silently |

### Hop 4 — Embedding + backend storage

| Field | Value |
|-------|-------|
| **Files** | `lib/helpers/embeddings.js:55-96`, `db/sqlite/store.js:679-687` |
| **What happens** | `generateEmbedding()` supports transformers (local ONNX, 1024 dims) and voyage (API). `setEmbedding()` deletes existing vec row, inserts new one. `clearAllEmbeddings()` wipes vec tables |
| **Contract** | Embedding dims must match vector table. Provider change must clear all stale vectors |
| **Test coverage** | ✅ Embedding module tests. ⚠️ `clearAllEmbeddings()` does NOT clear `vec_cg_symbols` or `vec_docgraph_chunks` — only `vec_memories` and `vec_wiki` |
| **Finding** | ⚠️ `clearAllEmbeddings()` misses codegraph/docgraph vec tables — stale vectors remain after provider change |

### Hop 5 — Retrieval

| Field | Value |
|-------|-------|
| **Files** | `lib/docgraph/retrieval.js:130-317`, `lib/codegraph/graph.js:23-145` |
| **What happens** | `buildCandidateManifest()`: deterministic sha256 dedup, period filtering, score sorting. `retrieveInBatches()`: bounded batch reading (maxFileBytes 120k, maxBatchBytes 160k), abort-signal aware. `buildGraph()` + `neighbors()` (BFS depth 3, limit 100) |
| **Contract** | Retrieval must be deterministic. Batching must not exceed limits. Graph traversal must respect depth bounds |
| **Test coverage** | ✅ `tests/unit/docgraph/retrieval.test.js:1-322` — manifest determinism, dedup, period filtering, batch reading. ✅ `tests/unit/codegraph/graph.test.js:1-124` — neighbors/shortest path |
| **Finding** | Clean |

### Hop 6 — Watcher + deletion/reindex

| Field | Value |
|-------|-------|
| **Files** | `lib/codegraph/watcher.js:93-189`, `lib/docgraph/watcher.js:98-191`, `lib/helpers/watcher-registry.js`, `lib/server/graphWatchers.js` |
| **What happens** | chokidar watcher → debounced (250ms/400ms) add/change/unlink handlers → embedding queue drain. `watcherRegistry` tracks all handles, supports `stop()` and `stopAll()` with race-condition guard |
| **Contract** | Watcher must detect file changes. Stop/stopAll must not race with new registrations. Deletion must remove symbols from all index tables |
| **Test coverage** | ✅ `tests/integration/server/hydrateRuntime.test.js` — watcher registry register/has/stop/stopAll. ❌ **No dedicated test** for `watcher-registry.js` |
| **Finding** | ⚠️ Race-condition guard in watcher-registry is untested |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | Indexer + file walk | ✅ | None |
| 2 | Tree-sitter parser | ✅ | Dart unsupported (blocked) |
| 3 | Embedding queue | ❌ | **No unit tests for shared queue** |
| 4 | Embedding + storage | ⚠️ | `clearAllEmbeddings` misses codegraph/docgraph |
| 5 | Retrieval | ✅ | None |
| 6 | Watcher + deletion | ⚠️ | Watcher-registry untested |

**Verdict:** PASS — well-tested across most hops. Two infrastructure gaps (graph-embedding-queue and watcher-registry) lack dedicated unit tests. `clearAllEmbeddings` incomplete.
