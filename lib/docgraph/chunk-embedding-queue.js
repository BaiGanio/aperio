// lib/docgraph/chunk-embedding-queue.js
// Background flusher for docgraph_chunks embeddings. The watcher pushes
// {id, text} pairs after each incremental indexFile; this drains them off the
// write path so a dropped document doesn't block on the embedding model.
// Mirrors lib/codegraph/symbol-embedding-queue.js (chunks instead of symbols).

import { setChunkEmbedding } from './indexer.js';
import { createGraphEmbeddingQueue } from '../helpers/graph-embedding-queue.js';

export function createChunkEmbeddingQueue({ store, generateEmbedding, intervalMs = 5_000 }) {
  return createGraphEmbeddingQueue({
    store, generateEmbedding, intervalMs,
    setEmbedding: setChunkEmbedding,
    label: 'docgraph',
    itemLabel: 'chunk',
  });
}
