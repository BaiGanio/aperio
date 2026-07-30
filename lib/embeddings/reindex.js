// lib/embeddings/reindex.js — resumable, per-store embedding reindex driver
// (issue #287, WS1 steps 1.4 and 1.6).
//
// Drives a store from `stale` through `reindexing` to `current`:
//
//   stale       the store's recorded signature no longer matches the running
//               configuration. Its vectors are still on disk but belong to the
//               old embedding space, so search is FTS-only.
//   reindexing  this driver has cleared that store's vectors and is re-embedding
//               its rows. Still FTS-only — a half-reindexed store holds a mix of
//               old- and new-space vectors, the exact thing WS1 exists to stop.
//   current     every row is embedded in the running configuration's space.
//
// Resumability needs almost no per-row bookkeeping: the vectors are cleared
// exactly once per reindex, and from then on "rows still needing work" is just
// the existing without-embeddings scan each store already has. An interrupted
// run restarts at `reindexing`, skips the clear, and picks up precisely the
// rows it had not reached. Re-embedding therefore costs exactly one embedding
// call per row across any number of interruptions.
//
// The one thing the status cannot express is whether the clear itself happened,
// so `vec_meta.vectors_cleared` records it: a process killed between the status
// write and the clear would otherwise resume at `reindexing`, skip the clear,
// see nothing missing a vector, and mark the store current with every old-space
// vector intact.
//
// Rows are read in bounded pages rather than one whole-corpus query. A docgraph
// with a hundred thousand chunks would otherwise have every chunk's full text
// resident before the first embedding call.
//
// This module deliberately takes `generateEmbedding` and the target signature
// as arguments rather than importing them from lib/helpers/embeddings.js's
// runtime state, so the caller decides which provider is in play and there is
// no import cycle back through the module that marks stores stale.

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import logger from "../helpers/logger.js";
import {
  VECTOR_STORES,
  VEC_STATUS,
  supportsVecMeta,
  markReindexing,
  finalizeCurrent,
} from "../helpers/vecMeta.js";
import { getWikiPending, setWikiEmbedding } from "../helpers/embeddings.js";

// How long a claim stays valid without a heartbeat, and how often a working
// runner refreshes it. The lease must outlive a single embedding call by a
// wide margin — a slow cloud provider taking 30s on one row must not look
// like a crashed runner — while still freeing a genuinely dead runner's store
// in a timespan an operator will tolerate.
const LEASE_MS = 120_000;
const LEASE_RENEW_EVERY_MS = 30_000;

// Rows fetched per query. An implementation detail rather than an operator
// knob: it trades one round trip per page against how much row text is
// resident at once, and neither side of that trade is something a deployment
// needs to tune. Large enough that a page fetch is amortized over a lot of
// embedding calls, small enough that a corpus of any size costs bounded memory.
const PAGE_SIZE = 200;

// Bounds the "sweep every source again" loop in reindexOne (see its comment
// on why one pass over `sources` is not enough). Idle rounds are cheap — one
// empty-page query per source — so this only matters when a source is under
// sustained concurrent writes; past this many rounds the run simply leaves
// the store in `reindexing` and resumes next time, same as an aborted pass.
const MAX_SETTLE_ROUNDS = 10;

