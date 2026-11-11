// src/embeddings/local-embedder.js - one local model turns text into vectors
// (spec S2.4). In-process, no worker (decision 1). No module state: every
// createEmbedder() call owns its own pipeline (TR15, L-P03).
//
// Kept from v1 (lib/helpers/embedding-worker.js at archive/v1-final): the
// feature-extraction pipeline, dtype q8, cls pooling, normalized vectors.
// Dropped: other providers, the worker thread, the module-level singleton.
// Changed: no network at run time; `npm run model:fetch` is the only download.

import { homedir } from 'node:os';

/** The code recipe (dtype + pooling). A change here must change the sig. */
const DTYPE = 'q8';
const POOLING = 'cls';
const RECIPE = `${DTYPE}-${POOLING}`;
/** One model graph, run in order: a second thread pool between ops has no work. */
const INTER_OP_THREADS = 1;

export class EmbeddingUnavailable extends Error {
  /** @param {string} message @param {unknown} [cause] */
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'EmbeddingUnavailable';
  }
}

/** @param {string} dir */
const expandHome = (dir) => dir.replace(/^~(?=\/|$)/, homedir());

/**
 * @param {{ model: string, cacheDir: string, threads: number, log?: { warn: Function, info: Function },
 *           transformers?: { pipeline: Function, env: Record<string, unknown> } }} opts
 *   `transformers` is the module itself; tests pass a fake.
 */
export async function createEmbedder({ model, cacheDir, threads, log = console, transformers } = /** @type {any} */ ({})) {
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('model: is required');
  if (typeof cacheDir !== 'string' || !cacheDir.trim()) throw new TypeError('cacheDir: is required');
  // Config EMBEDDING_THREADS. Uncapped, the model took 5 of 10 cores (spec S2.4 §5).
  if (!Number.isInteger(threads) || threads < 1) throw new TypeError(`threads: must be a whole number >= 1, got ${threads}`);

  const tf = transformers ?? (await import('@huggingface/transformers'));
  tf.env.allowRemoteModels = false; // no network at run time (spec S2.4 #2)
  tf.env.cacheDir = expandHome(cacheDir);

  let extractor;
  try {
    extractor = await tf.pipeline('feature-extraction', model, {
      dtype: DTYPE,
      session_options: { intraOpNumThreads: threads, interOpNumThreads: INTER_OP_THREADS },
    });
  } catch (err) {
    throw new EmbeddingUnavailable(
      `embedding model ${model} is not in ${tf.env.cacheDir} (${err.message}). Run: npm run model:fetch`, err);
  }

  let closed = false;
  /** @param {string} text @returns {Promise<Float32Array>} */
  async function embed(text) {
    if (closed) throw new Error('embedder: closed');
    const out = await extractor(String(text), { pooling: POOLING, normalize: true });
    return out.data;
  }

  const dims = (await embed('probe')).length;
  log.info?.(`[embeddings] ${model} loaded, ${dims} dims`);

  return Object.freeze({
    sig: `${model}|${dims}|${RECIPE}`,
    dims,
    embed,
    // Same recipe as embed: a query prefix showed no measured gain (spec S2.4).
    embedQuery: embed,
    async close() {
      if (closed) return;
      closed = true;
      await extractor.dispose?.();
    },
  });
}
