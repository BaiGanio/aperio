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
import { evictRepo } from '../graphCache.js';
import {
  INDEX_SCHEMA_VERSION, FILE_SYMBOL_KIND, FILE_SRC_TOKEN,
  CONFIDENCE, SCORE, relationContextFor, resolveImportTarget,
} from '../resolve.js';

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

async function upsertFile(client, repoId, relPath, lang, hash, mtime, forceRebuild = false) {
  const existing = await client.query(
    `SELECT id, sha256 FROM cg_files WHERE repo_id = $1 AND path = $2`,
    [repoId, relPath]
  );
  if (existing.rows[0]?.sha256 === hash && !forceRebuild) {
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

  // Synthetic file node: one per file, `__file__` edges (imports) hang off it.
  const fileRow = await client.query(
    `INSERT INTO cg_symbols (file_id, kind, name, qualified, start_line, end_line, signature, doc)
     VALUES ($1,$2,$3,$4,1,1,NULL,NULL) RETURNING id`,
    [fileId, FILE_SYMBOL_KIND, path.basename(filePath), filePath]
  );
  localToDb.set(FILE_SRC_TOKEN, fileRow.rows[0].id);

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
    // Every extractor edge is a direct syntax fact: EXTRACTED / 1.0. The resolver
    // reclassifies rows it resolves by name/path to INFERRED / 0.8.
    await client.query(
      `INSERT INTO cg_edges
         (src_symbol_id, dst_symbol_id, dst_unresolved, kind, src_line,
          confidence, confidence_score, provenance, relation_context)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8)`,
      [src, e.dst_unresolved ?? null, e.kind, e.src_line ?? null,
       CONFIDENCE.EXTRACTED, SCORE.EXTRACTED, 'extract',
       e.relation_context ?? relationContextFor(e.kind)]
    );
  }
  // +1 for the synthetic file symbol.
  return { symbolCount: symbols.length + 1, edgeCount: edges.length, pending };
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
  // Unique-name resolution → INFERRED / 0.8. File symbols are excluded as
  // candidates so a call/extend/reference never resolves to a file node.
  await client.query(`
    UPDATE cg_edges e
       SET dst_symbol_id = sub.dst_id, dst_unresolved = NULL,
           confidence = '${CONFIDENCE.INFERRED}', confidence_score = ${SCORE.INFERRED},
           provenance = 'name-resolver'
      FROM (
        SELECT e2.id AS edge_id, MIN(s.id) AS dst_id
          FROM cg_edges e2
          JOIN cg_symbols src ON src.id = e2.src_symbol_id
          JOIN cg_files   sf  ON sf.id  = src.file_id
          JOIN cg_symbols s   ON s.name = e2.dst_unresolved
          JOIN cg_files   df  ON df.id  = s.file_id
         WHERE sf.repo_id = $1 AND df.repo_id = $1
           AND e2.dst_symbol_id IS NULL
           AND s.kind <> '${FILE_SYMBOL_KIND}'
           AND e2.kind IN ('calls','extends','references')
         GROUP BY e2.id
        HAVING COUNT(DISTINCT s.id) = 1
      ) sub
     WHERE e.id = sub.edge_id
  `, [repoId]);
  await resolveImports(client, repoId);
}

// Resolve relative `imports` edges (from a file node) to the target file's
// synthetic file symbol. Path inference → INFERRED / 0.8. Self-imports and
// unresolved specifiers are left alone (no fabricated destination).
async function resolveImports(client, repoId) {
  const { rows: fileRows } = await client.query(
    `SELECT f.path AS path, s.id AS id
       FROM cg_symbols s JOIN cg_files f ON f.id = s.file_id
      WHERE f.repo_id = $1 AND s.kind = $2`,
    [repoId, FILE_SYMBOL_KIND]
  );
  if (!fileRows.length) return;
  const filePathSet = new Set(fileRows.map(r => r.path));
  const fileSymbolByPath = new Map(fileRows.map(r => [r.path, r.id]));

  const { rows: pendingImports } = await client.query(
    `SELECT e.id AS edge_id, f.path AS importer, e.dst_unresolved AS spec
       FROM cg_edges e
       JOIN cg_symbols src ON src.id = e.src_symbol_id
       JOIN cg_files   f   ON f.id   = src.file_id
      WHERE f.repo_id = $1 AND e.kind = 'imports'
        AND e.dst_symbol_id IS NULL AND e.dst_unresolved IS NOT NULL`,
    [repoId]
  );
  for (const { edge_id, importer, spec } of pendingImports) {
    const target = resolveImportTarget(importer, spec, filePathSet);
    if (!target || target === importer) continue; // no fabrication, no self-cycle
    const dstId = fileSymbolByPath.get(target);
    if (!dstId) continue;
    await client.query(
      `UPDATE cg_edges
          SET dst_symbol_id = $1, dst_unresolved = NULL,
              confidence = '${CONFIDENCE.INFERRED}', confidence_score = ${SCORE.INFERRED},
              provenance = 'import-resolver'
        WHERE id = $2`,
      [dstId, edge_id]
    );
  }
}

