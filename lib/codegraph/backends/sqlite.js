// lib/codegraph/backends/sqlite.js
// SQLite backend for codegraph. Parallel to backends/postgres.js — same
// exported functions, different dialect (better-sqlite3 sync + sqlite-vec
// + FTS5 instead of pg pool + pgvector + tsvector/GIN).
//
// Notes:
//   • better-sqlite3 is synchronous. We wrap calls in async functions to keep
//     the dispatcher uniform with the Postgres backend.
//   • vec0 wants rowid as BigInt — every numeric id passed to vec_cg_symbols
//     goes through BigInt(...) (same fix as db/sqlite.js).
//   • FTS5 BM25 returns more-negative = better; we negate so larger = better
//     and the RRF math stays uniform with Postgres.

import { readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { logError } from '../../helpers/logger.js';
import { evictRepo } from '../graphCache.js';
import {
  INDEX_SCHEMA_VERSION, FILE_SYMBOL_KIND, FILE_SRC_TOKEN,
  CONFIDENCE, SCORE, relationContextFor, resolveImportTarget,
} from '../resolve.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const vecBuf = (e) => Float32Array.from(e);

// ── Schema bootstrap ────────────────────────────────────────────────────────
// SqliteStore.init() applies db/migrations-sqlite/*.sql — including 003 —
// automatically, so callers don't need to do anything extra.

// ── Indexer primitives ───────────────────────────────────────────────────────

function upsertRepoSync(db, rootPath) {
  const existing = db.prepare(`SELECT id FROM cg_repos WHERE root_path = ?`).get(rootPath);
  if (existing) return existing.id;
  const info = db.prepare(`INSERT INTO cg_repos (root_path) VALUES (?)`).run(rootPath);
  return Number(info.lastInsertRowid);
}

function upsertFileSync(db, repoId, relPath, lang, hash, mtime, forceRebuild = false) {
  const existing = db.prepare(
    `SELECT id, sha256 FROM cg_files WHERE repo_id = ? AND path = ?`
  ).get(repoId, relPath);
  if (existing?.sha256 === hash && !forceRebuild) {
    return { fileId: existing.id, changed: false };
  }
  if (existing) {
    db.prepare(`UPDATE cg_files SET language = ?, sha256 = ?, mtime = ? WHERE id = ?`)
      .run(lang, hash, mtime.toISOString(), existing.id);
    return { fileId: existing.id, changed: true };
  }
  const info = db.prepare(
    `INSERT INTO cg_files (repo_id, path, language, sha256, mtime) VALUES (?, ?, ?, ?, ?)`
  ).run(repoId, relPath, lang, hash, mtime.toISOString());
  return { fileId: Number(info.lastInsertRowid), changed: true };
}

function reindexFileSync(db, fileId, relPath, symbols, edges) {
  db.prepare(`DELETE FROM cg_symbols WHERE file_id = ?`).run(fileId);

  const insSym = db.prepare(
    `INSERT INTO cg_symbols (file_id, kind, name, qualified, start_line, end_line, signature, doc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insEdge = db.prepare(
    `INSERT INTO cg_edges
       (src_symbol_id, dst_symbol_id, dst_unresolved, kind, src_line,
        confidence, confidence_score, provenance, relation_context)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`
  );

  const localToDb = new Map();
  const pending = [];

  // Synthetic file node: one per file, `__file__` edges (imports) hang off it.
  const fileInfo = insSym.run(
    fileId, FILE_SYMBOL_KIND, path.basename(relPath), relPath, 1, 1, null, null
  );
  localToDb.set(FILE_SRC_TOKEN, Number(fileInfo.lastInsertRowid));

  for (const s of symbols) {
    const info = insSym.run(
      fileId, s.kind, s.name, s.qualified,
      s.start_line, s.end_line, s.signature ?? null, s.doc ?? null
    );
    const id = Number(info.lastInsertRowid);
    localToDb.set(s.localId, id);
    pending.push({ id, text: [s.name, s.signature, s.doc].filter(Boolean).join('. ') });
  }
  for (const e of edges) {
    const src = localToDb.get(e.srcLocalId);
    if (!src) continue;
    // Every extractor edge is a direct syntax fact: EXTRACTED / 1.0. The resolver
    // reclassifies rows it resolves by name/path to INFERRED / 0.8.
    insEdge.run(
      src, e.dst_unresolved ?? null, e.kind, e.src_line ?? null,
      CONFIDENCE.EXTRACTED, SCORE.EXTRACTED, 'extract',
      e.relation_context ?? relationContextFor(e.kind)
    );
  }
  // +1 for the synthetic file symbol.
  return { symbolCount: symbols.length + 1, edgeCount: edges.length, pending };
}

async function embedInline(db, pending, generateEmbedding) {
  for (const { id, text } of pending) {
    const vec = await generateEmbedding(text, 'document').catch(() => null);
    if (!vec) continue;
    db.prepare(`DELETE FROM vec_cg_symbols WHERE rowid = ?`).run(BigInt(id));
    db.prepare(`INSERT INTO vec_cg_symbols (rowid, embedding) VALUES (?, ?)`)
      .run(BigInt(id), vecBuf(vec));
  }
}

// SQLite name-based edge resolver. Mirrors the Postgres CTE — promotes
// dst_unresolved → dst_symbol_id only when the name is unambiguous in the
// same repo. A resolved row is a name inference: INFERRED / 0.8.
function resolveEdgesSync(db, repoId) {
  db.exec(`
    UPDATE cg_edges
       SET dst_symbol_id = (
             SELECT s.id FROM cg_symbols s
             JOIN cg_files df ON df.id = s.file_id
             WHERE s.name = cg_edges.dst_unresolved AND df.repo_id = ${repoId}
               AND s.kind <> '${FILE_SYMBOL_KIND}'
           ),
           dst_unresolved = NULL,
           confidence = '${CONFIDENCE.INFERRED}',
           confidence_score = ${SCORE.INFERRED},
           provenance = 'name-resolver'
     WHERE id IN (
       SELECT e.id
         FROM cg_edges e
         JOIN cg_symbols src ON src.id = e.src_symbol_id
         JOIN cg_files   sf  ON sf.id  = src.file_id
        WHERE sf.repo_id = ${repoId}
          AND e.dst_symbol_id IS NULL
          AND e.dst_unresolved IS NOT NULL
          AND e.kind IN ('calls','extends','references')
          AND (
            SELECT COUNT(*) FROM cg_symbols s
            JOIN cg_files df ON df.id = s.file_id
            WHERE s.name = e.dst_unresolved AND df.repo_id = ${repoId}
              AND s.kind <> '${FILE_SYMBOL_KIND}'
          ) = 1
     )
  `);
  resolveImportsSync(db, repoId);
}

// Resolve relative `imports` edges (from a file node) to the target file's
// synthetic file symbol. Path inference → INFERRED / 0.8. Self-imports and
// unresolved specifiers are left alone (no fabricated destination).
function resolveImportsSync(db, repoId) {
  const files = db.prepare(
    `SELECT path FROM cg_files WHERE repo_id = ?`
  ).all(repoId).map(r => r.path);
  if (!files.length) return;
  const filePathSet = new Set(files);
  // path → the file's synthetic file-symbol id.
  const fileSymbolByPath = new Map(
    db.prepare(
      `SELECT f.path AS path, s.id AS id
         FROM cg_symbols s
         JOIN cg_files f ON f.id = s.file_id
        WHERE f.repo_id = ? AND s.kind = ?`
    ).all(repoId, FILE_SYMBOL_KIND).map(r => [r.path, r.id])
  );

  const pendingImports = db.prepare(
    `SELECT e.id AS edge_id, f.path AS importer, e.dst_unresolved AS spec
       FROM cg_edges e
       JOIN cg_symbols src ON src.id = e.src_symbol_id
       JOIN cg_files   f   ON f.id   = src.file_id
      WHERE f.repo_id = ? AND e.kind = 'imports'
        AND e.dst_symbol_id IS NULL AND e.dst_unresolved IS NOT NULL`
  ).all(repoId);

  const upd = db.prepare(
    `UPDATE cg_edges
        SET dst_symbol_id = ?, dst_unresolved = NULL,
            confidence = '${CONFIDENCE.INFERRED}', confidence_score = ${SCORE.INFERRED},
            provenance = 'import-resolver'
      WHERE id = ?`
  );
  for (const { edge_id, importer, spec } of pendingImports) {
    const target = resolveImportTarget(importer, spec, filePathSet);
    if (!target || target === importer) continue; // no fabrication, no self-cycle
    const dstId = fileSymbolByPath.get(target);
    if (!dstId) continue;
    upd.run(dstId, edge_id);
  }
}

// Increment the repo's graph revision once per successful graph-changing op.
function bumpRevisionSync(db, repoId) {
  db.prepare(`UPDATE cg_repos SET graph_revision = graph_revision + 1 WHERE id = ?`).run(repoId);
}

// ── Public indexer API ──────────────────────────────────────────────────────

export async function indexRepoFiles(store, rootPath, fileIterator, { generateEmbedding, deferEmbedding = false, onProgress } = {}) {
  const db = store.db;
  const counts = { files: 0, changed: 0, symbols: 0, edges: 0, skipped: 0 };
  const pending = []; // collected for the caller's queue when deferEmbedding
  const repoId = upsertRepoSync(db, rootPath);
  // A schema-version bump forces a full rebuild so old graphs gain file/import
  // nodes despite unchanged file hashes.
  const storedVer = db.prepare(`SELECT index_schema_version AS v FROM cg_repos WHERE id = ?`).get(repoId)?.v ?? 0;
  const forceRebuild = storedVer < INDEX_SCHEMA_VERSION;

  // Per-file try/catch so one bad file doesn't kill the whole repo. We don't
  // wrap the whole repo in a single transaction here because async embedding
  // calls can interleave with a long-lived tx; instead each file's writes are
  // their own implicit transaction (better-sqlite3 batches each prepare/run).
  for await (const { abs, rel, ext } of fileIterator) {
    try {
      const buf  = await readFile(abs);
      const hash = sha256(buf);
      const st   = await stat(abs);
      const { fileId, changed } = upsertFileSync(db, repoId, rel, ext.lang, hash, st.mtime, forceRebuild);
      counts.files++;
      // Throttled live progress so the UI shows movement during a long root.
      if (onProgress && counts.files % 20 === 0) onProgress({ ...counts });
      if (!changed) continue;

      const parsed = await ext.fn(buf.toString('utf8'), rel);
      const result = reindexFileSync(db, fileId, rel, parsed.symbols, parsed.edges);
      if (deferEmbedding) for (const p of result.pending) pending.push(p);
      else await embedInline(db, result.pending, generateEmbedding);
      counts.changed++;
      counts.symbols += result.symbolCount;
      counts.edges   += result.edgeCount;
    } catch (err) {
      counts.skipped++;
      logError(`[codegraph/sqlite] indexRepo: skipped ${rel}`, err, { repo: rootPath });
    }
  }
  resolveEdgesSync(db, repoId);
  // A folder with zero indexable code files (e.g. a documents-only folder) would
  // otherwise leave an empty repo row that clutters the Code Graph panel — drop it.
  const fileCount = db.prepare(`SELECT COUNT(*) AS n FROM cg_files WHERE repo_id = ?`).get(repoId).n;
  if (fileCount === 0) {
    db.prepare(`DELETE FROM cg_repos WHERE id = ?`).run(repoId);
    return { ...counts, pending: [] };
  }
  db.prepare(`UPDATE cg_repos SET last_indexed_at = ?, index_schema_version = ? WHERE id = ?`)
    .run(new Date().toISOString(), INDEX_SCHEMA_VERSION, repoId);
  // One revision bump per successful graph-changing index (skip pure no-ops).
  if (counts.changed > 0) bumpRevisionSync(db, repoId);
  return { ...counts, pending };
}

export async function indexOneFile(store, rootPath, relPath, ext, { embedInlineFn = null } = {}) {
  const db = store.db;
  const abs = path.join(rootPath, relPath);
  let buf, st;
  try { buf = await readFile(abs); st = await stat(abs); }
  catch { return { skipped: true, reason: 'file gone' }; }
  const hash = sha256(buf);

  const repoId = upsertRepoSync(db, rootPath);
  const { fileId, changed } = upsertFileSync(db, repoId, relPath, ext.lang, hash, st.mtime);
  if (!changed) return { skipped: true, reason: 'unchanged' };

  const parsed = await ext.fn(buf.toString('utf8'), relPath);
  const result = reindexFileSync(db, fileId, relPath, parsed.symbols, parsed.edges);
  if (embedInlineFn) await embedInline(db, result.pending, embedInlineFn);
  resolveEdgesSync(db, repoId);
  bumpRevisionSync(db, repoId);
  return { skipped: false, ...result };
}

export async function removeOneFile(store, rootPath, relPath) {
  const db = store.db;
  const row = db.prepare(`SELECT id FROM cg_repos WHERE root_path = ?`).get(rootPath);
  if (!row) return { removed: false };
  const info = db.prepare(`DELETE FROM cg_files WHERE repo_id = ? AND path = ?`).run(row.id, relPath);
  if (info.changes > 0) bumpRevisionSync(db, row.id);
  return { removed: info.changes > 0 };
}

export async function sweepMissingFiles(store, rootPath, statFn) {
  const db = store.db;
  const row = db.prepare(`SELECT id FROM cg_repos WHERE root_path = ?`).get(rootPath);
  if (!row) return { removed: 0 };
  const files = db.prepare(`SELECT path FROM cg_files WHERE repo_id = ?`).all(row.id);
  const gone = [];
  for (const f of files) {
    try { await statFn(path.join(rootPath, f.path)); }
    catch { gone.push(f.path); }
  }
  if (gone.length) {
    const placeholders = gone.map(() => '?').join(',');
    db.prepare(`DELETE FROM cg_files WHERE repo_id = ? AND path IN (${placeholders})`)
      .run(row.id, ...gone);
    bumpRevisionSync(db, row.id);
  }
  return { removed: gone.length };
}

export async function setSymbolEmbedding(store, symbolId, embedding) {
  const db = store.db;
  db.prepare(`DELETE FROM vec_cg_symbols WHERE rowid = ?`).run(BigInt(symbolId));
  db.prepare(`INSERT INTO vec_cg_symbols (rowid, embedding) VALUES (?, ?)`)
    .run(BigInt(symbolId), vecBuf(embedding));
}

// ── Read-side query API ──────────────────────────────────────────────────────

// Every result that carries a repo-relative `path` also carries the repo it
// belongs to: a friendly `repo` name (root_path basename, also a valid `repo`
// filter substring) and the absolute `root_path` so callers can build a full
// path. Without this, relative paths are ambiguous across repos that share a
// directory layout (e.g. multiple repos with a lib/ folder).
const withRepo = (row) => row && { ...row, repo: path.basename(row.root_path) };

function resolveRepoIdSync(db, repo) {
  if (!repo) return null;
  // Prefer exact match so a full root_path never collides with a longer sibling.
  const exact = db.prepare(`SELECT id, root_path FROM cg_repos WHERE root_path = ?`).all(repo);
  if (exact.length === 1) return exact[0].id;
  const rows = db.prepare(
    `SELECT id, root_path FROM cg_repos WHERE root_path LIKE '%' || ? || '%' ORDER BY root_path`
  ).all(repo);
  if (rows.length === 0) { const e = new Error(`No indexed repo matches '${repo}'.`); e.userFacing = true; throw e; }
  if (rows.length > 1)   { const e = new Error(`Ambiguous repo '${repo}' — matches: ${rows.map(r => r.root_path).join(', ')}`); e.userFacing = true; throw e; }
  return rows[0].id;
}

// FTS5 interprets bare `-term` as NOT, which causes "no such column" errors when
// the term happens to match no column name. Sanitize by splitting on non-word chars
// and rejoining as plain tokens so the query is always valid FTS5.
function safeFtsQuery(q) {
  const tokens = q.split(/[\s\-\/\\.,;:()\[\]{}'"!?@#$%^&*+=<>|~`]+/).filter(Boolean);
  return tokens.length ? tokens.join(' ') : q;
}

