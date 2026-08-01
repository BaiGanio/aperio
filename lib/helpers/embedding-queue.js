import logger from './logger.js';
import { embedForStore } from './vecMeta.js';

export function createEmbeddingQueue({ store, generateEmbedding, storeName = 'memories' }) {
  // id → { text, attempts, nextRetryAt }
  const queue = new Map();

  function enqueue(id, text) {
    if (!queue.has(id)) {
      queue.set(id, { text, attempts: 0, nextRetryAt: 0 });
    }
  }

  async function flush() {
    if (queue.size === 0) return;
    const now = Date.now();
    for (const [id, entry] of queue) {
      if (entry.nextRetryAt > now) continue;
      entry.attempts++;
      try {
        const { embedding, deferred } = await embedForStore(store, storeName,
          () => generateEmbedding(entry.text));
        // The store is stale/reindexing, or current toward another process's
        // configuration (issue #340). Retrying would only re-race the same
        // gate until the attempt budget ran out, and the row does not need us:
        // "no vector yet" is exactly what the reindex driver's pending scan
        // looks for. Drop it rather than hold it — an unbounded queue waiting
        // on a reindex that may take hours is the worse failure.
        if (deferred) {
          logger.info(`[embedding-queue] id=${id} handed to the ${storeName} reindex driver — dropped from the retry queue`);
          queue.delete(id);
          continue;
        }
        if (!embedding) throw new Error('null result');
        await store.setEmbedding(id, embedding);
        queue.delete(id);
        logger.info(`[embedding-queue] id=${id} embedded on attempt ${entry.attempts}`);
      } catch (err) {
        if (entry.attempts >= 3) {
          logger.warn(`[embedding-queue] id=${id} dropped after 3 failed attempts: ${err.message}`);
          queue.delete(id);
        } else {
          // 2^attempts * 15s → 30s, 60s
          const backoffMs = (2 ** entry.attempts) * 15_000;
          entry.nextRetryAt = now + backoffMs;
          logger.debug(`[embedding-queue] id=${id} attempt ${entry.attempts} failed, retry in ${backoffMs / 1000}s`);
        }
      }
    }
  }

  const timer = setInterval(flush, 60_000);
  timer.unref?.();

  return {
    enqueue,
    size: () => queue.size,
    shutdown() { clearInterval(timer); },
  };
}
