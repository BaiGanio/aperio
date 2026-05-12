import logger from './logger.js';

export function createEmbeddingQueue({ store, generateEmbedding }) {
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
        const embedding = await generateEmbedding(entry.text);
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