export async function search(store, { query, kind, repo, limit = 20 }, { generateEmbedding, vectorEnabled }) {
  const db = store.db;
  const repoId = resolveRepoIdSync(db, repo);
  const useVector = vectorEnabled?.() ?? false;
  const queryVec  = useVector ? await generateEmbedding?.(query, 'query').catch(() => null) : null;
  const ftsQuery  = safeFtsQuery(query);

  // ── FTS-only path ──────────────────────────────────────────────────────────
  if (!queryVec) {
    const params = { q: ftsQuery, cap: limit };
    const conds = [`cg_symbols_fts MATCH @q`];
    if (kind)   { conds.push(`s.kind = @kind`);     params.kind = kind; }
    if (repoId) { conds.push(`f.repo_id = @repo`);  params.repo = repoId; }
    const rows = db.prepare(`
      SELECT s.qualified, s.kind, s.name, s.signature, s.start_line, s.end_line, f.path, r.root_path,
             (-cg_symbols_fts.rank) AS score
        FROM cg_symbols_fts
        JOIN cg_symbols s ON s.id = cg_symbols_fts.rowid
        JOIN cg_files   f ON f.id = s.file_id
        JOIN cg_repos   r ON r.id = f.repo_id
       WHERE ${conds.join(' AND ')}
       ORDER BY score DESC
       LIMIT @cap
    `).all(params);
    return { matches: rows.map(withRepo), mode: 'fulltext' };
  }

  // ── Hybrid path (RRF) — note vec0 MATCH must be a top-level WHERE clause,
  // so we run vector + FTS as separate prepared statements and fuse in JS.
  // SQLite CTE+vec0 composition is fragile in current sqlite-vec versions.
  const vec = vecBuf(queryVec);
  const vecConds = [`vec_cg_symbols.embedding MATCH @vec`, `k = 60`];
  const ftsConds = [`cg_symbols_fts MATCH @q`];
  const params   = { vec, q: ftsQuery };
  if (kind)   { vecConds.push(`s.kind = @kind`);    ftsConds.push(`s.kind = @kind`);    params.kind = kind; }
  if (repoId) { vecConds.push(`f.repo_id = @repo`); ftsConds.push(`f.repo_id = @repo`); params.repo = repoId; }

  const vecRows = db.prepare(`
    SELECT s.id FROM vec_cg_symbols
      JOIN cg_symbols s ON s.id = vec_cg_symbols.rowid
      JOIN cg_files   f ON f.id = s.file_id
     WHERE ${vecConds.join(' AND ')}
     ORDER BY vec_cg_symbols.distance
     LIMIT 60
  `).all(params);
  const ftsRows = db.prepare(`
    SELECT s.id FROM cg_symbols_fts
      JOIN cg_symbols s ON s.id = cg_symbols_fts.rowid
      JOIN cg_files   f ON f.id = s.file_id
     WHERE ${ftsConds.join(' AND ')}
     ORDER BY cg_symbols_fts.rank
     LIMIT 60
  `).all(params);

  const rrf = new Map();
  vecRows.forEach((r, i) => rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1.0 / (60 + i + 1)));
  ftsRows.forEach((r, i) => rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1.0 / (60 + i + 1)));

  if (rrf.size === 0) return { matches: [], mode: 'hybrid' };

  const ids = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const idList = ids.map(([id]) => id);
  const placeholders = idList.map(() => '?').join(',');
  const detail = db.prepare(`
    SELECT s.id, s.qualified, s.kind, s.name, s.signature, s.start_line, s.end_line, f.path, r.root_path
      FROM cg_symbols s JOIN cg_files f ON f.id = s.file_id JOIN cg_repos r ON r.id = f.repo_id
     WHERE s.id IN (${placeholders})
  `).all(...idList);
  const byId = new Map(detail.map(r => [r.id, r]));
  const matches = ids.map(([id, score]) => ({ ...withRepo(byId.get(id)), score }));
  return { matches, mode: 'hybrid' };
}

