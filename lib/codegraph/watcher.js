// lib/codegraph/watcher.js
// chokidar-backed live updater for the code graph. One watcher per root.
//
// Lifecycle:
//   1. On start: indexRepo(root) (full pass, sha256 short-circuits noop files)
//   2. sweepMissing(root) — drop DB rows for files deleted while we were off
//   3. chokidar watches the tree; add/change → indexFile, unlink → removeFile
//
// Debounce: per-file 250 ms. Editors (vim, vscode) emit a flurry of write
// events on save; debouncing collapses those into one reindex.

import chokidar from 'chokidar';
import path from 'path';
import { indexRepo, indexFile, removeFile, sweepMissing, isCodegraphAvailable, listPendingEmbeddings, listRepoRoots, SKIP_DIRS, JS_EXT } from './indexer.js';
import { createSymbolEmbeddingQueue } from './symbol-embedding-queue.js';
import { generateEmbedding } from '../helpers/embeddings.js';
import { pendingStoreNames } from '../helpers/vecMeta.js';
import { isReadPathAllowed } from '../routes/paths.js';
import { markRootStarted, markRootProgress, markRootDone, markRootError } from './status.js';
import logger, { logError } from '../helpers/logger.js';

const DEBOUNCE_MS = 250;

function isPermissionError(err) {
  return err?.code === 'EPERM' || err?.code === 'EACCES';
}

function actionablePermissionError(rootPath, cause) {
  const macHelp = process.platform === 'darwin'
    ? ' In macOS System Settings → Privacy & Security, grant Files and Folders (or Full Disk Access) to the app that launches Aperio, then restart Aperio.'
    : ' Grant the Aperio process read/watch permission for this directory, then restart Aperio.';
  const error = new Error(`Filesystem permission denied while watching ${rootPath}.${macHelp}`);
  error.code = cause?.code ?? 'EPERM';
  error.cause = cause;
  return error;
}

async function waitUntilReady(watcher) {
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        watcher.off('ready', onReady);
        watcher.off('error', onError);
      };
      const onReady = () => { cleanup(); resolve(); };
      const onError = (err) => { cleanup(); reject(err); };
      watcher.once('ready', onReady);
      watcher.once('error', onError);
    });
    return watcher;
  } catch (err) {
    await watcher.close().catch(() => {});
    throw err;
  }
}

export async function openChokidarWatcher(rootPath, options, { watch = chokidar.watch } = {}) {
  try {
    const watcher = await waitUntilReady(watch(rootPath, options));
    return { watcher, mode: 'native' };
  } catch (err) {
    if (!isPermissionError(err)) throw err;
    logger.warn(`[codegraph] native watcher denied for ${rootPath}; retrying with polling`);
    try {
      const watcher = await waitUntilReady(watch(rootPath, { ...options, usePolling: true }));
      return { watcher, mode: 'polling' };
    } catch (pollErr) {
      if (isPermissionError(pollErr)) throw actionablePermissionError(rootPath, pollErr);
      throw pollErr;
    }
  }
}

