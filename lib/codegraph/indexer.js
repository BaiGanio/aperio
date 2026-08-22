// lib/codegraph/indexer.js
// Dispatcher: routes to the Postgres or SQLite backend based on the store's
// shape. Real work lives in lib/codegraph/backends/{postgres,sqlite}.js.
//
// JS/TS extraction is shared (extract-ts.js). Walking the filesystem is
// shared (this file). DB writes are backend-specific.

import { readdir, stat } from 'fs/promises';
import path from 'path';
import { extract as extractTs } from './extract-ts.js';
import { extract as extractGeneric, SUPPORTED_EXTS as GENERIC_EXTS } from './extract-generic.js';
import { generateEmbedding as defaultEmbed } from '../helpers/embeddings.js';
import { gatedEmbedder } from '../helpers/vecMeta.js';
import { isReadPathAllowed, getAllowlist, loadAllowlist } from '../routes/paths.js';
import * as pgBackend     from './backends/postgres.js';
import * as sqliteBackend from './backends/sqlite.js';
import logger, { logError } from '../helpers/logger.js';

const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out',
  'coverage', '.next', '.cache', 'var', 'trash',
]);
export { JS_EXT };

function pickExtractor(file) {
  const ext = path.extname(file);
  if (JS_EXT.has(ext)) return { fn: extractTs, lang: ext.slice(1) };
  const bare = ext.slice(1).toLowerCase();
  if (GENERIC_EXTS.has(bare)) return { fn: extractGeneric, lang: bare };
  return null;
}

/**
 * Pick the backend module based on the store's shape. Postgres exposes
 * `.pool`; SQLite exposes `.db`. A backend with neither — codegraph is
 * unavailable in that case.
 */
export function pickBackend(store) {
  if (store?.pool) return { mod: pgBackend,     kind: 'postgres' };
  if (store?.db)   return { mod: sqliteBackend, kind: 'sqlite'   };
  return null;
}

/** True if the active store supports the code graph. */
export function isCodegraphAvailable(store) {
  return pickBackend(store) !== null;
}

export async function* walk(dir, root = dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // An unreadable requested root is a failed index, not an empty repository.
    // Keep skipping protected nested directories so the readable remainder of
    // a repository can still be indexed.
    if (dir === root) {
      err.message = `Cannot read code root ${root}: ${err.message}`;
      throw err;
    }
    logError(`[codegraph] walk skip ${dir}`, err);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full, root);
    } else if (entry.isFile()) {
      const ext = pickExtractor(full);
      if (!ext) continue;
      yield { abs: full, rel: path.relative(root, full), ext };
    }
  }
}

// ── Public API (dispatcher) ─────────────────────────────────────────────────

export async function indexRepo(store, rootPath, { generateEmbedding = defaultEmbed, deferEmbedding = false, onProgress } = {}) {
  if (!isReadPathAllowed(rootPath)) {
    throw new Error(
      `Refusing to index ${rootPath} — not within an allowed folder ` +
      `(currently: ${getAllowlist().join(', ')}). Add the folder in Settings and retry.`
    );
  }
  const backend = pickBackend(store);
  if (!backend) throw new Error('codegraph requires the Postgres or SQLite backend.');

  // Inline embedding (deferEmbedding=false) is an ordinary write, so it gates
  // on codegraph's vec_meta status like every other one (issue #340). Wrapping
  // the embedder rather than checking once up front keeps the check per row —
  // a repo pass can run for minutes, and a reindex starting partway through
  // would otherwise leave every symbol after that point in the wrong space.
  const counts = await backend.mod.indexRepoFiles(store, rootPath, walk(rootPath), {
    generateEmbedding: gatedEmbedder(store, 'codegraph', generateEmbedding),
    deferEmbedding, onProgress,
  });
  logger.info(
    `[codegraph/${backend.kind}] indexed ${rootPath}: ${counts.changed}/${counts.files} files, ` +
    `${counts.symbols} symbols, ${counts.edges} edges` + (counts.skipped ? ` · ${counts.skipped} skipped` : '')
  );
  return counts;
}

export async function indexFile(store, rootPath, relPath, opts = {}) {
  const backend = pickBackend(store);
  if (!backend) throw new Error('codegraph unavailable on this backend');
  const ext = pickExtractor(relPath);
  if (!ext) return { skipped: true, reason: 'unsupported extension' };
  // The watcher leaves embedInlineFn unset and drains `pending` through the
  // (separately gated) queue; a caller that does pass one gets it gated here,
  // so no route into indexOneFile can write an off-signature vector (#340).
  return backend.mod.indexOneFile(store, rootPath, relPath, ext, {
    ...opts,
    ...(opts.embedInlineFn && { embedInlineFn: gatedEmbedder(store, 'codegraph', opts.embedInlineFn) }),
  });
}

export async function removeFile(store, rootPath, relPath) {
  const backend = pickBackend(store);
  if (!backend) return { removed: false };
  return backend.mod.removeOneFile(store, rootPath, relPath);
}

export async function sweepMissing(store, rootPath) {
  const backend = pickBackend(store);
  if (!backend) return { removed: 0 };
  return backend.mod.sweepMissingFiles(store, rootPath, stat);
}

export async function setSymbolEmbedding(store, symbolId, embedding) {
  const backend = pickBackend(store);
  if (!backend) return;
  return backend.mod.setSymbolEmbedding(store, symbolId, embedding);
}

// All of rootPath's own symbols still missing a vector, regardless of
// whether this process's watcher has ever touched them. Used at watcher
// startup to backfill anything a provider/model change wiped that a plain
// re-index of unchanged files would never revisit. Scoped to rootPath so
// multiple watched roots don't each re-enqueue every other root's pending
// symbols. `page` ({ limit, offset }) is how the reindex driver walks a large
// repository in bounded pages rather than materializing every pending symbol.
export async function listPendingEmbeddings(store, rootPath, page) {
  const backend = pickBackend(store);
  if (!backend) return [];
  return backend.mod.listSymbolsWithoutEmbeddings(store, rootPath, page);
}

// Every indexed root, so the reindex driver can page through them one at a
// time (issue #287, WS1).
export async function listRepoRoots(store) {
  const backend = pickBackend(store);
  if (!backend) return [];
  return backend.mod.listRepoRoots(store);
}

// CLI entry: `node lib/codegraph/indexer.js <repo-path>`
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const { config } = await import('dotenv');
  config();
  const { getStore } = await import('../../db/index.js');
  const store = await getStore();
  await loadAllowlist(store);
  if (!isCodegraphAvailable(store)) {
    console.error(
      `codegraph requires Postgres or SQLite, but the current backend has no graph store.\n` +
      `Set DB_BACKEND=sqlite (zero-config) or DB_BACKEND=postgres and re-run.`
    );
    process.exit(2);
  }
  const root = path.resolve(process.argv[2] ?? '.');
  let exitCode = 0;
  try {
    const counts = await indexRepo(store, root);
    console.log(JSON.stringify(counts, null, 2));
  } catch (err) {
    logError(`[codegraph] CLI indexRepo failed`, err, { root });
    console.error(`\nFAILED: ${err.message}\nSee var/logs/error-*.log for the full stack trace.`);
    exitCode = 1;
  } finally {
    await store.close?.().catch(() => {});
    process.exit(exitCode);
  }
}
