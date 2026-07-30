import logger from './logger.js';
import { createEmbeddingWorkerClient } from './embedding-worker-client.js';
import { createEmbeddingBacklogTracker } from './embedding-backlog.js';
import { signatureString, supportsVecMeta, ensureVecMeta, markStaleWhereChanged, pendingStoreNames } from './vecMeta.js';

const FINGERPRINT_KEY = "embedding_provider";
const DISABLED_PROVIDERS = new Set(["none", "off", "disabled"]);

// True when EMBEDDING_PROVIDER is explicitly turned off. Shared by every
// caller that needs to skip embedding work entirely — generateEmbedding()
// returning null is not enough on its own, since a caller like the reindex
// driver would otherwise clear a store's vectors, fail every row against the
// null provider, and strand the store in `reindexing` forever.
export function isEmbeddingDisabled() {
  return DISABLED_PROVIDERS.has((process.env.EMBEDDING_PROVIDER || "transformers").toLowerCase());
}

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
  // A known fixed-width model defaults to its own native width when
  // EMBEDDING_DIMS is unset (voyage-large-2 is 1536-wide, not 1024) — an
  // explicit EMBEDDING_DIMS still overrides, and validateVoyageDims below
  // catches it if that override doesn't match.
  const dims = parseInt(process.env.EMBEDDING_DIMS || String(VOYAGE_FIXED_DIMS[model] ?? 1024), 10);
  return { provider, model, dims };
}

// Voyage's Matryoshka-capable models accept output_dimension only from this
// fixed set. Source: Voyage API docs as of this codebase's knowledge cutoff —
// re-verify if Voyage adds Matryoshka support to another model family.
const VOYAGE_MATRYOSHKA_DIMS = {
  "voyage-3-large":   [256, 512, 1024, 2048],
  "voyage-3.5":       [256, 512, 1024, 2048],
  "voyage-3.5-lite":  [256, 512, 1024, 2048],
  "voyage-code-3":    [256, 512, 1024, 2048],
};

// Every other well-known Voyage model is fixed-width and rejects
// output_dimension entirely — each has its own native width, not a shared
// default (voyage-large-2 and voyage-code-2 are 1536-wide; the rest are
// 1024). VOYAGE_MODEL is a free-form override (lib/config.js), so a model
// string absent from both maps here is intentionally left unvalidated below
// rather than assumed to be 1024-wide.
const VOYAGE_FIXED_DIMS = {
  "voyage-3":                 1024,
  "voyage-2":                 1024,
  "voyage-large-2":           1536,
  "voyage-large-2-instruct":  1536,
  "voyage-code-2":            1536,
  "voyage-multilingual-2":    1024,
  "voyage-law-2":             1024,
  "voyage-lite-02-instruct":  1024,
};

// Throws when {model, dims} would produce a request Voyage rejects, so the
// caller can bail out *before* resizing vector storage or clearing
// embeddings — otherwise storage gets recreated at a width Voyage never
// actually returns and every subsequent insert 400s. A model this function
// doesn't recognize is not an error: VOYAGE_MODEL is a documented free-form
// override, and guessing a native width for an unknown model would be worse
// than trusting the configured dims.
export function validateVoyageDims(model, dims) {
  const matryoshka = VOYAGE_MATRYOSHKA_DIMS[model];
  if (matryoshka) {
    if (!matryoshka.includes(dims)) {
      throw new Error(
        `EMBEDDING_DIMS=${dims} is not supported by "${model}" — valid values are ${matryoshka.join(", ")}.`
      );
    }
    return;
  }
  const fixed = VOYAGE_FIXED_DIMS[model];
  if (fixed !== undefined && dims !== fixed) {
    throw new Error(
      `EMBEDDING_DIMS=${dims} requested, but model "${model}" is fixed-width at ${fixed} dims and ` +
      `does not support output_dimension. Set EMBEDDING_DIMS=${fixed} (or unset it), or switch ` +
      `VOYAGE_MODEL to a Matryoshka-capable model (${Object.keys(VOYAGE_MATRYOSHKA_DIMS).join(", ")}).`
    );
  }
}

