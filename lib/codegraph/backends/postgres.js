// lib/codegraph/backends/postgres.js
// Postgres backend for codegraph. Both the indexer (writes) and the handlers
// (reads) live here in one file — they share schema knowledge, parameter
// numbering, and the toVec helper, so keeping them together is cleaner than
// scattering across two files.
//
// Every export takes the *store* and pulls `.pool` internally; callers don't
// need to know whether they're on Postgres or SQLite — the dispatcher in
// indexer.js / codegraphHandlers.js routes to the right backend module.

import { readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { logError } from '../../helpers/logger.js';

const toVec = (e) => `[${e.join(',')}]`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── Indexer primitives ───────────────────────────────────────────────────────

async function upsertRepo(client, rootPath) {
  const { rows } = await client.query(
    `INSERT INTO cg_repos (root_path) VALUES ($1)
     ON CONFLICT (root_path) DO UPDATE SET root_path = EXCLUDED.root_path
     RETURNING id`, [rootPath]
  );
  return rows[0].id;
}

async function upsertFile(client, repoId, relPath, lang, hash, mtime) {
  const existing = await client.query(
    `SELECT id, sha256 FROM cg_files WHERE repo_id = $1 AND path = $2`,
    [repoId, relPath]
  );
  if (existing.rows[0]?.sha256 === hash) {
    return { fileId: existing.rows[0].id, changed: false };
  }
  const { rows } = await client.query(
    `INSERT INTO cg_files (repo_id, path, language, sha256, mtime)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (repo_id, path) DO UPDATE
       SET language=EXCLUDED.language, sha256=EXCLUDED.sha256, mtime=EXCLUDED.mtime
     RETURNING id`,
    [repoId, relPath, lang, hash, mtime]
  );
  return { fileId: rows[0].id, changed: true };
}

async function reindexFile(client, fileId, source, filePath, extractFn) {
  await client.query(`DELETE FROM cg_symbols WHERE file_id = $1`, [fileId]);

  const { symbols, edges } = await extractFn(source, filePath);
  const localToDb = new Map();
  const pending = [];

  for (const s of symbols) {
    const { rows } = await client.query(
      `INSERT INTO cg_symbols (file_id, kind, name, qualified, start_line, end_line, signature, doc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [fileId, s.kind, s.name, s.qualified, s.start_line, s.end_line,
       s.signature ?? null, s.doc ?? null]
    );
    localToDb.set(s.localId, rows[0].id);
    pending.push({ id: rows[0].id, text: [s.name, s.signature, s.doc].filter(Boolean).join('. ') });
  }
  for (const e of edges) {
    const src = localToDb.get(e.srcLocalId);
    if (!src) continue;
    await client.query(
      `INSERT INTO cg_edges (src_symbol_id, dst_symbol_id, dst_unresolved, kind, src_line)
       VALUES ($1, NULL, $2, $3, $4)`,
      [src, e.dst_unresolved ?? null, e.kind, e.src_line ?? null]
    );
  }
  return { symbolCount: symbols.length, edgeCount: edges.length, pending };
}

async function embedInline(client, pending, generateEmbedding) {
  for (const { id, text } of pending) {
    const vec = await generateEmbedding(text, 'document').catch(() => null);
    if (!vec) continue;
    await client.query(
      `UPDATE cg_symbols SET embedding = $1::vector WHERE id = $2`,
      [toVec(vec), id]
    );
  }
}

async function resolveEdges(client, repoId) {
  await client.query(`
    UPDATE cg_edges e
       SET dst_symbol_id = sub.dst_id, dst_unresolved = NULL
      FROM (
        SELECT e2.id AS edge_id, s.id AS dst_id
          FROM cg_edges e2
          JOIN cg_symbols src ON src.id = e2.src_symbol_id
          JOIN cg_files   sf  ON sf.id  = src.file_id
          JOIN cg_symbols s   ON s.name = e2.dst_unresolved
          JOIN cg_files   df  ON df.id  = s.file_id
         WHERE sf.repo_id = $1 AND df.repo_id = $1
           AND e2.dst_symbol_id IS NULL
           AND e2.kind IN ('calls','extends','references')
         GROUP BY e2.id, s.id
        HAVING COUNT(*) OVER (PARTITION BY e2.id) = 1
      ) sub
     WHERE e.id = sub.edge_id
  `, [repoId]);
}

// ── Public indexer API ──────────────────────────────────────────────────────

export async function indexRepoFiles(store, rootPath, fileIterator, { generateEmbedding }) {
  const pool = store.pool;
  const client = await pool.connect();
  const counts = { files: 0, changed: 0, symbols: 0, edges: 0, skipped: 0 };
  try {
    await client.query('BEGIN');
    const repoId = await upsertRepo(client, rootPath);

    for await (const { abs, rel, ext } of fileIterator) {
      try {
        const buf  = await readFile(abs);
        const hash = sha256(buf);
        const st   = await stat(abs);
        const { fileId, changed } = await upsertFile(client, repoId, rel, ext.lang, hash, st.mtime);
        counts.files++;
        if (!changed) continue;
        const result = await reindexFile(client, fileId, buf.toString('utf8'), rel, ext.fn);
        await embedInline(client, result.pending, generateEmbedding);
        counts.changed++;
        counts.symbols += result.symbolCount;
        counts.edges   += result.edgeCount;
      } catch (err) {
        counts.skipped++;
        logError(`[codegraph/pg] indexRepo: skipped ${rel}`, err, { repo: rootPath });
      }
    }
    await resolveEdges(client, repoId);
    await client.query(`UPDATE cg_repos SET last_indexed_at = now() WHERE id = $1`, [repoId]);
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function indexOneFile(store, rootPath, relPath, ext, { embedInlineFn = null } = {}) {
  const abs = path.join(rootPath, relPath);
  let buf, st;
  try { buf = await readFile(abs); st = await stat(abs); }
  catch { return { skipped: true, reason: 'file gone' }; }
  const hash = sha256(buf);

  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    const repoId = await upsertRepo(client, rootPath);
    const { fileId, changed } = await upsertFile(client, repoId, relPath, ext.lang, hash, st.mtime);
    if (!changed) {
      await client.query('COMMIT');
      return { skipped: true, reason: 'unchanged' };
    }
    const result = await reindexFile(client, fileId, buf.toString('utf8'), relPath, ext.fn);
    if (embedInlineFn) await embedInline(client, result.pending, embedInlineFn);
    await resolveEdges(client, repoId);
    await client.query('COMMIT');
    return { skipped: false, ...result };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function removeOneFile(store, rootPath, relPath) {
  const client = await store.pool.connect();
  try {
    const { rows } = await client.query(`SELECT id FROM cg_repos WHERE root_path = $1`, [rootPath]);
    if (!rows[0]) return { removed: false };
    const { rowCount } = await client.query(
      `DELETE FROM cg_files WHERE repo_id = $1 AND path = $2`,
      [rows[0].id, relPath]
    );
    return { removed: rowCount > 0 };
  } finally {
    client.release();
  }
}

export async function sweepMissingFiles(store, rootPath, statFn) {
  const client = await store.pool.connect();
  try {
    const { rows: r } = await client.query(`SELECT id FROM cg_repos WHERE root_path = $1`, [rootPath]);
    if (!r[0]) return { removed: 0 };
    const repoId = r[0].id;
    const { rows } = await client.query(`SELECT path FROM cg_files WHERE repo_id = $1`, [repoId]);
    const gone = [];
    for (const row of rows) {
      try { await statFn(path.join(rootPath, row.path)); }
      catch { gone.push(row.path); }
    }
    if (gone.length) {
      await client.query(`DELETE FROM cg_files WHERE repo_id = $1 AND path = ANY($2)`, [repoId, gone]);
    }
    return { removed: gone.length };
  } finally {
    client.release();
  }
}

export async function setSymbolEmbedding(store, symbolId, embedding) {
  await store.pool.query(
    `UPDATE cg_symbols SET embedding = $1::vector WHERE id = $2`,
    [toVec(embedding), symbolId]
  );
}

// ── Read-side query API ──────────────────────────────────────────────────────

// Every result that carries a repo-relative `path` also carries the repo it
// belongs to: a friendly `repo` name (root_path basename, also a valid `repo`
// filter substring) and the absolute `root_path` so callers can build a full
// path. Without this, relative paths are ambiguous across repos that share a
// directory layout (e.g. multiple repos with a lib/ folder).
const withRepo = (row) => row && { ...row, repo: path.basename(row.root_path) };

async function resolveRepoId(pool, repo) {
  if (!repo) return null;
  // Prefer exact match so a full root_path never collides with a longer sibling.
  const exact = await pool.query(`SELECT id, root_path FROM cg_repos WHERE root_path = $1`, [repo]);
  if (exact.rows.length === 1) return exact.rows[0].id;
  const { rows } = await pool.query(
    `SELECT id, root_path FROM cg_repos WHERE root_path ILIKE '%' || $1 || '%'`, [repo]
  );
  if (rows.length === 0) { const e = new Error(`No indexed repo matches '${repo}'.`); e.userFacing = true; throw e; }
  if (rows.length > 1)   { const e = new Error(`Ambiguous repo '${repo}' — matches: ${rows.map(r => r.root_path).join(', ')}`); e.userFacing = true; throw e; }
  return rows[0].id;
}

export async function search(store, { query, kind, repo, limit = 20 }, { generateEmbedding, vectorEnabled }) {
  const pool = store.pool;
  const repoId = await resolveRepoId(pool, repo);
  const useVector = vectorEnabled?.() ?? false;
  const queryVec = useVector ? await generateEmbedding?.(query, 'query').catch(() => null) : null;

  if (!queryVec) {
    const params = [query];
    const conds  = [`to_tsvector('simple', s.name || ' ' || COALESCE(s.doc,'')) @@ plainto_tsquery('simple', $1)`];
    if (kind)   { params.push(kind);   conds.push(`s.kind = $${params.length}`); }
    if (repoId) { params.push(repoId); conds.push(`f.repo_id = $${params.length}`); }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT s.qualified, s.kind, s.name, s.signature, s.start_line, s.end_line, f.path, r.root_path,
              ts_rank(to_tsvector('simple', s.name || ' ' || COALESCE(s.doc,'')),
                      plainto_tsquery('simple', $1)) AS score
         FROM cg_symbols s JOIN cg_files f ON f.id = s.file_id JOIN cg_repos r ON r.id = f.repo_id
        WHERE ${conds.join(' AND ')} ORDER BY score DESC LIMIT $${params.length}`,
      params
    );
    return { matches: rows.map(withRepo), mode: 'fulltext' };
  }

  const params = [toVec(queryVec), query];
  let idx = 3;
  const extra = [];
  if (kind)   { extra.push(`AND s.kind = $${idx++}`);    params.push(kind); }
  if (repoId) { extra.push(`AND f.repo_id = $${idx++}`); params.push(repoId); }
  const extras = extra.join(' ');
  params.push(limit);
  const { rows } = await pool.query(`
    WITH vector_ranked AS (
      SELECT s.id, ROW_NUMBER() OVER (ORDER BY s.embedding <=> $1::vector) AS rank
        FROM cg_symbols s JOIN cg_files f ON f.id = s.file_id
       WHERE s.embedding IS NOT NULL ${extras}
       LIMIT 60
    ),
    fts_ranked AS (
      SELECT s.id, ROW_NUMBER() OVER (
               ORDER BY ts_rank(to_tsvector('simple', s.name || ' ' || COALESCE(s.doc,'')),
                                plainto_tsquery('simple', $2)) DESC) AS rank
        FROM cg_symbols s JOIN cg_files f ON f.id = s.file_id
       WHERE to_tsvector('simple', s.name || ' ' || COALESCE(s.doc,'')) @@ plainto_tsquery('simple', $2) ${extras}
       LIMIT 60
    ),
    fused AS (
      SELECT COALESCE(v.id, f.id) AS id,
             COALESCE(1.0/(60+v.rank), 0.0) + COALESCE(1.0/(60+f.rank), 0.0) AS rrf
        FROM vector_ranked v FULL OUTER JOIN fts_ranked f ON v.id = f.id
    )
    SELECT s.qualified, s.kind, s.name, s.signature, s.start_line, s.end_line, f.path, r.root_path, fu.rrf AS score
      FROM fused fu JOIN cg_symbols s ON s.id = fu.id JOIN cg_files f ON f.id = s.file_id JOIN cg_repos r ON r.id = f.repo_id
     ORDER BY fu.rrf DESC LIMIT $${idx}
  `, params);
  return { matches: rows.map(withRepo), mode: 'hybrid' };
}

export async function outline(store, { path: filePath, repo }) {
  const repoId = await resolveRepoId(store.pool, repo);
  const params = [filePath];
  if (repoId) params.push(repoId);
  const { rows } = await store.pool.query(
    `SELECT s.kind, s.name, s.qualified, s.start_line, s.end_line, s.signature, r.root_path
       FROM cg_symbols s
       JOIN cg_files   f ON f.id = s.file_id
       JOIN cg_repos   r ON r.id = f.repo_id
      WHERE f.path = $1 ${repoId ? 'AND f.repo_id = $2' : ''} ORDER BY r.root_path, s.start_line`, params
  );
  return { path: filePath, symbols: rows.map(withRepo) };
}

export async function context(store, { qualified, repo }) {
  const repoId = await resolveRepoId(store.pool, repo);
  const params = [qualified];
  if (repoId) params.push(repoId);
  const { rows } = await store.pool.query(
    `SELECT s.qualified, s.start_line, s.end_line, s.signature, s.doc, s.kind, s.name,
            f.path, r.root_path
       FROM cg_symbols s
       JOIN cg_files   f ON f.id = s.file_id
       JOIN cg_repos   r ON r.id = f.repo_id
      WHERE s.qualified = $1 ${repoId ? 'AND f.repo_id = $2' : ''} LIMIT 1`, params
  );
  return rows[0] ?? null;
}

export async function repos(store) {
  const { rows } = await store.pool.query(`
    SELECT r.id, r.root_path, r.last_indexed_at,
           COUNT(DISTINCT f.id) AS files,
           COUNT(s.id)          AS symbols
      FROM cg_repos r
      LEFT JOIN cg_files   f ON f.repo_id = r.id
      LEFT JOIN cg_symbols s ON s.file_id  = f.id
     GROUP BY r.id ORDER BY r.last_indexed_at DESC NULLS LAST
  `);
  return { repos: rows };
}

async function walkEdges(pool, qualified, depth, direction, repoId) {
  const { rows: target } = await pool.query(
    `SELECT s.id FROM cg_symbols s JOIN cg_files f ON f.id = s.file_id
      WHERE s.qualified = $1 ${repoId ? 'AND f.repo_id = $2' : ''} LIMIT 1`,
    repoId ? [qualified, repoId] : [qualified]
  );
  if (!target.length) return null;
  const seen = new Set([target[0].id]);
  let frontier = [target[0].id];
  const out = [];
  for (let hop = 1; hop <= depth; hop++) {
    if (!frontier.length) break;
    const { rows } = await pool.query(
      direction === 'callers'
        ? `SELECT e.src_symbol_id AS id, s.qualified, s.kind, s.name, f.path, r.root_path, e.src_line
             FROM cg_edges e JOIN cg_symbols s ON s.id = e.src_symbol_id
             JOIN cg_files f ON f.id = s.file_id
             JOIN cg_repos r ON r.id = f.repo_id
            WHERE e.kind = 'calls' AND e.dst_symbol_id = ANY($1)`
        : `SELECT e.dst_symbol_id AS id, s.qualified, s.kind, s.name, f.path, r.root_path, e.src_line
             FROM cg_edges e JOIN cg_symbols s ON s.id = e.dst_symbol_id
             JOIN cg_files f ON f.id = s.file_id
             JOIN cg_repos r ON r.id = f.repo_id
            WHERE e.kind = 'calls' AND e.src_symbol_id = ANY($1) AND e.dst_symbol_id IS NOT NULL`,
      [frontier]
    );
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
  const repoId = await resolveRepoId(store.pool, repo);
  return walkEdges(store.pool, qualified, Math.min(Math.max(depth, 1), 5), 'callers', repoId);
}
export async function callees(store, { qualified, depth = 1, repo }) {
  const repoId = await resolveRepoId(store.pool, repo);
  return walkEdges(store.pool, qualified, Math.min(Math.max(depth, 1), 5), 'callees', repoId);
}

export async function deleteRepo(store, rootPath) {
  const { rowCount } = await store.pool.query(`DELETE FROM cg_repos WHERE root_path = $1`, [rootPath]);
  return { deleted: rowCount > 0 };
}
