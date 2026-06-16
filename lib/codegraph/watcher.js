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
import { indexRepo, indexFile, removeFile, sweepMissing, isCodegraphAvailable, SKIP_DIRS, JS_EXT } from './indexer.js';
import { createSymbolEmbeddingQueue } from './symbol-embedding-queue.js';
import { generateEmbedding } from '../helpers/embeddings.js';
import { isReadPathAllowed } from '../routes/paths.js';
import { markRootStarted, markRootDone, markRootError } from './status.js';
import logger, { logError } from '../helpers/logger.js';

const DEBOUNCE_MS = 250;

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
export async function startWatcher(store, rootPath, events) {
  if (!isReadPathAllowed(rootPath)) {
    throw new Error(`codegraph watcher refused: ${rootPath} not in APERIO_ALLOWED_PATHS_TO_READ`);
  }
  if (!isCodegraphAvailable(store)) {
    throw new Error(`codegraph watcher refused: backend has no graph store`);
  }

  logger.info(`[codegraph] watcher: initial index of ${rootPath}`);
  markRootStarted(rootPath);
  let indexCounts;
  try {
    indexCounts = await indexRepo(store, rootPath);
  } catch (err) {
    markRootError(rootPath, err);
    throw err;
  }
  const swept = await sweepMissing(store, rootPath);
  if (swept.removed) logger.info(`[codegraph] watcher: swept ${swept.removed} stale file rows`);
  markRootDone(rootPath, indexCounts);

  // Async embedding queue — keeps editor saves off the embedding model's latency.
  const embedQueue = createSymbolEmbeddingQueue({ store, generateEmbedding });

  const pending = new Map();   // relPath → timer
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
        events?.emit('change', { kind: 'codegraph', root: rootPath, relPath, op });
      } catch (err) {
        logError(`[codegraph] watcher ${op} failed`, err, { rootPath, relPath });
      }
    }, DEBOUNCE_MS));
  };

  const watcher = chokidar.watch(rootPath, {
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
  });

  watcher
    .on('add',    (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'index'); })
    .on('change', (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'index'); })
    .on('unlink', (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'remove'); })
    .on('error',  (err) => logError(`[codegraph] chokidar error`, err, { rootPath }));

  await new Promise(res => watcher.once('ready', res));
  logger.info(`[codegraph] watcher: live for ${rootPath}`);

  return {
    async stop() {
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
