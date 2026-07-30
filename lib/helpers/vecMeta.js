// lib/helpers/vecMeta.js — per-store embedding signature + reindex state
// machine (issue #287, WS1).
//
// Replaces the single global `embedding_provider` fingerprint whose only
// remedy for a provider/model/dims change was to clear every vector store at
// once. The rules live here rather than in the two store backends so SQLite
// and Postgres cannot drift on them; the stores only do dumb row CRUD.
//
// The invariant this exists to protect: never compute a similarity score
// between vectors produced by two different embedding configurations. A store
// whose recorded signature no longer matches the running configuration is
// served FTS-only until it has been reindexed.

import logger from "./logger.js";

// The five vector-bearing stores. A sixth one added without updating this list
// is a silent correctness hole, so tests assert the list matches what the
// backends actually clear/resize.
export const VECTOR_STORES = Object.freeze([
  "memories",
  "wiki",
  "self_memories",
  "codegraph",
  "docgraph",
]);

export const VEC_STATUS = Object.freeze({
  CURRENT: "current",
  STALE: "stale",
  REINDEXING: "reindexing",
});

// Canonical string form of an embedding signature. Comparison is string
// equality throughout — no structural comparison anywhere, so there is exactly
// one notion of "same embedding space" in the codebase.
export function signatureString({ provider, model, dims }) {
  return `${provider}:${model}:${dims}`;
}

export function supportsVecMeta(store) {
  return typeof store?.listVecMeta === "function"
    && typeof store?.seedVecMeta === "function"
    && typeof store?.updateVecMeta === "function";
}

// ── Reads used by search paths ──────────────────────────────────────────────

// True only when the store is fully synced to the running configuration.
// `reindexing` deliberately returns false alongside `stale`: a partially
// reindexed store holds a mix of old- and new-space vectors, which is the
// exact situation that produces meaningless similarity scores.
//
// Deliberately uncached. A cached `current` verdict is not safe for even a
// second: the reindex CLI, or a second Aperio process, can flip a store to
// `reindexing` and start replacing vectors at any moment, and a server holding
// a cached `current` would keep scoring queries against a half-rebuilt store —
// exactly the cross-space comparison this module exists to prevent. The read
// is a primary-key lookup on a five-row table, and it gates a query-embedding
// call that costs a model inference or a network round trip, so the saving was
// never worth the staleness window.
export async function isVectorSearchable(store, storeName) {
  if (!supportsVecMeta(store)) return true; // pre-migration DB or a test double
  try {
    const row = await store.getVecMeta(storeName);
    // A store with no row yet has never been seeded (first boot, before
    // ensureVecMeta runs). Treat as searchable: this matches the behavior
    // before vec_meta existed, and seeding marks it current anyway.
    if (!row) return true;
    if (row.status !== VEC_STATUS.CURRENT) return false;

    // `current` on its own only means "some process finished a reindex and
    // called finalizeCurrent" — not that it was reindexed toward *this*
    // process's active configuration. In Postgres's multi-agent mode, another
    // process can be running a different EMBEDDING_PROVIDER/model/dims (an
    // operator mid-rollout, or a stale deploy) and finalize this exact store
    // to `current` under its own signature. Without this check that verdict
    // would look identical to "current toward what I'm about to query with,"
    // and a query embedding from this process's space would score against
    // vectors from the other process's space — precisely the cross-space
    // comparison this module exists to prevent. Dynamic import avoids a
    // static cycle: embeddings.js already imports from this module.
    const { getEmbeddingSignature } = await import("./embeddings.js");
    return row.signature === signatureString(getEmbeddingSignature());
  } catch (err) {
    // Fail closed. If we cannot establish that a store's vectors match the
    // running configuration, we do not know they are comparable — and the
    // failure mode of guessing "yes" is silent nonsense results, while the
    // failure mode of guessing "no" is full-text results that are merely
    // worse. Take the one that cannot be wrong in a way users can't see.
    logger.warn(`[vec_meta] status lookup failed for "${storeName}" — treating as not searchable: ${err.message}`);
    return false;
  }
}

// Names of the stores the reindex driver owns right now — anything not
// `current`. The legacy startup backfill (initEmbeddings) consults this so it
// does not re-embed the same rows the reindex driver is already working
// through: after a dims change every row is missing a vector, and both loops
// would otherwise scan the identical set and pay for it twice.
//
// Lives here rather than in lib/embeddings/reindex.js only to avoid an import
// cycle — that module imports from lib/helpers/embeddings.js, which is exactly
// the caller that needs this.
export async function pendingStoreNames(store) {
  if (!supportsVecMeta(store)) return new Set();
  try {
    const rows = await store.listVecMeta();
    return new Set(rows.filter(r => r.status !== VEC_STATUS.CURRENT).map(r => r.store_name));
  } catch (err) {
    // Losing this read only costs a duplicated backfill, never correctness —
    // both loops write the same vectors. Degrade to the old behavior.
    logger.warn(`[vec_meta] could not list pending stores — the startup backfill may duplicate reindex work: ${err.message}`);
    return new Set();
  }
}