export async function outline(store, { path: filePath, repo }) {
  const repoId = resolveRepoIdSync(store.db, repo);
  const rows = store.db.prepare(`
    SELECT s.kind, s.name, s.qualified, s.start_line, s.end_line, s.signature, r.root_path
      FROM cg_symbols s
      JOIN cg_files   f ON f.id = s.file_id
      JOIN cg_repos   r ON r.id = f.repo_id
     WHERE f.path = ? ${repoId ? 'AND f.repo_id = ?' : ''} ORDER BY r.root_path, s.start_line
  `).all(...(repoId ? [filePath, repoId] : [filePath]));
  return { path: filePath, symbols: rows.map(withRepo) };
}

export async function context(store, { qualified, repo }) {
  const repoId = resolveRepoIdSync(store.db, repo);
  const row = store.db.prepare(`
    SELECT s.qualified, s.start_line, s.end_line, s.signature, s.doc, s.kind, s.name,
           f.path, r.root_path
      FROM cg_symbols s
      JOIN cg_files   f ON f.id = s.file_id
      JOIN cg_repos   r ON r.id = f.repo_id
     WHERE s.qualified = ? ${repoId ? 'AND f.repo_id = ?' : ''} LIMIT 1
  `).get(...(repoId ? [qualified, repoId] : [qualified]));
  return row ?? null;
}

