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

function upsertFileSync(db, repoId, relPath, lang, hash, mtime) {
  const existing = db.prepare(
    `SELECT id, sha256 FROM cg_files WHERE repo_id = ? AND path = ?`
  ).get(repoId, relPath);
  if (existing?.sha256 === hash) {
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

function reindexFileSync(db, fileId, symbols, edges) {
  db.prepare(`DELETE FROM cg_symbols WHERE file_id = ?`).run(fileId);

  const insSym = db.prepare(
    `INSERT INTO cg_symbols (file_id, kind, name, qualified, start_line, end_line, signature, doc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insEdge = db.prepare(
    `INSERT INTO cg_edges (src_symbol_id, dst_symbol_id, dst_unresolved, kind, src_line)
     VALUES (?, NULL, ?, ?, ?)`
  );

  const localToDb = new Map();
  const pending = [];
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
    insEdge.run(src, e.dst_unresolved ?? null, e.kind, e.src_line ?? null);
  }
  return { symbolCount: symbols.length, edgeCount: edges.length, pending };
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
// same repo.
function resolveEdgesSync(db, repoId) {
  db.exec(`
    UPDATE cg_edges
       SET dst_symbol_id = (
             SELECT s.id FROM cg_symbols s
             JOIN cg_files df ON df.id = s.file_id
             WHERE s.name = cg_edges.dst_unresolved AND df.repo_id = ${repoId}
           ),
           dst_unresolved = NULL
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
          ) = 1
     )
  `);
}

// ── Public indexer API ──────────────────────────────────────────────────────

export async function indexRepoFiles(store, rootPath, fileIterator, { generateEmbedding }) {
  const db = store.db;
  const counts = { files: 0, changed: 0, symbols: 0, edges: 0, skipped: 0 };
  const repoId = upsertRepoSync(db, rootPath);

  // Per-file try/catch so one bad file doesn't kill the whole repo. We don't
  // wrap the whole repo in a single transaction here because async embedding
  // calls can interleave with a long-lived tx; instead each file's writes are
  // their own implicit transaction (better-sqlite3 batches each prepare/run).
  for await (const { abs, rel, ext } of fileIterator) {
    try {
      const buf  = await readFile(abs);
      const hash = sha256(buf);
      const st   = await stat(abs);
      const { fileId, changed } = upsertFileSync(db, repoId, rel, ext.lang, hash, st.mtime);
      counts.files++;
      if (!changed) continue;

      const parsed = await ext.fn(buf.toString('utf8'), rel);
      const result = reindexFileSync(db, fileId, parsed.symbols, parsed.edges);
      await embedInline(db, result.pending, generateEmbedding);
      counts.changed++;
      counts.symbols += result.symbolCount;
      counts.edges   += result.edgeCount;
    } catch (err) {
      counts.skipped++;
      logError(`[codegraph/sqlite] indexRepo: skipped ${rel}`, err, { repo: rootPath });
    }
  }
  resolveEdgesSync(db, repoId);
  db.prepare(`UPDATE cg_repos SET last_indexed_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), repoId);
  return counts;
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
  const result = reindexFileSync(db, fileId, parsed.symbols, parsed.edges);
  if (embedInlineFn) await embedInline(db, result.pending, embedInlineFn);
  resolveEdgesSync(db, repoId);
  return { skipped: false, ...result };
}

export async function removeOneFile(store, rootPath, relPath) {
  const db = store.db;
  const row = db.prepare(`SELECT id FROM cg_repos WHERE root_path = ?`).get(rootPath);
  if (!row) return { removed: false };
  const info = db.prepare(`DELETE FROM cg_files WHERE repo_id = ? AND path = ?`).run(row.id, relPath);
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
    `SELECT id, root_path FROM cg_repos WHERE root_path LIKE '%' || ? || '%'`
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
  const info = db.prepare(`DELETE FROM cg_repos WHERE root_path = ?`).run(rootPath);
  return { deleted: info.changes > 0 };
}