// Resolves the per-store gate into a *synchronous* predicate.
//
// The codegraph/docgraph backends call `vectorEnabled?.()` inline and treat the
// result as a boolean. Handing them an async function there would be a silent
// disaster: a Promise is always truthy, so vector search would appear enabled
// for every stale store — precisely the cross-space scoring this feature
// exists to prevent. Resolve the status here, hand back a plain predicate.
export async function vectorGate(store, storeName, vectorEnabled) {
  if (!(vectorEnabled?.() ?? false)) return () => false;
  const searchable = await isVectorSearchable(store, storeName);
  return () => searchable;
}

// ── Writes ──────────────────────────────────────────────────────────────────

// Seeds a row for any store that lacks one.
//
// `fallback` is the signature to record for a database that predates vec_meta:
// its existing vectors belong to whatever the old global `embedding_provider`
// fingerprint recorded, so seeding with that (rather than with the running
// configuration) lets the normal mismatch check below notice the difference
// and schedule a reindex. A genuinely fresh database has no fingerprint and
// nothing embedded, so it seeds at the running configuration.
export async function ensureVecMeta(store, { signature, dims, fallback = null }) {
  if (!supportsVecMeta(store)) return;
  const seedSig = fallback ? signatureString(fallback) : signature;
  const seedDims = fallback?.dims ?? dims;
  let seeded = 0;
  for (const name of VECTOR_STORES) {
    if (await store.seedVecMeta(name, { signature: seedSig, dims: seedDims })) seeded++;
  }
  if (seeded) logger.info(`[vec_meta] seeded ${seeded} store(s) at signature ${seedSig}`);
}

// Compares each store's recorded signature against the running configuration
// and marks the mismatched ones stale.
//
// `signature` here is the configuration a store is synced to (when current) or
// syncing toward (when stale/reindexing) — not a description of what is
// physically in the table. That distinction is what makes an interrupted
// reindex resumable: a store already stale or reindexing toward *this same*
// signature is left completely alone, so a restart continues where it stopped
// rather than starting the store over. Only a genuinely new target resets it.
//
// Returns the names of stores that were newly marked stale.
export async function markStaleWhereChanged(store, { signature, dims, allStale = false }) {
  if (!supportsVecMeta(store)) return [];
  const rows = await store.listVecMeta();
  const changed = [];
  for (const row of rows) {
    // Leave a store that is already working toward this exact signature
    // completely alone — including its reindexing status. That is what makes
    // an interrupted reindex resume rather than restart.
    if (!allStale && row.signature === signature) continue;

    // A new target, or a storage resize that destroyed every vector, restarts
    // the reindex for this store from the beginning — including the clear, so
    // the checkpoint resets with the status. The lease resets too: a runner
    // already reindexing toward the old target still holds reindex_owner and
    // would keep renewing against it (renewal only checks owner, not
    // signature), eventually calling markCurrent with the old signature and
    // silently overwriting the `stale` row this write just made. Clearing the
    // owner here makes that runner's next renewal fail and stop.
    await store.updateVecMeta(row.store_name, {
      signature,
      dims,
      status: VEC_STATUS.STALE,
      vectors_cleared: false,
      reindex_owner: null,
      reindex_expires_at: null,
    });
    changed.push(row.store_name);
  }
  return changed;
}

export async function markReindexing(store, storeName) {
  if (!supportsVecMeta(store)) return;
  await store.updateVecMeta(storeName, { status: VEC_STATUS.REINDEXING });
}

// A store that has reached `current` is nobody's to reindex, so the lease is
// dropped in the same write that flips the status — otherwise a crash between
// the two would leave a completed store looking claimed until the lease aged
// out.
export async function markCurrent(store, storeName, { signature, dims }) {
  if (!supportsVecMeta(store)) return;
  await store.updateVecMeta(storeName, {
    status: VEC_STATUS.CURRENT,
    // The checkpoint only means anything inside a reindex; a current store has
    // nothing pending to clear, and leaving it true would be a lie the next
    // claim has to remember to override.
    vectors_cleared: false,
    reindex_owner: null,
    reindex_expires_at: null,
    ...(signature ? { signature } : {}),
    ...(dims ? { dims } : {}),
  });
}

// Completes a reindex atomically: the ownership check and the current
// transition happen in one database statement, closing the window a separate
// renewLease() + markCurrent() pair leaves open. That pair can straddle a
// configuration change — renewLease succeeds, then markStaleWhereChanged
// reassigns the store to a new target and clears the lease, then the
// unconditional markCurrent() still lands and re-enables search over vectors
// from the old, now-wrong embedding space. Checking ownership in the WHERE
// clause means the write only lands if nothing reassigned the store since
// this runner started — markStaleWhereChanged always clears reindex_owner in
// the same write that moves a store to a new target, so a reassignment always
// shows up here as an owner mismatch, and the write is refused rather than
// raced.
//
// Returns whether the transition happened. False means another runner (or a
// new target) owns the store now — the caller must leave it in `reindexing`.
export async function finalizeCurrent(store, storeName, owner, { signature, dims }) {
  if (!supportsVecMeta(store)) return true;
  // No owner to condition on, or a backend/test double that predates the
  // atomic method: fall back to the unconditional write — single-runner
  // correctness is unaffected, only the cross-process guarantee narrows.
  if (!owner || typeof store.finalizeVecMetaReindex !== "function") {
    await markCurrent(store, storeName, { signature, dims });
    return true;
  }
  return store.finalizeVecMetaReindex(storeName, owner, { signature, dims });
}