function isIndexable(absPath) {
  if (JS_EXT.has(path.extname(absPath))) {
    // Reject anything inside a skipped dir.
    for (const part of absPath.split(path.sep)) {
      if (SKIP_DIRS.has(part)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Start a watcher for a single root path.
 * @param {pg.Pool} pool
 * @param {string}  rootPath  absolute path; must be inside APERIO_ALLOWED_PATHS_TO_READ
 * @param {import('events').EventEmitter} [events]  optional; emits a `change`
 *        event `{ kind: 'codegraph', root, relPath, op }` after each live
 *        index/remove (post-ready only — the initial bulk index does not fire).
 * @returns {Promise<{stop: () => Promise<void>}>}
 */
export async function startWatcher(store, rootPath, events, {
  isReadPathAllowed: checkReadPath = isReadPathAllowed,
  isCodegraphAvailable: checkAvailable = isCodegraphAvailable,
  listRepoRoots: getRepoRoots = listRepoRoots,
  createSymbolEmbeddingQueue: createEmbedQueue = createSymbolEmbeddingQueue,
  generateEmbedding: embed = generateEmbedding,
  indexRepo: indexRoot = indexRepo,
  pendingStoreNames: getPendingStoreNames = pendingStoreNames,
  listPendingEmbeddings: getPendingEmbeddings = listPendingEmbeddings,
  sweepMissing: sweepRoot = sweepMissing,
  indexFile: indexOneFile = indexFile,
  removeFile: removeOneFile = removeFile,
  openChokidarWatcher: openWatcher = openChokidarWatcher,
} = {}) {
  if (!checkReadPath(rootPath)) {
    throw new Error(`codegraph watcher refused: ${rootPath} not in APERIO_ALLOWED_PATHS_TO_READ`);
  }
  if (!checkAvailable(store)) {
    throw new Error(`codegraph watcher refused: backend has no graph store`);
  }

  logger.info(`[codegraph] watcher: initial index of ${rootPath}`);
  markRootStarted(rootPath);

  // Checked before indexRepo creates this root's cg_repos row (if it doesn't
  // already exist). The reindex driver's codegraph adapter snapshots
  // listRepoRoots() exactly once per run, at the top of its own loop — a root
  // that doesn't exist yet at that moment can never appear in that snapshot,
  // so no reindex run in progress right now will ever visit it. A root that
  // already existed *was* necessarily in the DB before any currently-running
  // driver pass took its snapshot, so deferring to that driver for an
  // already-known root is safe (review finding: a brand-new root added while
  // codegraph is stale/reindexing must not be silently skipped here, or its
  // symbols stay permanently unembedded once the driver finalizes the store
  // to `current` without ever having known this root existed).
  const rootAlreadyKnown = (await getRepoRoots(store)).includes(rootPath);

  // Async embedding queue — both the initial bulk pass and live saves defer
  // embedding here so the watcher goes live without blocking on the model. The
  // initial index used to embed every symbol inline (one serial Ollama call
  // each) inside a single transaction, which on a large repo could outrun the
  // idle-shutdown window and get killed before it ever committed.
  const embedQueue = createEmbedQueue({ store, generateEmbedding: embed });

  let indexCounts;
  try {
    const { pending: bulkPending, ...rest } = await indexRoot(store, rootPath, {
      deferEmbedding: true,
      onProgress: (counts) => markRootProgress(rootPath, counts),
    });
    indexCounts = rest;

    // A store the background reindex driver is already working through
    // (stale/reindexing after a provider/model/dims change) owns its own
    // backfill for every root its own run captured — lib/embeddings/
    // reindex.js's codegraph adapter walks this exact per-root pending scan.
    // Queuing the same rows here too would embed every one of them twice
    // (issue #287 review finding). Once the driver finishes and marks the
    // store current, this check naturally reverts to enqueueing here as
    // before. Restricted to `rootAlreadyKnown` — see above.
    const deferredToReindex = rootAlreadyKnown && (await getPendingStoreNames(store)).has("codegraph");
    if (!deferredToReindex) {
      if (bulkPending?.length) embedQueue.enqueueMany(bulkPending);

      // bulkPending only covers symbols touched by *this* indexing pass — an
      // unchanged file's symbols are skipped entirely, so a provider/model
      // change would otherwise leave them permanently unembedded. Same query
      // shape as initEmbeddings() for memories: fast no-op in the steady
      // state, catches everything a plain reindex would miss when it isn't.
      // enqueueMany dedupes by id, so overlap with bulkPending above is
      // harmless.
      const stillPending = await getPendingEmbeddings(store, rootPath);
      if (stillPending.length) embedQueue.enqueueMany(stillPending);
    }
  } catch (err) {
    embedQueue.shutdown();
    const startupError = isPermissionError(err) ? actionablePermissionError(rootPath, err) : err;
    markRootError(rootPath, startupError);
    throw startupError;
  }
  const swept = await sweepRoot(store, rootPath);
  if (swept.removed) logger.info(`[codegraph] watcher: swept ${swept.removed} stale file rows`);
  const pending = new Map();   // relPath → timer
  const schedule = (relPath, op) => {
    clearTimeout(pending.get(relPath));
    pending.set(relPath, setTimeout(async () => {
      pending.delete(relPath);
      try {
        if (op === 'index') {
          const r = await indexOneFile(store, rootPath, relPath);
          if (r?.pending?.length) embedQueue.enqueueMany(r.pending);
        }
        if (op === 'remove') await removeOneFile(store, rootPath, relPath);
        events?.emit('change', { kind: 'codegraph', root: rootPath, relPath, op });
      } catch (err) {
        logError(`[codegraph] watcher ${op} failed`, err, { rootPath, relPath });
      }
    }, DEBOUNCE_MS));
  };

  const watcherOptions = {
    ignored: (p) => {
      // Always allow the root itself; reject anything in a SKIP_DIRS segment.
      if (p === rootPath) return false;
      for (const part of p.split(path.sep)) {
        if (SKIP_DIRS.has(part)) return true;
      }
      return false;
    },
    ignoreInitial: true,           // initial pass is done by indexRepo above
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    persistent: true,
  };

  let watcher, watchMode;
  try {
    ({ watcher, mode: watchMode } = await openWatcher(rootPath, watcherOptions));
  } catch (err) {
    embedQueue.shutdown();
    markRootError(rootPath, err);
    throw err;
  }

  watcher
    .on('add',    (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'index'); })
    .on('change', (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'index'); })
    .on('unlink', (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'remove'); })
    .on('error',  (err) => logError(`[codegraph] chokidar error`, err, { rootPath }));

  markRootDone(rootPath, indexCounts);
  logger.info(`[codegraph] watcher: live for ${rootPath}${watchMode === 'polling' ? ' (polling fallback)' : ''}`);

  let stopped = false;
  return {
    root: rootPath,
    async stop() {
      if (stopped) return; // idempotent: registry + shutdown may both call this
      stopped = true;
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      embedQueue.shutdown();
      await watcher.close();
    },
  };
}

/**
 * Start watchers for every path in APERIO_ALLOWED_PATHS_TO_READ.
 * Returns a stop() that shuts them all down.
 * @param {import('events').EventEmitter} [events] forwarded to each startWatcher.
 */
export async function startAllWatchers(store, roots, events) {
  const { markAllDone } = await import('./status.js');
  // Drop any root that is nested inside another root — it would be redundant
  // (or, like var/scratch, intentionally skipped by the parent via SKIP_DIRS).
  const dedupedRoots = roots.filter(r =>
    !roots.some(other => other !== r && r.startsWith(other + path.sep))
  );
  const handles = [];
  for (const root of dedupedRoots) {
    try {
      handles.push(await startWatcher(store, root, events));
    } catch (err) {
      logError(`[codegraph] watcher: failed to start for ${root}`, err);
    }
  }
  markAllDone();
  return {
    handles, // per-root { root, stop } handles, so the caller can register each by root
    async stop() {
      await Promise.allSettled(handles.map(h => h.stop()))
        .then(results => {
          for (const r of results) {
            if (r.status === 'rejected') logError('[codegraph] watcher stop failed', r.reason);
          }
        });
    },
  };
}
