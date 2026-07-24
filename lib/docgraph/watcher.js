// lib/docgraph/watcher.js
// chokidar-backed live updater for the document graph. One watcher per root.
// Mirrors lib/codegraph/watcher.js.
//
// Lifecycle:
//   1. On start: indexRepo(root) (full pass, sha256 short-circuits noop files)
//   2. sweepMissing(root) — drop DB rows for docs deleted while we were off
//   3. chokidar watches the tree; add/change → indexFile, unlink → removeFile
//
// The initial indexRepo pass embeds inline; incremental indexFile calls defer
// embedding to an async chunk-embedding queue (mirrors codegraph) so a dropped
// document doesn't block the watcher on the embedding model, and transient
// embedding failures retry instead of being silently lost. Debounce is a bit
// longer than codegraph's since documents are larger and saved less often.

import chokidar from 'chokidar';
import path from 'path';
import { indexRepo, indexFile, removeFile, sweepMissing, isDocgraphAvailable, SKIP_DIRS, INDEXABLE_EXTS } from './indexer.js';
import { createChunkEmbeddingQueue } from './chunk-embedding-queue.js';
import { generateEmbedding } from '../helpers/embeddings.js';
import { isReadPathAllowed } from '../routes/paths.js';
import { markRootStarted, markRootProgress, markRootDone, markRootError } from './status.js';
import logger, { logError } from '../helpers/logger.js';

const DEBOUNCE_MS = 400;

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

/**
 * Opens chokidar and verifies startup. macOS can permit directory reads while
 * denying FSEvents/fs.watch; polling avoids that narrower denial. If polling is
 * denied too, fail with OS-level remediation instead of claiming the watcher is live.
 */
export async function openChokidarWatcher(rootPath, options, { watch = chokidar.watch } = {}) {
  try {
    const watcher = await waitUntilReady(watch(rootPath, options));
    return { watcher, mode: 'native' };
  } catch (err) {
    if (!isPermissionError(err)) throw err;
    logger.warn(`[docgraph] native watcher denied for ${rootPath}; retrying with polling`);
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
  const ext = path.extname(absPath).slice(1).toLowerCase();
  if (!INDEXABLE_EXTS.has(ext)) return false;
  for (const part of absPath.split(path.sep)) {
    if (SKIP_DIRS.has(part)) return false;
  }
  return true;
}

/**
 * Start a watcher for a single root path.
 * @param {import('events').EventEmitter} [events]  optional; emits a `change`
 *        event `{ kind: 'docgraph', root, relPath, op }` after each live
 *        index/remove (post-ready only — the initial bulk index does not fire).
 * @returns {Promise<{stop: () => Promise<void>}>}
 */
export async function startWatcher(store, rootPath, events) {
  if (!isReadPathAllowed(rootPath)) {
    throw new Error(`docgraph watcher refused: ${rootPath} not in the allowed folders`);
  }
  if (!isDocgraphAvailable(store)) {
    throw new Error(`docgraph watcher refused: backend has no document store`);
  }

  logger.info(`[docgraph] watcher: initial index of ${rootPath}`);
  markRootStarted(rootPath);

  // Async embedding queue — both the initial bulk pass and live drops defer
  // embedding here so the watcher goes live without waiting on the model, and
  // failed embeddings retry instead of being silently lost.
  const embedQueue = createChunkEmbeddingQueue({ store, generateEmbedding });

  let counts;
  try {
    const { pending: bulkPending, ...rest } = await indexRepo(store, rootPath, {
      deferEmbedding: true,
      onProgress: (counts) => markRootProgress(rootPath, counts),
    });
    if (bulkPending?.length) embedQueue.enqueueMany(bulkPending);
    counts = rest;
  } catch (err) {
    embedQueue.shutdown();
    const startupError = isPermissionError(err) ? actionablePermissionError(rootPath, err) : err;
    markRootError(rootPath, startupError);
    throw startupError;
  }
  const swept = await sweepMissing(store, rootPath);
  if (swept.removed) logger.info(`[docgraph] watcher: swept ${swept.removed} stale document rows`);
  const pending = new Map(); // relPath → timer
  const schedule = (relPath, op) => {
    clearTimeout(pending.get(relPath));
    pending.set(relPath, setTimeout(async () => {
      pending.delete(relPath);
      try {
        if (op === 'index') {
          const r = await indexFile(store, rootPath, relPath);
          if (r?.pending?.length) embedQueue.enqueueMany(r.pending);
        }
        if (op === 'remove') await removeFile(store, rootPath, relPath);
        events?.emit('change', { kind: 'docgraph', root: rootPath, relPath, op });
      } catch (err) {
        logError(`[docgraph] watcher ${op} failed`, err, { rootPath, relPath });
      }
    }, DEBOUNCE_MS));
  };

  const watcherOptions = {
    ignored: (p) => {
      if (p === rootPath) return false;
      for (const part of p.split(path.sep)) {
        if (SKIP_DIRS.has(part)) return true;
      }
      return false;
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    persistent: true,
  };

  let watcher, watchMode;
  try {
    ({ watcher, mode: watchMode } = await openChokidarWatcher(rootPath, watcherOptions));
  } catch (err) {
    embedQueue.shutdown();
    markRootError(rootPath, err);
    throw err;
  }

  watcher
    .on('add',    (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'index'); })
    .on('change', (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'index'); })
    .on('unlink', (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'remove'); })
    .on('error',  (err) => logError(`[docgraph] chokidar error`, err, { rootPath }));

  markRootDone(rootPath, counts);
  logger.info(`[docgraph] watcher: live for ${rootPath}${watchMode === 'polling' ? ' (polling fallback)' : ''}`);

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
 * Start watchers for every allowed root. Returns a stop() that shuts them down.
 * @param {import('events').EventEmitter} [events] forwarded to each startWatcher.
 */
export async function startAllWatchers(store, roots, events) {
  const { markAllDone } = await import('./status.js');
  // Drop any root nested inside another (redundant, or intentionally skipped).
  const dedupedRoots = roots.filter((r) =>
    !roots.some((other) => other !== r && r.startsWith(other + path.sep))
  );
  const handles = [];
  for (const root of dedupedRoots) {
    try {
      handles.push(await startWatcher(store, root, events));
    } catch (err) {
      logError(`[docgraph] watcher: failed to start for ${root}`, err);
    }
  }
  markAllDone();
  return {
    handles, // per-root { root, stop } handles, so the caller can register each by root
    async stop() {
      await Promise.allSettled(handles.map((h) => h.stop())).then((results) => {
        for (const r of results) {
          if (r.status === 'rejected') logError('[docgraph] watcher stop failed', r.reason);
        }
      });
    },
  };
}
