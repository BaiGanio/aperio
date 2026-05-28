// lib/codegraph/symbol-embedding-queue.js
// Background flusher for cg_symbols embeddings. Watcher pushes {id, text}
// pairs after each indexFile; this drains them off the write path so saves
// don't block on the embedding model.

import { setSymbolEmbedding } from './indexer.js';
import logger, { logError } from '../helpers/logger.js';

export function createSymbolEmbeddingQueue({ store, generateEmbedding, intervalMs = 5_000 }) {
  // id (number) → { text, attempts, nextRetryAt }
  const queue = new Map();

  function enqueue(id, text) {
    queue.set(id, { text, attempts: 0, nextRetryAt: 0 });
  }

  function enqueueMany(pairs) {
    for (const { id, text } of pairs) enqueue(id, text);
  }

  async function flush() {
    if (queue.size === 0) return;
    const now = Date.now();
    for (const [id, entry] of queue) {
      if (entry.nextRetryAt > now) continue;
      entry.attempts++;
      try {
        const embedding = await generateEmbedding(entry.text, 'document');
        if (!embedding) throw new Error('null result');
        await setSymbolEmbedding(store, id, embedding);
        queue.delete(id);
      } catch (err) {
        if (entry.attempts >= 3) {
          logError(`[codegraph-embed] symbol ${id} dropped after 3 attempts`, err, { symbolId: id });
          queue.delete(id);
        } else {
          entry.nextRetryAt = now + (2 ** entry.attempts) * 15_000;
          logger.debug(`[codegraph-embed] symbol ${id} attempt ${entry.attempts} failed: ${err.message}`);
        }
      }
    }
  }

  const safeFlush = () => flush().catch(err => logError('[codegraph-embed] flush crashed', err));
  const timer = setInterval(safeFlush, intervalMs);
  timer.unref?.();

  return {
    enqueue,
    enqueueMany,
    size: () => queue.size,
    shutdown() { clearInterval(timer); },
  };
}