export async function repos(store) {
  const rows = store.db.prepare(`
    SELECT r.id, r.root_path, r.last_indexed_at,
           COUNT(DISTINCT f.id) AS files,
           COUNT(s.id)          AS symbols
      FROM cg_repos r
      LEFT JOIN cg_files   f ON f.repo_id = r.id
      LEFT JOIN cg_symbols s ON s.file_id  = f.id
     GROUP BY r.id ORDER BY r.last_indexed_at IS NULL, r.last_indexed_at DESC
  `).all();
  return { repos: rows };
}

async function walkEdges(db, qualified, depth, direction, repoId) {
  const target = db.prepare(
    `SELECT s.id FROM cg_symbols s JOIN cg_files f ON f.id = s.file_id
      WHERE s.qualified = ? ${repoId ? 'AND f.repo_id = ?' : ''} LIMIT 1`
  ).get(...(repoId ? [qualified, repoId] : [qualified]));
  if (!target) return null;
  const seen = new Set([target.id]);
  let frontier = [target.id];
  const out = [];

  for (let hop = 1; hop <= depth; hop++) {
    if (!frontier.length) break;
    const placeholders = frontier.map(() => '?').join(',');
    const rows = direction === 'callers'
      ? db.prepare(`
          SELECT e.src_symbol_id AS id, s.qualified, s.kind, s.name, f.path, r.root_path, e.src_line
            FROM cg_edges e
            JOIN cg_symbols s ON s.id = e.src_symbol_id
            JOIN cg_files   f ON f.id = s.file_id
            JOIN cg_repos   r ON r.id = f.repo_id
           WHERE e.kind = 'calls' AND e.dst_symbol_id IN (${placeholders})
        `).all(...frontier)
      : db.prepare(`
          SELECT e.dst_symbol_id AS id, s.qualified, s.kind, s.name, f.path, r.root_path, e.src_line
            FROM cg_edges e
            JOIN cg_symbols s ON s.id = e.dst_symbol_id
            JOIN cg_files   f ON f.id = s.file_id
            JOIN cg_repos   r ON r.id = f.repo_id
           WHERE e.kind = 'calls' AND e.src_symbol_id IN (${placeholders}) AND e.dst_symbol_id IS NOT NULL
        `).all(...frontier);
    const next = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      next.push(r.id);
      out.push(withRepo({ hop, qualified: r.qualified, kind: r.kind, name: r.name, path: r.path, root_path: r.root_path, line: r.src_line }));
    }
    frontier = next;
  }
  return out;
}