// Identifies this runner in vec_meta.reindex_owner. Includes the host and pid
// so an operator looking at a stuck lease can tell which process holds it.
function makeOwnerId() {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

// Leasing degrades gracefully: a store backend without the lease methods (a
// test double, or a database still on an older schema) behaves as it did
// before — single-runner correctness is unaffected, only the cross-process
// guarantee is.
// `expectedSignature`, when given, refuses the claim if the row's signature no
// longer matches it — see runReindex, which passes the signature the row
// carried at listing time. Without this, a configuration change landing
// between listPendingStores() and this claim would let the caller claim,
// clear, and rebuild a row that has already been retargeted, then finalize it
// as current under a signature the row no longer represents.
async function claimStore(store, storeName, owner, expectedSignature) {
  if (typeof store.claimVecMetaReindex !== "function") {
    const row = await store.getVecMeta?.(storeName);
    const previousStatus = row?.status ?? null;
    if (expectedSignature !== undefined && row && row.signature !== expectedSignature) {
      return { claimed: false, previousStatus };
    }
    await markReindexing(store, storeName);
    // No checkpoint column to consult on a backend this old, so fall back to
    // what the status alone implies — exactly the behavior these stores had
    // before the checkpoint existed.
    return { claimed: true, previousStatus, vectorsCleared: previousStatus === VEC_STATUS.REINDEXING };
  }
  return store.claimVecMetaReindex(storeName, owner, LEASE_MS, expectedSignature);
}

async function renewLease(store, storeName, owner) {
  if (typeof store.renewVecMetaLease !== "function") return true;
  return store.renewVecMetaLease(storeName, owner, LEASE_MS);
}

// Keeps this runner's lease alive on its own clock instead of between rows.
//
// Renewing in the row loop ties the lease to how long one embedding call takes:
// a cloud provider stalling for longer than LEASE_MS lets another runner claim
// the store while this one sits in `await generateEmbedding`, and this one then
// writes vectors — and possibly calls markCurrent, which drops the *new*
// owner's lease — into a reindex it no longer owns. A timer renews regardless
// of where the loop is, and `lost` latches the moment a renewal is refused so
// the loop can stop before its next write.
//
// A renewal that *errors* is not evidence of losing the store (a transient
// database hiccup looks identical), so it only warns; the lease itself is what
// expires if the trouble persists.
function startLeaseHeartbeat(store, storeName, owner) {
  const state = { lost: false };
  if (!owner || typeof store.renewVecMetaLease !== "function") {
    return { state, stop() {} };
  }

  let timer = null;
  let stopped = false;

  const tick = async () => {
    timer = null;
    if (stopped) return;
    try {
      if (!await store.renewVecMetaLease(storeName, owner, LEASE_MS)) {
        state.lost = true;
        return;
      }
    } catch (err) {
      logger.warn(`[reindex] ${storeName}: lease renewal failed, will retry: ${err.message}`);
    }
    if (!stopped && !state.lost) schedule();
  };

  const schedule = () => {
    timer = setTimeout(tick, LEASE_RENEW_EVERY_MS);
    // Never hold the process open for a heartbeat — the run itself is what the
    // caller awaits.
    timer.unref?.();
  };

  schedule();
  return {
    state,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

async function releaseStore(store, storeName, owner) {
  if (typeof store.releaseVecMetaReindex !== "function") return;
  try {
    await store.releaseVecMetaReindex(storeName, owner);
  } catch (err) {
    // A lease we failed to release simply expires — never let it mask the
    // reindex result.
    logger.warn(`[reindex] ${storeName}: releasing the lease failed: ${err.message}`);
  }
}

// One adapter per logical vector store: which independent row sets it is made
// of, how to read one bounded page of rows still needing a vector, and how to
// write one back. Every `pending` implementation reuses the scan that store
// already relies on for ordinary backfill, so this driver adds no new query
// shapes to keep in sync.
//
// `sources` exists for the two graph stores, which are partitioned by watched
// root and whose pending scans are deliberately root-scoped (a WS0 fix: an
// unscoped scan made every watched root re-enqueue every other root's rows).
// Yielding one source per root lets the driver page through each root in turn
// instead of concatenating every root's rows into one array.
const SINGLE_SOURCE = [null];

const ADAPTERS = {
  memories: {
    async pending(store, _source, page) {
      const rows = await store.listWithoutEmbeddings(page);
      return rows.map(r => ({ id: r.id, text: `${r.title}. ${r.content}` }));
    },
    setEmbedding: (store, id, embedding) => store.setEmbedding(id, embedding),
  },

  wiki: {
    async pending(store, _source, page) {
      const rows = await getWikiPending(store, page);
      // SQLite's listWithoutEmbeddings returns body_md; Postgres already
      // aliases its column to content. Normalize here rather than in the
      // store, since callers of listWithoutEmbeddings elsewhere want the raw
      // column name.
      return rows.map(r => ({ id: r.id, text: `${r.title}. ${r.content ?? r.body_md ?? ""}` }));
    },
    setEmbedding: (store, id, embedding) => setWikiEmbedding(store, id, embedding),
  },

  self_memories: {
    async pending(store, _source, page) {
      if (typeof store.listSelfWithoutEmbeddings !== "function") return [];
      const rows = await store.listSelfWithoutEmbeddings(page);
      return rows.map(r => ({ id: r.id, text: `${r.title}. ${r.content}` }));
    },
    setEmbedding: (store, id, embedding) => store.setSelfEmbedding(id, embedding),
  },

  codegraph: {
    async sources(store) {
      const { listRepoRoots } = await import("../codegraph/indexer.js");
      return listRepoRoots(store);
    },
    async pending(store, root, page) {
      const { listPendingEmbeddings } = await import("../codegraph/indexer.js");
      return listPendingEmbeddings(store, root, page);
    },
    async setEmbedding(store, id, embedding) {
      const { setSymbolEmbedding } = await import("../codegraph/indexer.js");
      return setSymbolEmbedding(store, id, embedding);
    },
  },

  docgraph: {
    async sources(store) {
      const { listRepoRoots } = await import("../docgraph/indexer.js");
      return listRepoRoots(store);
    },
    async pending(store, root, page) {
      const { listPendingEmbeddings } = await import("../docgraph/indexer.js");
      return listPendingEmbeddings(store, root, page);
    },
    async setEmbedding(store, id, embedding) {
      const { setChunkEmbedding } = await import("../docgraph/indexer.js");
      return setChunkEmbedding(store, id, embedding);
    },
  },
};

// Stores that are not fully synced to the running configuration, in the order
// they should be processed.
export async function listPendingStores(store) {
  if (!supportsVecMeta(store)) return [];
  const rows = await store.listVecMeta();
  return rows.filter(r => r.status !== VEC_STATUS.CURRENT);
}

// Reindexes one store. Assumes its vectors have already been cleared if it was
// stale, and that the caller holds this store's lease — see runReindex, which
// owns both.
async function reindexOne(store, storeName, { generateEmbedding, signature, dims, onProgress, signal, owner }) {
  const adapter = ADAPTERS[storeName];
  if (!adapter) throw new Error(`reindex: unknown store "${storeName}"`);

  let done = 0;
  let failed = 0;
  let lost = false;
  let aborted = false;
  // True only once a full settle round finds nothing left anywhere — never
  // set if the round budget runs out while sources are still yielding new
  // work, so sustained concurrent writes leave the store in `reindexing`
  // (and resumable next run) instead of finalizing over rows it never
  // actually confirmed were embedded.
  let settled = false;

  const heartbeat = startLeaseHeartbeat(store, storeName, owner);

  // Pages through one source's pending scan until it comes back empty,
  // returning how many rows this call embedded or permanently failed on.
  // Extracted so the sweep below can call it again for a source it already
  // finished this run — `sources` is a one-time snapshot (adapter.sources
  // above), but for the two graph adapters a source is a watched root, and a
  // root's watcher.js can start a fresh indexRepo pass — and defer its own
  // embedding here, trusting this run hasn't passed its root yet — for a
  // root this run visited and found empty *before* that pass lands its new
  // rows. Without a re-sweep, this run would move on, eventually mark the
  // store `current`, and those rows would never get embedded by anyone.
  async function processSource(source) {
    let processedHere = 0;
    // Rows this call has already tried and failed on. They keep matching the
    // pending scan, so without skipping them the next page would hand them
    // back forever — one wasted embedding call per page. Ordering is stable
    // and every row before the cursor either succeeded (and dropped out of
    // the scan) or failed, so the failures are exactly the leading rows of
    // what is left.
    let stuck = 0;

    for (;;) {
      if (signal?.aborted) { aborted = true; return processedHere; }
      if (heartbeat.state.lost) { lost = true; return processedHere; }

      const page = await adapter.pending(store, source, { limit: PAGE_SIZE, offset: stuck });
      if (!page.length) return processedHere;

      for (const row of page) {
        if (signal?.aborted) { aborted = true; return processedHere; }
        if (heartbeat.state.lost) { lost = true; return processedHere; }

        let embedding = null;
        try {
          embedding = await generateEmbedding(row.text);
        } catch (err) {
          logger.warn(`[reindex] ${storeName}: embedding failed for ${row.id}: ${err.message}`);
        }

        if (heartbeat.state.lost) { lost = true; return processedHere; }

        if (embedding) {
          try {
            // Ownership can change during that await — it is by far the
            // slowest thing this loop does, and the heartbeat's last tick can
            // be a whole renewal interval old (or older still, if the await
            // blocked the event loop long enough to delay the heartbeat's own
            // timer). Re-checking here costs one small UPDATE next to an
            // embedding call, and it is the difference between stopping and
            // writing into a store another runner now owns — which is how the
            // one-call-per-row guarantee quietly becomes two.
            if (owner && !await renewLease(store, storeName, owner)) {
              heartbeat.state.lost = true;
              lost = true;
              return processedHere;
            }
            await adapter.setEmbedding(store, row.id, embedding);
            done++;
          } catch (err) {
            // A graceful shutdown that hits its timeout abandons this loop
            // (see startBackgroundReindex's shutdown()) while the store may
            // already be mid-close by the time this write lands — the same
            // race a lost lease already forces this loop to tolerate. Rather
            // than let that throw escape the row loop (which would abort
            // every remaining row and store in this run, not just this one),
            // treat it exactly like a failed embedding: the row stays
            // unembedded and is retried next boot, one wasted call away from
            // the same "resumable, no double-write" guarantee the rest of
            // this driver already provides.
            logger.warn(`[reindex] ${storeName}: failed to persist embedding for ${row.id}: ${err.message}`);
            failed++;
            stuck++;
          }
        } else {
          // A null embedding means the provider declined or is unreachable.
          // Count it, step the cursor past it, and keep going — but do not
          // let the store reach `current`; the run resumes on the next boot
          // or CLI invocation.
          failed++;
          stuck++;
        }
        processedHere++;
        onProgress?.({ store: storeName, done, failed, total: done + failed });
      }
    }
  }

  try {
    const sources = adapter.sources ? await adapter.sources(store) : SINGLE_SOURCE;

    for (const source of sources) {
      await processSource(source);
      if (aborted || lost) break;
    }

    // A single pass already decided this run isn't clean (aborted, lost the
    // lease, or a row failed) — it is not a `current` candidate regardless,
    // so any stray rows a concurrent writer adds mid-pass are exactly as safe
    // left for the next run as everything else this pass didn't reach. Only
    // a pass headed for a clean finish is worth re-sweeping to prove there is
    // truly nothing left anywhere before letting it finalize.
    if (!aborted && !lost && failed === 0) {
      for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
        let processedThisRound = 0;
        for (const source of sources) {
          processedThisRound += await processSource(source);
          if (aborted || lost || failed > 0) break;
        }
        if (aborted || lost || failed > 0) break;
        if (processedThisRound === 0) { settled = true; break; }
      }
    }
  } finally {
    heartbeat.stop();
  }

  if (lost) {
    logger.warn(`[reindex] ${storeName}: lost the reindex lease to another runner — stopping`);
  }

  aborted = aborted || !!signal?.aborted || lost;
  // Only a clean sweep with nothing outstanding may flip the store to current.
  // An empty store qualifies: nothing to embed means nothing in the wrong
  // space, which is also what lets a run killed on its final row finish on
  // resume rather than getting stuck in `reindexing` forever. `settled` is
  // the settle-loop's own proof of that emptiness — without it, exhausting
  // the round budget while sources keep yielding new work would otherwise
  // look identical to a clean finish here (aborted/lost/failed all still
  // clear) and finalize the store over rows it never confirmed were embedded.
  let completed = !aborted && failed === 0 && settled;
  const settleExhausted = !completed && !aborted && failed === 0;

  // The ownership check and the current transition happen in one statement
  // (finalizeCurrent) rather than a separate renew-then-write pair — a gap
  // between those two calls is exactly where another process's config change
  // could land and get overwritten by this runner's stale write.
  if (completed) {
    completed = await finalizeCurrent(store, storeName, owner, { signature, dims });
    if (!completed) {
      lost = true;
      logger.warn(`[reindex] ${storeName}: another runner or a new reindex target owns this store — not marking it current`);
    }
  }

  // `total` is what this run processed, not a corpus size: pages are read as
  // the run goes, so there is no up-front count to report. For a completed run
  // the two are the same number.
  const total = done + failed;
  if (completed) {
    logger.info(`[reindex] ${storeName}: complete (${done} embedded) — vector search re-enabled`);
  } else {
    logger.warn(
      `[reindex] ${storeName}: incomplete (${done} embedded, ${failed} failed` +
      `${aborted || lost ? ", aborted" : ""}${settleExhausted ? `, sources kept yielding new work through ${MAX_SETTLE_ROUNDS} settle round(s)` : ""}) — ` +
      `staying in ${VEC_STATUS.REINDEXING}; will resume`
    );
  }
  return { store: storeName, total, done, failed, completed };
}

// Reindexes every store that is not `current`.
//
// `signature`/`dims` describe the configuration being reindexed toward; they
// are written onto each store's vec_meta row when it completes.
export async function runReindex(store, {
  generateEmbedding,
  signature,
  dims,
  stores = VECTOR_STORES,
  onProgress,
  signal,
  owner = makeOwnerId(),
} = {}) {
  if (!supportsVecMeta(store)) return { supported: false, results: [] };
  if (typeof generateEmbedding !== "function") {
    throw new Error("runReindex: generateEmbedding is required");
  }

  const pendingStores = (await listPendingStores(store))
    .filter(r => stores.includes(r.store_name));

  const results = [];
  for (const row of pendingStores) {
    if (signal?.aborted) break;

    // Take the store atomically before touching anything, bound to the
    // target this call means to reindex toward. Without the claim, the
    // server's background reindex and an operator's CLI run would both select
    // the same row: one clears vectors the other has already rebuilt, and the
    // rest get embedded twice. Without binding it to `signature`, a
    // configuration change retargeting this row — whether just before it was
    // listed above or in the moment before this claim — would let this call
    // claim and rebuild a row that no longer represents the target it thinks
    // it's working toward, then finalize it as current under a signature the
    // row was never marked stale for. Every real caller (the CLI, the
    // background reindex) already keeps a store's recorded signature in sync
    // with this exact value: checkEmbeddingProvider() writes it via
    // markStaleWhereChanged() immediately before invoking this function with
    // the same signature.
    const claim = await claimStore(store, row.store_name, owner, signature);
    if (!claim.claimed) {
      logger.info(`[reindex] ${row.store_name}: already being reindexed by another runner (or its target changed) — skipping`);
      results.push({ store: row.store_name, total: 0, done: 0, failed: 0, completed: false, skipped: true });
      continue;
    }

    try {
      // The one destructive step, and it happens exactly once per reindex.
      //
      // The checkpoint comes from inside the atomic claim precisely so this
      // decision cannot race, and it is a stored fact rather than an inference
      // from the status: a store that reached `reindexing` has not necessarily
      // been cleared — a process killed between those two writes would resume,
      // skip the clear, find nothing missing a vector, and mark the store
      // current with its entire old embedding space intact. Clearing twice is
      // just as wrong in the other direction, throwing away completed work and
      // breaking the one-embedding-call-per-row guarantee.
      if (!claim.vectorsCleared) {
        if (typeof store.clearStoreEmbeddings === "function") {
          await store.clearStoreEmbeddings(row.store_name);
        }
        // Recorded straight after the clear, so the only window a crash can
        // leave behind is one where the next runner re-clears an empty store.
        await store.markVectorsCleared?.(row.store_name);
      }

      results.push(await reindexOne(store, row.store_name, {
        generateEmbedding, signature, dims, onProgress, signal, owner,
      }));
    } finally {
      // Hand the store back so a later run (or another process) can pick it up
      // immediately rather than waiting out the lease.
      await releaseStore(store, row.store_name, owner);
    }
  }

  return { supported: true, results };
}

// Fire-and-forget reindex for server/MCP boot, with a shutdown hook so an
// in-flight run is abandoned cleanly instead of holding the process open or
// writing embeddings into a database that is closing. Anything not finished is
// picked up on the next boot — the store simply stays `reindexing`.
export function startBackgroundReindex(store, { generateEmbedding, signature, dims } = {}) {
  const controller = new AbortController();

  const done = (async () => {
    try {
      const pending = await listPendingStores(store);
      if (!pending.length) return;
      logger.info(
        `[reindex] ${pending.length} store(s) need reindexing after an embedding-configuration change: ` +
        `${pending.map(p => p.store_name).join(", ")} — these serve full-text results until it completes`
      );
      await runReindex(store, { generateEmbedding, signature, dims, signal: controller.signal });
    } catch (err) {
      logger.error(`[reindex] background reindex failed: ${err.message}`);
    }
  })();

  return {
    shutdown: (timeoutMs = 5000) => {
      controller.abort();
      return Promise.race([
        done.catch(() => {}),
        new Promise(r => setTimeout(r, timeoutMs)),
      ]);
    },
  };
}
