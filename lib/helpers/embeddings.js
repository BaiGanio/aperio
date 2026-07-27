import logger from './logger.js';
import { createEmbeddingWorkerClient } from './embedding-worker-client.js';
import { createEmbeddingBacklogTracker } from './embedding-backlog.js';

const FINGERPRINT_KEY = "embedding_provider";

// Single source of truth for {provider, model, dims} — every caller (the
// provider-change fingerprint check and the actual embedding API calls) must
// go through this, or the fingerprint can silently diverge from what's really
// requested (see Gap 3: VOYAGE_MODEL used to be fingerprinted but not sent).
export function getEmbeddingSignature() {
  const provider = (process.env.EMBEDDING_PROVIDER || "transformers").toLowerCase();
  if (provider === "transformers") {
    // mxbai-embed-large-v1 always returns a fixed 1024-dim vector — this
    // pipeline has no Matryoshka/truncation support, so EMBEDDING_DIMS is
    // not honored here. Reporting the pipeline's real physical output
    // (instead of trusting a possibly-misconfigured env var) keeps
    // resizeVectorStorage from ever being asked to resize to a width the
    // pipeline can't actually produce.
    return { provider, model: "mixedbread-ai/mxbai-embed-large-v1", dims: 1024 };
  }
  const model = process.env.VOYAGE_MODEL || "voyage-3";
  const dims = parseInt(process.env.EMBEDDING_DIMS || "1024", 10);
  return { provider, model, dims };
}

// Detects a provider/model/dim change and clears all stored embeddings so the
// backfill loop re-embeds everything in the new vector space.
export async function checkEmbeddingProvider(store) {
  if (typeof store.getSetting !== "function") return;

  const current = getEmbeddingSignature();
  const stored = await store.getSetting(FINGERPRINT_KEY);

  // Physical dims are checked independently of the stored fingerprint: a
  // fresh DB has hardcoded-1024 storage regardless of what EMBEDDING_DIMS is
  // set to before first boot (stored === null skips the "changed" branch
  // below on its own), and a DB upgraded from before resizeVectorStorage
  // existed can already have a fingerprint claiming the configured dims
  // without storage ever having been resized to match. Either way, trusting
  // only the fingerprint would leave storage silently mismatched forever.
  const physicalDims = typeof store.getVectorDims === "function"
    ? await store.getVectorDims()
    : null;
  const physicalMismatch = physicalDims !== null && physicalDims !== current.dims;

  const fingerprintChanged = !stored
    || stored.provider !== current.provider
    || stored.model    !== current.model
    || stored.dims     !== current.dims;

  if (!fingerprintChanged && !physicalMismatch) return;

  // Physical mismatch always wins (it's ground truth); fall back to the
  // fingerprint's own dims field when a store doesn't expose getVectorDims.
  const dimsChanged = physicalMismatch || (stored && stored.dims !== current.dims);

  if (dimsChanged && typeof store.resizeVectorStorage === "function") {
    logger.warn(
      physicalMismatch
        ? `[embeddings] vector storage is ${physicalDims}-dim but configuration expects ${current.dims}-dim — recreating vector storage for backfill`
        : `[embeddings] dims changed (${stored.dims} → ${current.dims}) — recreating vector storage for backfill`
    );
    await store.resizeVectorStorage(current.dims);
  } else if (stored) {
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
    const { model, dims } = getEmbeddingSignature();
    const body = { model, input: [text], input_type: inputType };
    // Matryoshka models (voyage-3-large, voyage-3.5, voyage-3.5-lite,
    // voyage-code-3) accept output_dimension and default to 1024 when it's
    // omitted — same as our own EMBEDDING_DIMS default. Only send it when the
    // configured dims deviates from that default, so a plain voyage-3 setup
    // (which doesn't support the param at all) keeps sending the same request
    // it always has. Without this, resizeVectorStorage recreates storage at
    // the configured dims while the API keeps returning its default-sized
    // vector, and every subsequent insert fails with a dimension mismatch.
    if (dims !== 1024) body.output_dimension = dims;
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.VOYAGE_API_KEY}` },
      body:    JSON.stringify(body),
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

// self_memories isn't wiped only by clearAllEmbeddings/resizeVectorStorage —
// nothing else scans for and re-embeds it, unlike codegraph/docgraph which
// at least get newly-changed items through their own watcher queues. Without
// this, a provider change leaves self-memory search permanently disabled.
async function getSelfPending(store) {
  return typeof store.listSelfWithoutEmbeddings === "function"
    ? store.listSelfWithoutEmbeddings()
    : [];
}

export async function initEmbeddings(store, generateEmbeddingFn) {
  const provider = (process.env.EMBEDDING_PROVIDER || "transformers").toLowerCase();
  if (provider === "none" || provider === "off" || provider === "disabled") {
    logger.info("📊 Embeddings disabled by configuration.");
    return { shutdown: async () => {} };
  }

  const { total, embedded } = await store.counts();
  const wikiPending = await getWikiPending(store);
  const selfPending = await getSelfPending(store);
  const missing = (total - embedded) + wikiPending.length + selfPending.length;

  const noop = { shutdown: async () => {} };

  if (total === 0 && wikiPending.length === 0 && selfPending.length === 0) {
    logger.info("📊 Embeddings: no data yet.");
    return noop;
  }

  if (missing === 0) {
    logger.info(`📊 Embeddings available (${embedded}/${total} memories, all wiki, all self-memories) — semantic search active.`);
    return noop;
  }

  logger.info(`📊 Embeddings: ${embedded}/${total} memories, ${wikiPending.length} wiki article(s), ${selfPending.length} self-memory(ies) pending — backfilling in background…`);

  let aborted = false;
  let currentOp = null;
  let remaining = missing;
  const backlog = createEmbeddingBacklogTracker();
  backlog.set(remaining);

  setImmediate(async () => {
    try {
      const memPending = await store.listWithoutEmbeddings();
      const wikiIds = new Set(wikiPending.map(r => r.id));
      const selfIds = new Set(selfPending.map(r => r.id));
      let success = 0, failed = 0;

      for (const row of [...memPending, ...wikiPending, ...selfPending]) {
        if (aborted) break;
        const isWiki = wikiIds.has(row.id);
        const isSelf = !isWiki && selfIds.has(row.id);
        currentOp = (async () => {
          const embedding = await generateEmbeddingFn(`${row.title}. ${row.content}`);
          if (embedding) {
            if (isWiki)      await setWikiEmbedding(store, row.id, embedding);
            else if (isSelf) await store.setSelfEmbedding(row.id, embedding);
            else              await store.setEmbedding(row.id, embedding);
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