export async function callers(store, { qualified, depth = 1, repo }) {
  const repoId = resolveRepoIdSync(store.db, repo);
  return walkEdges(store.db, qualified, Math.min(Math.max(depth, 1), 5), 'callers', repoId);
}
export async function callees(store, { qualified, depth = 1, repo }) {
  const repoId = resolveRepoIdSync(store.db, repo);
  return walkEdges(store.db, qualified, Math.min(Math.max(depth, 1), 5), 'callees', repoId);
}

export async function deleteRepo(store, rootPath) {
  const db = store.db;
  const row = db.prepare(`SELECT id FROM cg_repos WHERE root_path = ?`).get(rootPath);
  const info = db.prepare(`DELETE FROM cg_repos WHERE root_path = ?`).run(rootPath);
  const deleted = info.changes > 0;
  if (deleted && row) evictRepo(store, row.id);
  return { deleted };
}

// ── Graph-intelligence read API (issue #283) ────────────────────────────────

// Resolve a `repo` substring/exact match to a repo id (throws userFacing on
// ambiguous/none). Exposed for the shared traversal + analysis layer.
export async function resolveRepoId(store, repo) {
  return resolveRepoIdSync(store.db, repo);
}

// Distinct repo ids that contain a symbol with this qualified name.
export async function findReposForSymbol(store, qualified) {
  return store.db.prepare(
    `SELECT DISTINCT f.repo_id AS id
       FROM cg_symbols s JOIN cg_files f ON f.id = s.file_id
      WHERE s.qualified = ?`
  ).all(qualified).map(r => r.id);
}

