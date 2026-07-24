// lib/codegraph/symbol-embedding-queue.js
// Background flusher for cg_symbols embeddings. Watcher pushes {id, text}
// pairs after each indexFile; this drains them off the write path so saves
// don't block on the embedding model.

import { setSymbolEmbedding } from './indexer.js';
import { createGraphEmbeddingQueue } from '../helpers/graph-embedding-queue.js';

export function createSymbolEmbeddingQueue({ store, generateEmbedding, intervalMs = 5_000 }) {
  return createGraphEmbeddingQueue({
    store, generateEmbedding, intervalMs,
    setEmbedding: setSymbolEmbedding,
    label: 'codegraph',
    itemLabel: 'symbol',
  });
}
