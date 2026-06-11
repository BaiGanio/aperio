// lib/docgraph/watcher.js
// chokidar-backed live updater for the document graph. One watcher per root.
// Mirrors lib/codegraph/watcher.js.
//
// Lifecycle:
//   1. On start: indexRepo(root) (full pass, sha256 short-circuits noop files)
//   2. sweepMissing(root) — drop DB rows for docs deleted while we were off
//   3. chokidar watches the tree; add/change → indexFile, unlink → removeFile
//
// Embeddings are generated inline by indexFile (document saves are far rarer
// than code edits, so we don't need codegraph's async queue here). Debounce is
// a bit longer than codegraph's since documents are larger and saved less often.

import chokidar from 'chokidar';
import path from 'path';
import { indexRepo, indexFile, removeFile, sweepMissing, isDocgraphAvailable, SKIP_DIRS, INDEXABLE_EXTS } from './indexer.js';
import { isReadPathAllowed } from '../routes/paths.js';
import { markRootStarted, markRootDone, markRootError } from './status.js';
import logger, { logError } from '../helpers/logger.js';

const DEBOUNCE_MS = 400;

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
 * @returns {Promise<{stop: () => Promise<void>}>}
 */
export async function startWatcher(store, rootPath) {
  if (!isReadPathAllowed(rootPath)) {
    throw new Error(`docgraph watcher refused: ${rootPath} not in the allowed folders`);
  }
  if (!isDocgraphAvailable(store)) {
    throw new Error(`docgraph watcher refused: backend has no document store`);
  }

  logger.info(`[docgraph] watcher: initial index of ${rootPath}`);
  markRootStarted(rootPath);
  let indexCounts;
  try {
    indexCounts = await indexRepo(store, rootPath);
  } catch (err) {
    markRootError(rootPath, err);
    throw err;
  }
  const swept = await sweepMissing(store, rootPath);
  if (swept.removed) logger.info(`[docgraph] watcher: swept ${swept.removed} stale document rows`);
  markRootDone(rootPath, indexCounts);

  const pending = new Map(); // relPath → timer
  const schedule = (relPath, op) => {
    clearTimeout(pending.get(relPath));
    pending.set(relPath, setTimeout(async () => {
      pending.delete(relPath);
      try {
        if (op === 'index') await indexFile(store, rootPath, relPath);
        if (op === 'remove') await removeFile(store, rootPath, relPath);
      } catch (err) {
        logError(`[docgraph] watcher ${op} failed`, err, { rootPath, relPath });
      }
    }, DEBOUNCE_MS));
  };

  const watcher = chokidar.watch(rootPath, {
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
  });

  watcher
    .on('add',    (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'index'); })
    .on('change', (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'index'); })
    .on('unlink', (abs) => { if (isIndexable(abs)) schedule(path.relative(rootPath, abs), 'remove'); })
    .on('error',  (err) => logError(`[docgraph] chokidar error`, err, { rootPath }));

  await new Promise((res) => watcher.once('ready', res));
  logger.info(`[docgraph] watcher: live for ${rootPath}`);

  return {
    async stop() {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      await watcher.close();
    },
  };
}

/**
 * Start watchers for every allowed root. Returns a stop() that shuts them down.
 */
export async function startAllWatchers(store, roots) {
  const { markAllDone } = await import('./status.js');
  // Drop any root nested inside another (redundant, or intentionally skipped).
  const dedupedRoots = roots.filter((r) =>
    !roots.some((other) => other !== r && r.startsWith(other + path.sep))
  );
  const handles = [];
  for (const root of dedupedRoots) {
    try {
      handles.push(await startWatcher(store, root));
    } catch (err) {
      logError(`[docgraph] watcher: failed to start for ${root}`, err);
    }
  }
  markAllDone();
  return {
    async stop() {
      await Promise.allSettled(handles.map((h) => h.stop())).then((results) => {
        for (const r of results) {
          if (r.status === 'rejected') logError('[docgraph] watcher stop failed', r.reason);
        }
      });
    },
  };
}