// Load one repository's resolved directed graph: every symbol node plus every
// resolved edge. Unresolved edges (dst NULL) are omitted — traversal/analysis
// only reason over known destinations.
export async function loadGraph(store, repoId) {
  const db = store.db;
  const nodes = db.prepare(
    `SELECT s.id, s.qualified, s.kind, s.name, f.path, r.root_path
       FROM cg_symbols s
       JOIN cg_files f ON f.id = s.file_id
       JOIN cg_repos r ON r.id = f.repo_id
      WHERE f.repo_id = ?`
  ).all(repoId).map(n => ({ ...n, repo: path.basename(n.root_path) }));
  const edges = db.prepare(
    `SELECT e.src_symbol_id AS src, e.dst_symbol_id AS dst, e.kind,
            e.confidence, e.confidence_score, e.relation_context
       FROM cg_edges e
       JOIN cg_symbols s ON s.id = e.src_symbol_id
       JOIN cg_files   f ON f.id = s.file_id
      WHERE f.repo_id = ? AND e.dst_symbol_id IS NOT NULL`
  ).all(repoId);
  return { nodes, edges };
}

// ── Analysis snapshot persistence (issue #283 step 4) ───────────────────────

export async function readRevisions(store, repoId) {
  return store.db.prepare(
    `SELECT graph_revision, analyzed_revision, analyzed_at FROM cg_repos WHERE id = ?`
  ).get(repoId) ?? null;
}

