import logger from './logger.js';
import { createEmbeddingWorkerClient } from './embedding-worker-client.js';
import { createEmbeddingBacklogTracker } from './embedding-backlog.js';

const PROVIDER = (process.env.EMBEDDING_PROVIDER || "transformers").toLowerCase();
const MODEL = PROVIDER === "transformers"
  ? "mixedbread-ai/mxbai-embed-large-v1"
  : (process.env.VOYAGE_MODEL || "voyage-3");
const DIMS = parseInt(process.env.EMBEDDING_DIMS || "1024", 10);
const FINGERPRINT_KEY = "embedding_provider";

// Detects a provider/model/dim change and clears all stored embeddings so the
// backfill loop re-embeds everything in the new vector space.
export async function checkEmbeddingProvider(store) {
  if (typeof store.getSetting !== "function") return;

  const current = { provider: PROVIDER, model: MODEL, dims: DIMS };
  const stored = await store.getSetting(FINGERPRINT_KEY);

  const changed = !stored
    || stored.provider !== current.provider
    || stored.model    !== current.model
    || stored.dims     !== current.dims;

  if (!changed) return;

  if (stored) {
    logger.warn(
      `[embeddings] provider changed (${stored.provider}/${stored.model} → ${current.provider}/${current.model}) — clearing all embeddings for backfill`
    );
    if (typeof store.clearAllEmbeddings === "function") {
      await store.clearAllEmbeddings();
    }
  }

  await store.setSetting(FINGERPRINT_KEY, current);
}

// ─── Transformers pipeline (lazy-loaded singleton) ────────────────────────────
let _transformersPipelineCache = null;
let _transformersWorkerClient = null;

// Exposed so tests can inject a mock pipeline without touching the network/ONNX.
export function _setTransformersPipeline(pipeline) {
  _transformersPipelineCache = pipeline;
}

function getTransformersWorkerClient() {
  if (!_transformersWorkerClient) _transformersWorkerClient = createEmbeddingWorkerClient();
  return _transformersWorkerClient;
}

// ─── Embeddings ───────────────────────────────────────────────────────────────

export async function generateEmbedding(text, inputType = "document") {
  const provider = (process.env.EMBEDDING_PROVIDER || "transformers").toLowerCase();

  if (provider === "none" || provider === "off" || provider === "disabled") {
    return null;
  }

  if (provider === "transformers") {
    try {
      // Test injection stays in-process; production inference is CPU-bound and
      // must not run on the HTTP/WebSocket event loop.
      if (_transformersPipelineCache) {
        const output = await _transformersPipelineCache(text, { pooling: 'cls', normalize: true });
        return Array.from(output.data);
      }
      return await getTransformersWorkerClient().embed(text, inputType);
    } catch (err) {
      if (err?.message === "Embedding worker has been disposed") return null;
      logger.error(`⚠️  Transformers embedding failed: ${err.message}`);
      return null;
    }
  }

  // voyage
  if (!process.env.VOYAGE_API_KEY) {
    logger.warn("⚠️  VOYAGE_API_KEY not set — skipping embedding");
    return null;
  }
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.VOYAGE_API_KEY}` },
      body:    JSON.stringify({ model: "voyage-3", input: [text], input_type: inputType }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.data[0].embedding;
  } catch (err) {
    logger.error(`⚠️  Voyage embedding failed: ${err.message}`);
    return null;
  }
}

export async function disposeEmbeddings() {
  if (_transformersWorkerClient) {
    const client = _transformersWorkerClient;
    _transformersWorkerClient = null;
    try { await client.dispose(); } catch {}
  }
  if (_transformersPipelineCache) {
    try { await _transformersPipelineCache.dispose(); } catch {}
    _transformersPipelineCache = null;
  }
}

async function getWikiPending(store) {
  if (store.wiki) return store.wiki.listWithoutEmbeddings();
  if (store.pool) {
    const { rows } = await store.pool.query(
      `SELECT id, title, COALESCE(summary, '') || ' ' || body_md AS content
         FROM wiki_articles WHERE embedding IS NULL`
    );
    return rows;
  }
  return [];
}

async function setWikiEmbedding(store, id, embedding) {
  if (store.wiki) return store.wiki.setEmbedding(id, embedding);
  if (store.pool) {
    await store.pool.query(
      `UPDATE wiki_articles SET embedding = $1 WHERE id = $2`,
      [`[${embedding.join(',')}]`, id]
    );
  }
}

export async function initEmbeddings(store, generateEmbeddingFn) {
  const provider = (process.env.EMBEDDING_PROVIDER || "transformers").toLowerCase();
  if (provider === "none" || provider === "off" || provider === "disabled") {
    logger.info("📊 Embeddings disabled by configuration.");
    return { shutdown: async () => {} };
  }

  const { total, embedded } = await store.counts();
  const wikiPending = await getWikiPending(store);
  const missing = (total - embedded) + wikiPending.length;

  const noop = { shutdown: async () => {} };

  if (total === 0 && wikiPending.length === 0) {
    logger.info("📊 Embeddings: no data yet.");
    return noop;
  }

  if (missing === 0) {
    logger.info(`📊 Embeddings available (${embedded}/${total} memories, all wiki) — semantic search active.`);
    return noop;
  }

  logger.info(`📊 Embeddings: ${embedded}/${total} memories, ${wikiPending.length} wiki article(s) pending — backfilling in background…`);

  let aborted = false;
  let currentOp = null;
  let remaining = missing;
  const backlog = createEmbeddingBacklogTracker();
  backlog.set(remaining);

  setImmediate(async () => {
    try {
      const memPending = await store.listWithoutEmbeddings();
      const wikiIds = new Set(wikiPending.map(r => r.id));
      let success = 0, failed = 0;

      for (const row of [...memPending, ...wikiPending]) {
        if (aborted) break;
        const isWiki = wikiIds.has(row.id);
        currentOp = (async () => {
          const embedding = await generateEmbeddingFn(`${row.title}. ${row.content}`);
          if (embedding) {
            if (isWiki) await setWikiEmbedding(store, row.id, embedding);
            else        await store.setEmbedding(row.id, embedding);
          }
          return embedding;
        })();
        const result = await currentOp;
        currentOp = null;
        if (result) success++; else failed++;
        remaining--;
        backlog.set(remaining);
      }
      if (!aborted) logger.info(`✅ Backfill complete: ${success} embedded${failed ? `, ${failed} failed` : ""}.`);
    } catch (err) {
      if (!aborted) logger.error(`⚠️  Backfill error: ${err.message}`);
    } finally {
      backlog.release();
    }
  });

  return {
    shutdown: (timeoutMs = 5000) => {
      aborted = true;
      if (!currentOp) return Promise.resolve();
      return Promise.race([
        currentOp.catch(() => {}),
        new Promise(r => setTimeout(r, timeoutMs)),
      ]);
    },
  };
}
