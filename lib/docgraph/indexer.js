// lib/docgraph/indexer.js
// Dispatcher for the document graph. Mirrors lib/codegraph/indexer.js: walking
// the filesystem is shared here, DB writes are backend-specific. Only the
// SQLite backend exists in this milestone (Postgres parity is Phase 6).
//
// docgraph indexes human content (Markdown/text in Phase 1–2), explicitly NOT
// code — code files belong to codegraph. The skip list is therefore narrower
// than codegraph's; the extension filter is the real gate.

import { readdir, stat } from 'fs/promises';
import path from 'path';
import { extract as extractMd } from './extract-md.js';
import { extract as extractHtml } from './extract-html.js';
import { extract as extractPdf } from './extract-pdf.js';
import { extract as extractDocx } from './extract-docx.js';
import { extract as extractXlsx } from './extract-xlsx.js';
import { extract as extractPptx } from './extract-pptx.js';
import { extract as extractEml } from './extract-eml.js';
import { generateEmbedding as defaultEmbed } from '../helpers/embeddings.js';
import { isReadPathAllowed, getAllowlist } from '../routes/paths.js';
import * as sqliteBackend from './backends/sqlite.js';
import * as pgBackend from './backends/postgres.js';
import logger, { logError } from '../helpers/logger.js';

export const SKIP_DIRS = new Set(['.git', 'node_modules', 'trash', 'var', 'coverage']);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// extension → { mime, extract }. The single source of truth for what docgraph
// indexes.
const EXTRACTORS = {
  md:       { mime: 'text/markdown', extract: extractMd },
  mdx:      { mime: 'text/markdown', extract: extractMd },
  markdown: { mime: 'text/markdown', extract: extractMd },
  rst:      { mime: 'text/x-rst',    extract: extractMd },
  txt:      { mime: 'text/plain',    extract: extractMd },
  text:     { mime: 'text/plain',    extract: extractMd },
  html:     { mime: 'text/html',     extract: extractHtml },
  htm:      { mime: 'text/html',     extract: extractHtml },
  pdf:      { mime: 'application/pdf', extract: extractPdf },
  docx:     { mime: DOCX_MIME,         extract: extractDocx },
  xlsx:     { mime: XLSX_MIME,         extract: extractXlsx },
  pptx:     { mime: PPTX_MIME,         extract: extractPptx },
  eml:      { mime: 'message/rfc822',  extract: extractEml },
};

// Extensions docgraph can index — used by the watcher to filter fs events.
export const INDEXABLE_EXTS = new Set(Object.keys(EXTRACTORS));

function pickExtractor(file) {
  const bare = path.extname(file).slice(1).toLowerCase();
  return EXTRACTORS[bare] ?? null;
}

export function pickBackend(store) {
  if (store?.pool) return { mod: pgBackend,     kind: 'postgres' };
  if (store?.db)   return { mod: sqliteBackend, kind: 'sqlite' };
  return null;
}

export function isDocgraphAvailable(store) {
  return pickBackend(store) !== null;
}

async function* walk(dir, root = dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    logError(`[docgraph] walk skip ${dir}`, err);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full, root);
    } else if (entry.isFile()) {
      const picked = pickExtractor(full);
      if (!picked) continue;
      yield { abs: full, rel: path.relative(root, full), mime: picked.mime, extract: picked.extract };
    }
  }
}

// ── Public API (dispatcher) ──────────────────────────────────────────────────

// deferEmbedding=true skips inline embedding and returns the chunks as `pending`
// for the caller (the watcher) to drain through the async chunk-embedding queue.
// The CLI / one-shot callers leave it false so embeddings are written before exit.
export async function indexRepo(store, rootPath, { generateEmbedding = defaultEmbed, deferEmbedding = false } = {}) {
  if (!isReadPathAllowed(rootPath)) {
    throw new Error(
      `Refusing to index ${rootPath} — not within an allowed folder ` +
      `(currently: ${getAllowlist().join(', ')}). Add the folder in Settings and retry.`
    );
  }
  const backend = pickBackend(store);
  if (!backend) throw new Error('docgraph requires the Postgres or SQLite backend.');

  const counts = await backend.mod.indexRepoFiles(store, rootPath, walk(rootPath), { generateEmbedding, deferEmbedding });
  logger.info(
    `[docgraph/${backend.kind}] indexed ${rootPath}: ${counts.changed}/${counts.docs} docs, ` +
    `${counts.sections} sections, ${counts.chunks} chunks` + (counts.skipped ? ` · ${counts.skipped} skipped` : '')
  );
  return counts;
}

export async function deleteRepo(store, rootPath) {
  const backend = pickBackend(store);
  if (!backend) return { deleted: false };
  return backend.mod.deleteRepo(store, rootPath);
}

// Incremental, single-document operations used by the watcher. Embedding is
// NOT done inline here — indexOneFile returns the `pending` chunks and the
// watcher feeds them to the async chunk-embedding queue. Pass `embedInlineFn`
// in opts only when a caller needs embeddings written synchronously.
export async function indexFile(store, rootPath, relPath, opts = {}) {
  const backend = pickBackend(store);
  if (!backend) return { skipped: true, reason: 'no backend' };
  const picked = pickExtractor(relPath);
  if (!picked) return { skipped: true, reason: 'unsupported extension' };
  return backend.mod.indexOneFile(store, rootPath, relPath, { mime: picked.mime, extract: picked.extract, ...opts });
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

// Write a single chunk's embedding. Used by the async chunk-embedding queue
// to backfill vectors for chunks indexed without inline embedding.
export async function setChunkEmbedding(store, chunkId, embedding) {
  const backend = pickBackend(store);
  if (!backend) return;
  return backend.mod.setChunkEmbedding(store, chunkId, embedding);
}

// CLI entry: `node lib/docgraph/indexer.js <folder-path>`
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const { config } = await import('dotenv');
  config();
  const { getStore } = await import('../../db/index.js');
  const store = await getStore();
  if (!isDocgraphAvailable(store)) {
    console.error(
      `docgraph requires Postgres or SQLite, but the current store has neither handle.\n` +
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
    logError(`[docgraph] CLI indexRepo failed`, err, { root });
    console.error(`\nFAILED: ${err.message}\nSee var/logs/error-*.log for the full stack trace.`);
    exitCode = 1;
  } finally {
    await store.close?.().catch(() => {});
    process.exit(exitCode);
  }
}
