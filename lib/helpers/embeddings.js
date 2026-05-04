import { join } from 'path';
import { homedir } from 'os';
import logger from './logger.js';

// ─── Transformers pipeline (lazy-loaded singleton) ────────────────────────────
let _transformersPipelineCache = null;

// Exposed so tests can inject a mock pipeline without touching the network/ONNX.
export function _setTransformersPipeline(pipeline) {
  _transformersPipelineCache = pipeline;
}

async function getTransformersPipeline() {
  if (_transformersPipelineCache) return _transformersPipelineCache;
  const { pipeline, env } = await import('@huggingface/transformers');
  // Store model outside node_modules so it survives npm install
  env.cacheDir = process.env.TRANSFORMERS_CACHE || join(homedir(), '.cache', 'aperio', 'transformers');
  _transformersPipelineCache = await pipeline(
    'feature-extraction',
    'mixedbread-ai/mxbai-embed-large-v1',
    { dtype: 'q8' }
  );
  return _transformersPipelineCache;
}

// ─── Embeddings ───────────────────────────────────────────────────────────────

export async function generateEmbedding(text, inputType = "document") {
  const provider = (process.env.EMBEDDING_PROVIDER || "transformers").toLowerCase();

  if (provider === "transformers") {
    try {
      const extractor = await getTransformersPipeline();
      const output = await extractor(text, { pooling: 'cls', normalize: true });
      return Array.from(output.data);
    } catch (err) {
      console.error("⚠️  Transformers embedding failed:", err.message);
      return null;
    }
  }

  // voyage
  if (!process.env.VOYAGE_API_KEY) {
    console.warn("⚠️  VOYAGE_API_KEY not set — skipping embedding");
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
    console.error("⚠️  Voyage embedding failed:", err.message);
    return null;
  }
}

export async function initEmbeddings(store, generateEmbeddingFn) {
  const { total, embedded } = await store.counts();
  const missing = total - embedded;

  const noop = { shutdown: async () => {} };

  if (total === 0) {
    logger.info("📊 Embeddings: no memories yet.");
    return noop;
  }

  if (missing === 0) {
    logger.info(`📊 Embeddings available (${embedded}/${total}) — semantic search active.`);
    return noop;
  }

  // Only reach here when there is actual work to do.
  logger.info(`📊 Embeddings: ${embedded}/${total} available — ${missing} pending, backfilling in background…`);

  let aborted = false;
  // Holds the promise for the embedding currently in flight so shutdown can await it.
  let currentOp = null;

  setImmediate(async () => {
    try {
      const pending = await store.listWithoutEmbeddings();
      let success = 0, failed = 0;
      for (const row of pending) {
        if (aborted) break;
        currentOp = generateEmbeddingFn(`${row.title}. ${row.content}`);
        const embedding = await currentOp;
        currentOp = null;
        if (embedding) { await store.setEmbedding(row.id, embedding); success++; }
        else failed++;
      }
      if (!aborted) logger.info(`✅ Backfill complete: ${success} embedded${failed ? `, ${failed} failed` : ""}.`);
    } catch (err) {
      if (!aborted) logger.error(`⚠️  Backfill error: ${err.message}`);
    }
  });

  return {
    // Stop the loop and wait for the current ONNX call to finish (max 5 s).
    // Prevents the native mutex crash when process.exit() is called mid-inference.
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