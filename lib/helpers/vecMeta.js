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

// False on a machine where sqlite-vec has no prebuilt extension (win32-arm64
// today): the vec_* sidecars exist only as ordinary tables, so `embedding
// MATCH ?` is impossible and a vector written into one is an opaque blob
// nothing can ever read back. Two things hang off this: search serves FTS-only
// (isVectorSearchable below), and the reindex driver refuses to run, because a
// full re-embedding pass there would spend one local inference or paid API call
// per row to produce blobs that are unsearchable now and destroyed by
// reconcileVecSidecars the moment the database returns to a supported machine.
// Backends that never set the flag (Postgres, test doubles) read as supported.
export function vectorStorageSupported(store) {
  return store?.vectorSupported !== false;
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
  // No sqlite-vec extension on this platform (win32-arm64 has no prebuilt
  // build): the vec_* sidecars exist as ordinary tables, so reads and writes
  // still work, but `embedding MATCH ?` does not. Nothing is comparable, so
  // every store is FTS-only. Backends that never set the flag read as
  // supported, which is the pre-existing behavior.
  if (!vectorStorageSupported(store)) return false;
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

// The write-side twin of isVectorSearchable: may *this* process persist a
// vector it just computed into this store?
//
// Same predicate, deliberately — one notion of "this store's vectors belong to
// my embedding space" for both directions — but the two are separate names
// because they answer different questions and the callers are disjoint. Read
// sites ask "can I score against what is in there"; write sites ask "would
// adding mine make what is in there inconsistent".
//
// Why the write path needs a gate at all (issue #340): vectors are opaque
// blobs with no per-row provenance, so nothing downstream can tell a
// foreign-space vector from a correct one. A second process still on the old
// EMBEDDING_PROVIDER can otherwise land its vector on a row this process's
// reindex just cleared; the reindex driver's pending scan only sees rows
// *missing* a vector, so that row silently drops out of the scan, the settle
// pass finds nothing left, and the store finalizes to `current` holding a mix
// of two embedding spaces — under a store-level signature that looks perfectly
// correct to isVectorSearchable(), because only the individual row is wrong.
//
// Refusing costs nothing permanent: the row is simply left without an
// embedding, which is exactly the `pending` state the store's own reindex
// driver scans for and fills in under the signature that actually owns the
// store. Fail-closed on error (inherited from isVectorSearchable) points the
// same way here — a skipped embedding is recoverable, a mixed store is not.
//
// NOT for the reindex driver's own writes (lib/embeddings/reindex.js's
// adapters), which deliberately write while the store is `reindexing` and
// would gate themselves to a standstill. For the same reason this must never
// move down into the shared low-level setters (setWikiEmbedding,
// setSymbolEmbedding, setChunkEmbedding, store.setEmbedding) that both the
// driver and ordinary writes call — it belongs at the ordinary call sites.
export async function canPersistEmbedding(store, storeName) {
  return isVectorSearchable(store, storeName);
}

// Computes an embedding for a store, gated on both sides of the (slow) model
// call. Every ordinary write path should go through this rather than calling
// canPersistEmbedding by hand, for the same reason the rest of this module
// exists: the two checks are easy to get half-right, and half-right here is
// indistinguishable from correct until a store is quietly holding two
// embedding spaces.
//
// The first check is purely economy — a closed gate means the vector would be
// thrown away, so skipping the inference saves a local model run or a paid API
// call per row, which matters most in the batch loops (imports, backfills,
// retry queues) that call this thousands of times.
//
// The second check is the correctness one. The gate can close *during* the
// embedding call — that call is by far the slowest thing on the write path,
// and a reindex starting inside that window is precisely the race in issue
// #340. Re-reading right before the write shrinks the exposure from the length
// of a model inference to the length of one primary-key lookup on a five-row
// table. It does not eliminate it: closing the window completely would need
// the vec_meta read and the row write in one transaction, which the shared
// low-level setters cannot offer without also gating the reindex driver that
// calls them. What is left is a window the reindex driver already tolerates
// elsewhere, and one the settle pass re-scans across.
//
// Returns { embedding, deferred }. `deferred: true` means the gate refused —
// the caller must write the row *without* a vector and must not queue it for
// retry: it is now the store's reindex driver's job, and a retry queue would
// only re-race the same gate until it gave up. `deferred: false` with a null
// embedding is an ordinary provider failure, which retry queues should handle
// exactly as they always have.
export async function embedForStore(store, storeName, embed) {
  if (!await canPersistEmbedding(store, storeName)) return { embedding: null, deferred: true };
  const embedding = await embed();
  if (embedding && !await canPersistEmbedding(store, storeName))
    return { embedding: null, deferred: true };
  return { embedding, deferred: false };
}

// embedForStore in the shape of a plain embedding function, for the two graph
// indexers: their inline embedding happens row-by-row deep inside the four
// backend modules, which have no business knowing about vec_meta. Handing them
// a wrapped embedder gates every row without any of them changing — a refused
// row simply comes back null, which their embedInline loops already skip and
// their pending scans already re-find.
export function gatedEmbedder(store, storeName, embed) {
  if (typeof embed !== "function") return embed;
  return async (text, inputType) => {
    const { embedding } = await embedForStore(store, storeName, () => embed(text, inputType));
    return embedding;
  };
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

// Forces specific stores to `stale`, keeping whatever signature they carry.
//
// Unlike markStaleWhereChanged, this is not about the embedding configuration
// changing — it is for storage that was physically emptied underneath a store
// whose signature is still perfectly correct (a SQLite database moved between a
// machine with the sqlite-vec extension and one without it, rebuilding the
// sidecars either way). Nothing about the signature or the dimensions moved, so
// no comparison would ever notice; without this the store stays `current` over
// empty tables and vector search silently returns nothing.
//
// Must be persisted rather than kept in memory for the run that discovered it:
// the discovery happens once, at open, and a boot with embeddings disabled (or
// one that simply ends) would otherwise drop the signal for good — and a later
// boot with the provider re-enabled at the same signature would find `current`
// and schedule no reindex at all.
export async function markStoresStale(store, storeNames) {
  if (!supportsVecMeta(store) || !storeNames?.length) return [];
  const marked = [];
  for (const name of storeNames) {
    if (!VECTOR_STORES.includes(name)) continue;
    await store.updateVecMeta(name, {
      status: VEC_STATUS.STALE,
      // Same reset markStaleWhereChanged performs: the checkpoint and the lease
      // both belong to a reindex toward the old contents, and a runner still
      // holding the lease would otherwise renew and finalize over this.
      vectors_cleared: false,
      reindex_owner: null,
      reindex_expires_at: null,
    });
    marked.push(name);
  }
  return marked;
}

// ── The rebuilt-store marker ────────────────────────────────────────────────
//
// SQLite only. When a database moves between a machine where sqlite-vec loads
// and one where it does not, reconcileVecSidecars() rebuilds the sidecars at
// open time and their vectors are gone. SqliteStore exposes the affected store
// names on `.rebuiltVectorStores`, but that property lives and dies with the
// process — and the process that opens a database first is very often not the
// server: scripts/config-sync.js, the terminal runtime and both graph indexers
// all open a store and exit without ever calling checkEmbeddingProvider().
// The vectors are destroyed all the same, so the next server boot would see
// correctly-shaped empty sidecars, an empty rebuilt list, and vec_meta still
// reading `current` — semantic search enabled over nothing, with no signal
// anywhere that a reindex is owed.
//
// So the list is written into `settings` as well, where it waits for whichever
// process next runs checkEmbeddingProvider(). It accumulates rather than
// overwrites: two such openings before the next server boot must not lose the
// first one's stores.
const REBUILT_PENDING_KEY = "vec_rebuilt_pending";

export async function recordRebuiltVectorStores(store, storeNames) {
  const names = (storeNames ?? []).filter(n => VECTOR_STORES.includes(n));
  if (!names.length || typeof store?.setSetting !== "function") return [];
  const pending = await readRebuiltVectorStores(store);
  const merged = [...new Set([...pending, ...names])];
  if (merged.length === pending.length) return pending;
  await store.setSetting(REBUILT_PENDING_KEY, merged);
  return merged;
}

export async function readRebuiltVectorStores(store) {
  if (typeof store?.getSetting !== "function") return [];
  try {
    const value = await store.getSetting(REBUILT_PENDING_KEY);
    return Array.isArray(value) ? value.filter(n => VECTOR_STORES.includes(n)) : [];
  } catch (err) {
    // A database too old to have `settings`, or mid-migration. Losing the
    // marker is bad; refusing to open the database over it is worse.
    logger.debug(`[vec_meta] could not read the rebuilt-store marker: ${err.message}`);
    return [];
  }
}

// Cleared only once the stores have actually been marked stale, so a crash in
// between leaves the marker for the next boot rather than dropping it.
export async function clearRebuiltVectorStores(store) {
  if (typeof store?.deleteSetting !== "function") return;
  try {
    await store.deleteSetting(REBUILT_PENDING_KEY);
  } catch (err) {
    logger.warn(`[vec_meta] could not clear the rebuilt-store marker: ${err.message}`);
  }
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