// Persist a community/metric snapshot — but only if the repo's graph revision
// still matches the one the analysis was computed against (compare-before-commit).
// Returns true when committed, false when a newer revision won the race.
export async function persistAnalysis(store, repoId, revision, { communities, metrics }) {
  const db = store.db;
  const tx = db.transaction(() => {
    const cur = db.prepare(`SELECT graph_revision AS r FROM cg_repos WHERE id = ?`).get(repoId);
    if (!cur || cur.r !== revision) return false; // stale — a mutation superseded us
    db.prepare(`DELETE FROM cg_communities WHERE repo_id = ?`).run(repoId);
    db.prepare(`DELETE FROM cg_symbol_metrics WHERE repo_id = ?`).run(repoId);
    const insC = db.prepare(`INSERT INTO cg_communities (repo_id, community_id, label, size, cohesion) VALUES (?,?,?,?,?)`);
    for (const c of communities) insC.run(repoId, c.community_id, c.label, c.size, c.cohesion);
    const insM = db.prepare(`INSERT INTO cg_symbol_metrics (symbol_id, repo_id, community_id, degree, hotspot_score, bridge_score) VALUES (?,?,?,?,?,?)`);
    for (const m of metrics) insM.run(m.symbol_id, repoId, m.community_id, m.degree, m.hotspot_score, m.bridge_score);
    db.prepare(`UPDATE cg_repos SET analyzed_revision = ?, analyzed_at = ? WHERE id = ?`)
      .run(revision, new Date().toISOString(), repoId);
    return true;
  });
  return tx();
}

