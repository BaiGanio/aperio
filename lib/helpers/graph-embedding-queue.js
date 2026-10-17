import logger, { logError } from './logger.js';
import { createEmbeddingBacklogTracker } from './embedding-backlog.js';
import { embedForStore } from './vecMeta.js';

export function createGraphEmbeddingQueue({
  store,
  generateEmbedding,
  setEmbedding,
  label,
  itemLabel,
  // vec_meta store name — defaults to `label`, which is already "codegraph" /
  // "docgraph" for both callers.
  storeName = label,
  intervalMs = 5_000,
}) {
  const queue = new Map();
  const backlog = createEmbeddingBacklogTracker();
  let stopped = false;
  let flushPromise = null;

  const updateBacklog = () => backlog.set(queue.size);

  function enqueue(id, text) {
    if (stopped) return;
    queue.set(id, { text, attempts: 0, nextRetryAt: 0 });
    updateBacklog();
  }

  function enqueueMany(pairs) {
    for (const { id, text } of pairs) enqueue(id, text);
  }

  async function drain() {
    if (stopped || queue.size === 0) return;
    const now = Date.now();
    for (const [id, entry] of queue) {
      if (stopped) return;
      if (entry.nextRetryAt > now) continue;
      entry.attempts++;
      try {
        const { embedding, deferred } = await embedForStore(store, storeName,
          () => generateEmbedding(entry.text, 'document'));
        if (stopped) return;
        // The store is stale/reindexing, or current toward another process's
        // configuration (issue #340). The reindex driver's per-root pending
        // scan covers exactly these rows, so drop rather than retry — holding
        // them would grow this queue for the whole length of a reindex.
        if (deferred) {
          logger.debug(`[${label}-embed] ${itemLabel} ${id} handed to the ${storeName} reindex driver — dropped from the queue`);
          queue.delete(id);
          updateBacklog();
          continue;
        }
        if (!embedding) throw new Error('null result');
        await setEmbedding(store, id, embedding);
        queue.delete(id);
        updateBacklog();
      } catch (err) {
        if (stopped) return;
        if (entry.attempts >= 3) {
          logError(`[${label}-embed] ${itemLabel} ${id} dropped after 3 attempts`, err, { [`${itemLabel}Id`]: id });
          queue.delete(id);
          updateBacklog();
        } else {
          entry.nextRetryAt = now + (2 ** entry.attempts) * 15_000;
          logger.debug(`[${label}-embed] ${itemLabel} ${id} attempt ${entry.attempts} failed: ${err.message}`);
        }
      }
    }
  }

  function flush() {
    if (stopped) return Promise.resolve();
    if (flushPromise) return flushPromise;
    flushPromise = drain()
      .catch(err => logError(`[${label}-embed] flush crashed`, err))
      .finally(() => { flushPromise = null; });
    return flushPromise;
  }

  const timer = setInterval(() => { void flush(); }, intervalMs);
  timer.unref?.();

  return {
    enqueue,
    enqueueMany,
    flush,
    size: () => queue.size,
    shutdown() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      backlog.release();
    },
  };
}
