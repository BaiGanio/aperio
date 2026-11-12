// src/store/import-v1.js - copy v1 memories into the v2 store, once (spec S2.12, TR3).
//
// Pure: no config, no argv, no process.env. The caller opens the store and the
// embedder. The v1 file is never opened in place: it (and its -wal / -shm) is
// copied to a temp folder, and only the copy is opened, read-only. The temp
// folder is removed on success and on failure.

import { copyFile, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { reindex } from '../embeddings/embed-reindex.js';

export class ImportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ImportError';
  }
}

const SQLITE_MAGIC = 'SQLite format 3\u0000';
const REQUIRED = ['id', 'type', 'title', 'content', 'tags', 'importance', 'source', 'created_at', 'updated_at'];
// v1-only columns: their value when absent, and the v1 default that is not worth counting.
const OPTIONAL = { valid_until: null, expires_at: null, pinned: 0, tier: 1, lang: 'english', confidence: 1 };

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/** Copy the v1 file and its sidecars. Returns the copy's path. */
async function copyV1(v1Path, dir) {
  const copy = join(dir, basename(v1Path));
  await copyFile(v1Path, copy);
  for (const suffix of ['-wal', '-shm']) {
    if (await exists(v1Path + suffix)) await copyFile(v1Path + suffix, copy + suffix);
  }
  return copy;
}

async function checkHeader(path) {
  const handle = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(16), 0, 16, 0);
    if (bytesRead === 16 && buffer.toString('latin1') === SQLITE_MAGIC) return;
  } finally {
    await handle.close();
  }
  throw new ImportError('the v1 file is not a plain SQLite file. If v1 encrypts its DB, '
    + 'turn off APERIO_DB_ENCRYPT in v1, start v1 once, then import again.');
}

/** The SELECT list: real columns, and a default for each missing v1-only column. */
function selectList(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'").all();
  if (tables.length === 0) throw new ImportError('the v1 file has no memories table.');
  const have = new Set(db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
  const missing = REQUIRED.filter((c) => !have.has(c));
  if (missing.length) throw new ImportError(`the v1 memories table has no ${missing.join(', ')} column.`);
  const optional = Object.entries(OPTIONAL).map(([c, dflt]) => {
    if (have.has(c)) return c;
    return `${dflt === null ? 'NULL' : typeof dflt === 'string' ? `'${dflt}'` : dflt} AS ${c}`;
  });
  return [...REQUIRED, ...optional].join(', ');
}

function parseTags(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text; // not JSON: the store check rejects it and names the field
  }
}

/**
 * @param {object} opts
 * @param {string} opts.v1Path
 * @param {ReturnType<import('./memory-store.js').createMemoryStore>} opts.store
 * @param {{ sig: string, embed: Function } | null} opts.embedder  null: no vectors now
 * @param {{ warn: Function, info: Function }} [opts.log]
 * @param {boolean} [opts.dryRun]
 * @param {Date} [opts.now]  test seam: "expired" is measured against it
 * @param {string} [opts.tmpRoot]  test seam: where the temp copy goes
 */
export async function importV1({ v1Path, store, embedder, log = console, dryRun = false, now = new Date(), tmpRoot = tmpdir() }) {
  if (!(await exists(v1Path))) throw new ImportError(`the v1 file was not found: ${v1Path}`);
  const dir = await mkdtemp(join(tmpRoot, 'aperio-import-v1-'));
  let v1 = null;
  try {
    const copy = await copyV1(v1Path, dir);
    await checkHeader(copy);
    try {
      v1 = new Database(copy, { readonly: true, fileMustExist: true });
      v1.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch (err) {
      throw new ImportError(`the v1 file cannot be read as SQLite: ${err.message}`, { cause: err });
    }

    const report = {
      total: 0, notCurrent: { superseded: 0, expired: 0 }, imported: 0, skipped: 0, rejected: [],
      dropped: { pinned: 0, tier: 0, lang: 0, confidence: 0, expiresAt: 0 }, embedded: 0, dryRun,
    };
    const cutoff = now.getTime();
    const source = v1.prepare(`SELECT ${selectList(v1)} FROM memories ORDER BY rowid`);

    // A generator streams rows into the store's one transaction: no full load.
    function* currentRows() {
      for (const r of source.iterate()) {
        report.total++;
        if (r.valid_until != null) { report.notCurrent.superseded++; continue; }
        if (r.expires_at != null && Date.parse(r.expires_at) <= cutoff) { report.notCurrent.expired++; continue; }
        yield {
          id: r.id, type: r.type, title: r.title, content: r.content, tags: parseTags(r.tags),
          importance: r.importance, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at, v1: r,
        };
      }
    }
    const countDropped = ({ v1: r }) => {
      if (r.pinned !== OPTIONAL.pinned) report.dropped.pinned++;
      if (r.tier !== OPTIONAL.tier) report.dropped.tier++;
      if (r.lang !== OPTIONAL.lang) report.dropped.lang++;
      if (r.confidence !== OPTIONAL.confidence) report.dropped.confidence++;
      if (r.expires_at != null) report.dropped.expiresAt++;
    };
    const checkSum = (result) => {
      const sum = result.imported + result.skipped + result.rejected.length
        + report.notCurrent.superseded + report.notCurrent.expired;
      if (sum !== report.total) throw new ImportError(`row count check failed: ${sum} accounted for, ${report.total} read. Nothing was written.`);
    };

    const result = store.importRows(currentRows(), { dryRun, beforeCommit: checkSum, onImported: countDropped });
    Object.assign(report, result);
    if (!dryRun) report.embedded = await embedImported(store, embedder, log);
    return report;
  } finally {
    v1?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run the S2.4 reindex. Many rows can fail for one cause, so the warning is said once. */
async function embedImported(store, embedder, log) {
  if (!embedder) {
    log.warn('[import] no embedder: the rows are saved with no vector. The next reindex fills them.');
    return 0;
  }
  let firstError = null;
  const counting = { warn: (m) => { firstError ??= m; }, info: () => {} };
  const { done, failed } = await reindex(store, embedder, { log: counting });
  if (failed > 0) {
    log.warn(`[import] ${failed} row(s) could not be embedded; they are saved with no vector and the next reindex fills them. First error: ${firstError}`);
  }
  return done;
}

/** The report as plain text, for the CLI. */
export function formatReport(report) {
  const lines = [
    report.dryRun ? 'Dry run: nothing was written.' : 'Import done.',
    `  v1 rows read   ${report.total}`,
    `  imported       ${report.imported}`,
    `  skipped        ${report.skipped}   (id already in v2)`,
    `  rejected       ${report.rejected.length}`,
    `  superseded     ${report.notCurrent.superseded}   (not imported: replaced in v1)`,
    `  expired        ${report.notCurrent.expired}   (not imported: past expires_at)`,
    `  embedded       ${report.embedded}`,
    `  dropped v1 values: pinned ${report.dropped.pinned}, tier ${report.dropped.tier}, lang ${report.dropped.lang}, `
      + `confidence ${report.dropped.confidence}, expires_at ${report.dropped.expiresAt}`,
  ];
  if (report.rejected.length) {
    lines.push('', 'Rejected rows (fix in v1, then run again):');
    for (const r of report.rejected) lines.push(`  ${r.id}  ${r.field}: ${r.why}`);
  }
  return lines.join('\n');
}