export async function readCommunities(store, repoId, limit = 20) {
  return store.db.prepare(
    `SELECT community_id, label, size, cohesion FROM cg_communities
      WHERE repo_id = ? ORDER BY size DESC, community_id ASC LIMIT ?`
  ).all(repoId, limit);
}

export async function readHotspots(store, repoId, limit = 20) {
  return store.db.prepare(
    `SELECT s.qualified, s.name, s.kind, f.path, m.degree, m.hotspot_score, m.community_id
       FROM cg_symbol_metrics m
       JOIN cg_symbols s ON s.id = m.symbol_id
       JOIN cg_files   f ON f.id = s.file_id
      WHERE m.repo_id = ? AND m.hotspot_score IS NOT NULL
      ORDER BY m.hotspot_score DESC, s.qualified ASC LIMIT ?`
  ).all(repoId, limit);
}

export async function readBridges(store, repoId, limit = 20) {
  return store.db.prepare(
    `SELECT s.qualified, s.name, s.kind, f.path, m.bridge_score, m.degree, m.community_id
       FROM cg_symbol_metrics m
       JOIN cg_symbols s ON s.id = m.symbol_id
       JOIN cg_files   f ON f.id = s.file_id
      WHERE m.repo_id = ? AND m.bridge_score > 0
      ORDER BY m.bridge_score DESC, s.qualified ASC LIMIT ?`
  ).all(repoId, limit);
}

// symbol_id → { community_id, degree, hotspot_score, bridge_score } for /graph.
export async function readMetricsMap(store, repoId) {
  const rows = store.db.prepare(
    `SELECT symbol_id, community_id, degree, hotspot_score, bridge_score
       FROM cg_symbol_metrics WHERE repo_id = ?`
  ).all(repoId);
  return new Map(rows.map(r => [r.symbol_id, r]));
}

export async function analysisSummary(store, repoId) {
  const db = store.db;
  const symbols = db.prepare(`SELECT COUNT(*) AS n FROM cg_symbols s JOIN cg_files f ON f.id=s.file_id WHERE f.repo_id=?`).get(repoId).n;
  const edges = db.prepare(`SELECT COUNT(*) AS n FROM cg_edges e JOIN cg_symbols s ON s.id=e.src_symbol_id JOIN cg_files f ON f.id=s.file_id WHERE f.repo_id=? AND e.dst_symbol_id IS NOT NULL`).get(repoId).n;
  const communities = db.prepare(`SELECT COUNT(*) AS n FROM cg_communities WHERE repo_id=?`).get(repoId).n;
  return { symbols, edges, communities };
}