// Detects a provider/model/dim change.
//
// On a store that has vec_meta (WS1), this marks the affected stores stale and
// leaves their vectors in place — search degrades to full-text until the
// reindex driver re-embeds them. On a store without it (a pre-migration
// database, or a test double), it falls back to the original destructive
// clear-all so the older behavior is preserved rather than silently skipped.
export async function checkEmbeddingProvider(store) {
  if (typeof store.getSetting !== "function") return;

  const current = getEmbeddingSignature();
  if (current.provider === "voyage") validateVoyageDims(current.model, current.dims);
  const stored = await store.getSetting(FINGERPRINT_KEY);

  if (supportsVecMeta(store)) {
    await checkEmbeddingProviderVecMeta(store, current, stored);
    return;
  }

  // Same reasoning as the vec_meta path's disabled check below: a disabled
  // provider can never rebuild what a resize or clear-all destroys here.
  if (isEmbeddingDisabled()) return;

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

// The vec_meta path: mark stale instead of deleting, per store.
//
// The one case that still destroys vectors is a dimension change — vec0 tables
// and pgvector columns are fixed-width, so storage physically has to be
// recreated before anything can be written at the new width. That is tracked
// rather than silent: every store is marked stale with its cursor reset, so
// the reindex driver rebuilds all five.
async function checkEmbeddingProviderVecMeta(store, current, stored) {
  const signature = signatureString(current);

  // Seed from the legacy fingerprint when one exists: a database upgrading to
  // vec_meta has vectors belonging to that older configuration, and recording
  // it here is what lets the comparison below notice the difference.
  await ensureVecMeta(store, { signature, dims: current.dims, fallback: stored });

  // Disabled means generateEmbedding() returns null for every row, so nothing
  // downstream could ever finish a reindex this triggers — the background
  // reindex driver is skipped entirely for a disabled provider (see
  // hydrateRuntime.js). Comparing against `current` here would still resize
  // storage and mark stores stale against a signature nobody can rebuild
  // toward, destroying a still-valid prior configuration's vectors to serve a
  // no-op. Seeding above still runs so a pre-vec_meta upgrade gets a row;
  // re-enabling the provider re-runs this check against a live signature and
  // repairs storage then.
  if (isEmbeddingDisabled()) return;

  const physicalDims = typeof store.getVectorDims === "function"
    ? await store.getVectorDims()
    : null;
  const physicalMismatch = physicalDims !== null && physicalDims !== current.dims;

  let resized = false;
  if (physicalMismatch && typeof store.resizeVectorStorage === "function") {
    logger.warn(
      `[embeddings] vector storage is ${physicalDims}-dim but configuration expects ${current.dims}-dim — recreating vector storage; all stores will be reindexed`
    );
    await store.resizeVectorStorage(current.dims);
    resized = true;
  }

  const staled = await markStaleWhereChanged(store, {
    signature,
    dims: current.dims,
    allStale: resized,
  });

  if (staled.length) {
    logger.warn(
      `[embeddings] embedding configuration changed to ${signature} — marked stale: ${staled.join(", ")}. ` +
      `These stores serve full-text results only until reindexed (npm run embeddings:reindex, or automatically in the background).`
    );
  }

  // The legacy fingerprint is still written so a rollback to a build without
  // vec_meta still detects the change instead of trusting stale vectors.
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
    validateVoyageDims(model, dims);
    const body = { model, input: [text], input_type: inputType };
    // Matryoshka models (voyage-3-large, voyage-3.5, voyage-3.5-lite,
    // voyage-code-3, and any future one VOYAGE_MODEL names that isn't in our
    // hardcoded table yet) accept output_dimension and default to 1024 when
    // it's omitted — same as our own EMBEDDING_DIMS default. Only send it
    // when the configured dims deviates from that default, so a plain
    // Matryoshka setup keeps sending the same request it always has.
    // Fixed-width models (voyage-3, voyage-large-2, ...) never accept the
    // param at all — gating on "known fixed-width" rather than "known
    // Matryoshka" matters for two reasons: (1) a fixed-width model can have a
    // non-1024 native width (voyage-large-2 is 1536), where dims legitimately
    // differs from 1024 without the model supporting output_dimension; (2) an
    // *unrecognized* model with non-default dims must still get the param —
    // validateVoyageDims above deliberately trusts unknown models (VOYAGE_MODEL
    // is a documented free-form override), and if this check required knowing
    // the model is Matryoshka-capable, that trust would go one-way: dims gets
    // validated through, storage gets resized to it, but the API call never
    // actually requests it — Voyage keeps returning its default-width vector
    // and every insert fails against the resized storage.
    if (dims !== 1024 && VOYAGE_FIXED_DIMS[model] === undefined) body.output_dimension = dims;
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

// `page` ({ limit, offset }) is how the reindex driver walks a large wiki in
// bounded pages; the startup backfill still reads the whole set.
export async function getWikiPending(store, { limit = null, offset = 0 } = {}) {
  if (store.wiki) return store.wiki.listWithoutEmbeddings({ limit, offset });
  if (store.pool) {
    const { rows } = await store.pool.query(
      `SELECT id, title, COALESCE(summary, '') || ' ' || body_md AS content
         FROM wiki_articles WHERE embedding IS NULL
         ORDER BY id LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows;
  }
  return [];
}

export async function setWikiEmbedding(store, id, embedding) {
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

  // Stores the reindex driver owns (vec_meta says stale or reindexing) are its
  // work, not this loop's. A dims change leaves *every* row missing a vector,
  // so without this both loops would walk the identical set and embed each row
  // twice — double the local inference, or a doubled bill on a paid API. The
  // reindex driver is the one that must do it: it holds the per-store lease and
  // is what flips the store back to `current`.
  const deferred = await pendingStoreNames(store);
  const memoriesDeferred = deferred.has("memories");
  const wikiPending = deferred.has("wiki") ? [] : await getWikiPending(store);
  const selfPending = deferred.has("self_memories") ? [] : await getSelfPending(store);
  const missing = (memoriesDeferred ? 0 : total - embedded) + wikiPending.length + selfPending.length;

  const noop = { shutdown: async () => {} };

  if (missing === 0) {
    if (deferred.size) {
      logger.info(`📊 Embeddings: ${[...deferred].join(", ")} awaiting reindex — that backfill belongs to the reindex driver, not the startup loop.`);
    } else if (total === 0 && wikiPending.length === 0 && selfPending.length === 0) {
      logger.info("📊 Embeddings: no data yet.");
    } else {
      logger.info(`📊 Embeddings available (${embedded}/${total} memories, all wiki, all self-memories) — semantic search active.`);
    }
    return noop;
  }

  logger.info(
    `📊 Embeddings: ${memoriesDeferred ? "memories deferred to reindex" : `${embedded}/${total} memories`}, ` +
    `${wikiPending.length} wiki article(s), ${selfPending.length} self-memory(ies) pending — backfilling in background…`
  );

  let aborted = false;
  let currentOp = null;
  let remaining = missing;
  const backlog = createEmbeddingBacklogTracker();
  backlog.set(remaining);

  setImmediate(async () => {
    try {
      const memPending = memoriesDeferred ? [] : await store.listWithoutEmbeddings();
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