// Increment the repo's graph revision once per successful graph-changing op.
async function bumpRevision(client, repoId) {
  await client.query(`UPDATE cg_repos SET graph_revision = graph_revision + 1 WHERE id = $1`, [repoId]);
}

// ── Public indexer API ──────────────────────────────────────────────────────

export async function indexRepoFiles(store, rootPath, fileIterator, { generateEmbedding, deferEmbedding = false, onProgress } = {}) {
  const pool = store.pool;
  const client = await pool.connect();
  const counts = { files: 0, changed: 0, symbols: 0, edges: 0, skipped: 0 };
  const pending = []; // returned (post-COMMIT) for the caller's queue when deferEmbedding
  try {
    await client.query('BEGIN');
    const repoId = await upsertRepo(client, rootPath);
    // A schema-version bump forces a full rebuild so old graphs gain file/import
    // nodes despite unchanged file hashes.
    const { rows: verRows } = await client.query(`SELECT index_schema_version AS v FROM cg_repos WHERE id = $1`, [repoId]);
    const forceRebuild = (verRows[0]?.v ?? 0) < INDEX_SCHEMA_VERSION;

    for await (const { abs, rel, ext } of fileIterator) {
      try {
        const buf  = await readFile(abs);
        const hash = sha256(buf);
        const st   = await stat(abs);
        const { fileId, changed } = await upsertFile(client, repoId, rel, ext.lang, hash, st.mtime, forceRebuild);
        counts.files++;
        // Throttled live progress so the UI shows movement during a long root.
        if (onProgress && counts.files % 20 === 0) onProgress({ ...counts });
        if (!changed) continue;
        const result = await reindexFile(client, fileId, buf.toString('utf8'), rel, ext.fn);
        if (deferEmbedding) for (const p of result.pending) pending.push(p);
        else await embedInline(client, result.pending, generateEmbedding);
        counts.changed++;
        counts.symbols += result.symbolCount;
        counts.edges   += result.edgeCount;
      } catch (err) {
        counts.skipped++;
        logError(`[codegraph/pg] indexRepo: skipped ${rel}`, err, { repo: rootPath });
      }
    }
    await resolveEdges(client, repoId);
    // A folder with zero indexable code files (e.g. a documents-only folder) would
    // otherwise leave an empty repo row that clutters the Code Graph panel — drop it.
    const { rows: fc } = await client.query(`SELECT COUNT(*)::int AS n FROM cg_files WHERE repo_id = $1`, [repoId]);
    if (fc[0].n === 0) {
      await client.query(`DELETE FROM cg_repos WHERE id = $1`, [repoId]);
      await client.query('COMMIT');
      return { ...counts, pending: [] };
    }
    await client.query(`UPDATE cg_repos SET last_indexed_at = now(), index_schema_version = $2 WHERE id = $1`, [repoId, INDEX_SCHEMA_VERSION]);
    // One revision bump per successful graph-changing index (skip pure no-ops).
    if (counts.changed > 0) await bumpRevision(client, repoId);
    await client.query('COMMIT');
    return { ...counts, pending };
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
    await bumpRevision(client, repoId);
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
    if (rowCount > 0) await bumpRevision(client, rows[0].id);
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
      await bumpRevision(client, repoId);
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

async function resolveRepoIdByPool(pool, repo) {
  if (!repo) return null;
  // Prefer exact match so a full root_path never collides with a longer sibling.
  const exact = await pool.query(`SELECT id, root_path FROM cg_repos WHERE root_path = $1`, [repo]);
  if (exact.rows.length === 1) return exact.rows[0].id;
  const { rows } = await pool.query(
    `SELECT id, root_path FROM cg_repos WHERE root_path ILIKE '%' || $1 || '%' ORDER BY root_path`, [repo]
  );
  if (rows.length === 0) { const e = new Error(`No indexed repo matches '${repo}'.`); e.userFacing = true; throw e; }
  if (rows.length > 1)   { const e = new Error(`Ambiguous repo '${repo}' — matches: ${rows.map(r => r.root_path).join(', ')}`); e.userFacing = true; throw e; }
  return rows[0].id;
}

export async function search(store, { query, kind, repo, limit = 20 }, { generateEmbedding, vectorEnabled }) {
  const pool = store.pool;
  const repoId = await resolveRepoIdByPool(pool, repo);
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
  const repoId = await resolveRepoIdByPool(store.pool, repo);
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
  const repoId = await resolveRepoIdByPool(store.pool, repo);
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
  const repoId = await resolveRepoIdByPool(store.pool, repo);
  return walkEdges(store.pool, qualified, Math.min(Math.max(depth, 1), 5), 'callers', repoId);
}
export async function callees(store, { qualified, depth = 1, repo }) {
  const repoId = await resolveRepoIdByPool(store.pool, repo);
  return walkEdges(store.pool, qualified, Math.min(Math.max(depth, 1), 5), 'callees', repoId);
}

export async function deleteRepo(store, rootPath) {
  const { rows } = await store.pool.query(`SELECT id FROM cg_repos WHERE root_path = $1`, [rootPath]);
  const { rowCount } = await store.pool.query(`DELETE FROM cg_repos WHERE root_path = $1`, [rootPath]);
  const deleted = rowCount > 0;
  if (deleted && rows[0]) evictRepo(store, rows[0].id);
  return { deleted };
}

// ── Graph-intelligence read API (issue #283) ────────────────────────────────

// Resolve a `repo` substring/exact match to a repo id (throws userFacing on
// ambiguous/none). Exposed for the shared traversal + analysis layer.
export async function resolveRepoId(store, repo) {
  return resolveRepoIdByPool(store.pool, repo);
}

// Distinct repo ids that contain a symbol with this qualified name.
export async function findReposForSymbol(store, qualified) {
  const { rows } = await store.pool.query(
    `SELECT DISTINCT f.repo_id AS id
       FROM cg_symbols s JOIN cg_files f ON f.id = s.file_id
      WHERE s.qualified = $1`,
    [qualified]
  );
  return rows.map(r => r.id);
}

// Load one repository's resolved directed graph: every symbol node plus every
// resolved edge. Unresolved edges (dst NULL) are omitted — traversal/analysis
// only reason over known destinations.
export async function loadGraph(store, repoId) {
  const { rows: nodes } = await store.pool.query(
    `SELECT s.id, s.qualified, s.kind, s.name, f.path, r.root_path
       FROM cg_symbols s
       JOIN cg_files f ON f.id = s.file_id
       JOIN cg_repos r ON r.id = f.repo_id
      WHERE f.repo_id = $1`,
    [repoId]
  );
  const { rows: edges } = await store.pool.query(
    `SELECT e.src_symbol_id AS src, e.dst_symbol_id AS dst, e.kind,
            e.confidence, e.confidence_score, e.relation_context
       FROM cg_edges e
       JOIN cg_symbols s ON s.id = e.src_symbol_id
       JOIN cg_files   f ON f.id = s.file_id
      WHERE f.repo_id = $1 AND e.dst_symbol_id IS NOT NULL`,
    [repoId]
  );
  return { nodes: nodes.map(n => ({ ...n, repo: path.basename(n.root_path) })), edges };
}

// ── Analysis snapshot persistence (issue #283 step 4) ───────────────────────

export async function readRevisions(store, repoId) {
  const { rows } = await store.pool.query(
    `SELECT graph_revision, analyzed_revision, analyzed_at FROM cg_repos WHERE id = $1`, [repoId]
  );
  return rows[0] ?? null;
}

// Persist a community/metric snapshot — but only if the repo's graph revision
// still matches the one the analysis was computed against (compare-before-commit).
// Returns true when committed, false when a newer revision won the race.
export async function persistAnalysis(store, repoId, revision, { communities, metrics }) {
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT graph_revision AS r FROM cg_repos WHERE id = $1 FOR UPDATE`, [repoId]);
    if (!rows[0] || Number(rows[0].r) !== Number(revision)) { await client.query('ROLLBACK'); return false; }
    await client.query(`DELETE FROM cg_communities WHERE repo_id = $1`, [repoId]);
    await client.query(`DELETE FROM cg_symbol_metrics WHERE repo_id = $1`, [repoId]);
    for (const c of communities) {
      await client.query(
        `INSERT INTO cg_communities (repo_id, community_id, label, size, cohesion) VALUES ($1,$2,$3,$4,$5)`,
        [repoId, c.community_id, c.label, c.size, c.cohesion]
      );
    }
    for (const m of metrics) {
      await client.query(
        `INSERT INTO cg_symbol_metrics (symbol_id, repo_id, community_id, degree, hotspot_score, bridge_score)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [m.symbol_id, repoId, m.community_id, m.degree, m.hotspot_score, m.bridge_score]
      );
    }
    await client.query(`UPDATE cg_repos SET analyzed_revision = $1, analyzed_at = now() WHERE id = $2`, [revision, repoId]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function readCommunities(store, repoId, limit = 20) {
  const { rows } = await store.pool.query(
    `SELECT community_id, label, size, cohesion FROM cg_communities
      WHERE repo_id = $1 ORDER BY size DESC, community_id ASC LIMIT $2`, [repoId, limit]
  );
  return rows;
}

export async function readHotspots(store, repoId, limit = 20) {
  const { rows } = await store.pool.query(
    `SELECT s.qualified, s.name, s.kind, f.path, m.degree, m.hotspot_score, m.community_id
       FROM cg_symbol_metrics m
       JOIN cg_symbols s ON s.id = m.symbol_id
       JOIN cg_files   f ON f.id = s.file_id
      WHERE m.repo_id = $1 AND m.hotspot_score IS NOT NULL
      ORDER BY m.hotspot_score DESC, s.qualified ASC LIMIT $2`, [repoId, limit]
  );
  return rows;
}

export async function readBridges(store, repoId, limit = 20) {
  const { rows } = await store.pool.query(
    `SELECT s.qualified, s.name, s.kind, f.path, m.bridge_score, m.degree, m.community_id
       FROM cg_symbol_metrics m
       JOIN cg_symbols s ON s.id = m.symbol_id
       JOIN cg_files   f ON f.id = s.file_id
      WHERE m.repo_id = $1 AND m.bridge_score > 0
      ORDER BY m.bridge_score DESC, s.qualified ASC LIMIT $2`, [repoId, limit]
  );
  return rows;
}

export async function readMetricsMap(store, repoId) {
  const { rows } = await store.pool.query(
    `SELECT symbol_id, community_id, degree, hotspot_score, bridge_score
       FROM cg_symbol_metrics WHERE repo_id = $1`, [repoId]
  );
  return new Map(rows.map(r => [r.symbol_id, r]));
}

export async function analysisSummary(store, repoId) {
  const q = async (sql) => (await store.pool.query(sql, [repoId])).rows[0].n;
  const symbols = await q(`SELECT COUNT(*)::int AS n FROM cg_symbols s JOIN cg_files f ON f.id=s.file_id WHERE f.repo_id=$1`);
  const edges = await q(`SELECT COUNT(*)::int AS n FROM cg_edges e JOIN cg_symbols s ON s.id=e.src_symbol_id JOIN cg_files f ON f.id=s.file_id WHERE f.repo_id=$1 AND e.dst_symbol_id IS NOT NULL`);
  const communities = await q(`SELECT COUNT(*)::int AS n FROM cg_communities WHERE repo_id=$1`);
  return { symbols, edges, communities };
}
