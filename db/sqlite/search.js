// db/sqlite/search.js
// Hybrid/semantic/fulltext recall over `memories` and `self_memories`.
// Extracted as standalone functions taking `db` explicitly (rather than
// methods) since they only ever touch the db handle, never store.cache.

import { ftsMatchQuery, nowIso, rowToMemory, rowToSelf, vecBuf } from './mappers.js';

export async function recallMemories(db, { query, queryEmbedding, type, tags, limit = 10, mode = 'auto', asOf = null, order = 'importance', maxTier = 3 }) {
  const ftsQuery  = ftsMatchQuery(query);
  const useVector = !!queryEmbedding && mode !== 'fulltext';
  const useText   = !!ftsQuery       && mode !== 'semantic';
  const cap       = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);

  // Temporal + base filter as a SQL fragment.
  const baseConds = [`(m.expires_at IS NULL OR m.expires_at > @now)`, `m.tier <= @maxTier`];
  const baseParams = { now: nowIso(), maxTier };
  if (asOf) {
    baseConds.push(`(m.valid_from <= @asof AND (m.valid_until IS NULL OR m.valid_until > @asof))`);
    baseParams.asof = asOf;
  } else {
    baseConds.push(`m.valid_until IS NULL`);
  }
  if (type) { baseConds.push(`m.type = @type`); baseParams.type = type; }
  if (tags?.length) {
    // Tags is JSON array; require *any* match (matches Postgres `tags && $`).
    baseConds.push(`EXISTS (
      SELECT 1 FROM json_each(m.tags) je
       WHERE je.value IN (${tags.map((_, i) => `@t${i}`).join(', ')})
    )`);
    tags.forEach((t, i) => { baseParams[`t${i}`] = t; });
  }
  const where = baseConds.join(' AND ');

  if (useVector && useText) {
    const rows = db.prepare(`
      WITH vector_ranked AS (
        SELECT v.rowid AS rid, ROW_NUMBER() OVER (ORDER BY v.distance) AS rank
          FROM vec_memories v
          JOIN memories m ON m.rowid = v.rowid
         WHERE v.embedding MATCH @vec AND k = 60 AND ${where}
      ),
      fts_ranked AS (
        SELECT f.rowid AS rid, ROW_NUMBER() OVER (ORDER BY f.rank) AS rank
          FROM memories_fts f
          JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH @q AND ${where}
         LIMIT 60
      ),
      fused AS (
        SELECT COALESCE(v.rid, f.rid) AS rid,
               COALESCE(1.0/(60+v.rank), 0.0) + COALESCE(1.0/(60+f.rank), 0.0) AS rrf
          FROM vector_ranked v
          LEFT JOIN fts_ranked f ON v.rid = f.rid
        UNION
        SELECT COALESCE(v.rid, f.rid) AS rid,
               COALESCE(1.0/(60+v.rank), 0.0) + COALESCE(1.0/(60+f.rank), 0.0) AS rrf
          FROM fts_ranked f
          LEFT JOIN vector_ranked v ON v.rid = f.rid
      )
      SELECT m.*, MAX(fu.rrf) AS rrf_score
        FROM fused fu
        JOIN memories m ON m.rowid = fu.rid
       GROUP BY m.id
       ORDER BY rrf_score DESC
       LIMIT @cap
    `).all({ ...baseParams, vec: vecBuf(queryEmbedding), q: ftsQuery, cap });
    const maxRrf = Number(rows[0]?.rrf_score) || 1;
    return rows.map(r => ({ ...rowToMemory(r), similarity: Number(r.rrf_score) / maxRrf }));
  }

  if (useVector) {
    const rows = db.prepare(`
      SELECT m.*, (1.0 - v.distance) AS similarity
        FROM vec_memories v
        JOIN memories m ON m.rowid = v.rowid
       WHERE v.embedding MATCH @vec AND k = @cap AND ${where}
       ORDER BY similarity DESC
    `).all({ ...baseParams, vec: vecBuf(queryEmbedding), cap });
    if (rows.length) return rows.map(r => ({ ...rowToMemory(r), similarity: Number(r.similarity) }));
    // Fall through to fulltext if vector returned nothing AND there's a query.
  }

  if (useText) {
    const rows = db.prepare(`
      SELECT m.*, (-f.rank) AS ts_score
        FROM memories_fts f
        JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH @q AND ${where}
       ORDER BY ts_score DESC
       LIMIT @cap
    `).all({ ...baseParams, q: ftsQuery, cap });
    const maxScore = Math.max(...rows.map(r => Number(r.ts_score) || 0), 0.001);
    return rows.map(r => ({ ...rowToMemory(r), similarity: Number(r.ts_score) / maxScore }));
  }

  // No query at all → list by importance (default) or recency, like Postgres.
  const orderBy = order === 'recent'
    ? 'm.created_at DESC'
    : 'm.importance DESC, m.created_at DESC';
  const rows = db.prepare(`
    SELECT m.* FROM memories m
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT @cap
  `).all({ ...baseParams, cap });
  return rows.map(r => ({ ...rowToMemory(r), similarity: r.confidence ?? 1.0 }));
}

export async function recallSelfMemories(db, { query, queryEmbedding, tags, limit = 10, mode = 'auto' }) {
  const ftsQuery  = ftsMatchQuery(query);
  const useVector = !!queryEmbedding && mode !== 'fulltext';
  const useText   = !!ftsQuery       && mode !== 'semantic';
  const cap       = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);

  const conds = [];
  const baseParams = {};
  if (tags?.length) {
    conds.push(`EXISTS (
      SELECT 1 FROM json_each(m.tags) je
       WHERE je.value IN (${tags.map((_, i) => `@t${i}`).join(', ')})
    )`);
    tags.forEach((t, i) => { baseParams[`t${i}`] = t; });
  }
  const where = conds.length ? conds.join(' AND ') : '1=1';

  if (useVector && useText) {
    const rows = db.prepare(`
      WITH vector_ranked AS (
        SELECT v.rowid AS rid, ROW_NUMBER() OVER (ORDER BY v.distance) AS rank
          FROM vec_self_memories v
          JOIN self_memories m ON m.rowid = v.rowid
         WHERE v.embedding MATCH @vec AND k = 60 AND ${where}
      ),
      fts_ranked AS (
        SELECT f.rowid AS rid, ROW_NUMBER() OVER (ORDER BY f.rank) AS rank
          FROM self_memories_fts f
          JOIN self_memories m ON m.rowid = f.rowid
         WHERE self_memories_fts MATCH @q AND ${where}
         LIMIT 60
      ),
      fused AS (
        SELECT COALESCE(v.rid, f.rid) AS rid,
               COALESCE(1.0/(60+v.rank), 0.0) + COALESCE(1.0/(60+f.rank), 0.0) AS rrf
          FROM vector_ranked v
          LEFT JOIN fts_ranked f ON v.rid = f.rid
        UNION
        SELECT COALESCE(v.rid, f.rid) AS rid,
               COALESCE(1.0/(60+v.rank), 0.0) + COALESCE(1.0/(60+f.rank), 0.0) AS rrf
          FROM fts_ranked f
          LEFT JOIN vector_ranked v ON v.rid = f.rid
      )
      SELECT m.*, MAX(fu.rrf) AS rrf_score
        FROM fused fu
        JOIN self_memories m ON m.rowid = fu.rid
       GROUP BY m.id
       ORDER BY rrf_score DESC
       LIMIT @cap
    `).all({ ...baseParams, vec: vecBuf(queryEmbedding), q: ftsQuery, cap });
    const maxRrf = Number(rows[0]?.rrf_score) || 1;
    return rows.map(r => ({ ...rowToSelf(r), similarity: Number(r.rrf_score) / maxRrf }));
  }

  if (useVector) {
    const rows = db.prepare(`
      SELECT m.*, (1.0 - v.distance) AS similarity
        FROM vec_self_memories v
        JOIN self_memories m ON m.rowid = v.rowid
       WHERE v.embedding MATCH @vec AND k = @cap AND ${where}
       ORDER BY similarity DESC
    `).all({ ...baseParams, vec: vecBuf(queryEmbedding), cap });
    if (rows.length) return rows.map(r => ({ ...rowToSelf(r), similarity: Number(r.similarity) }));
  }

  if (useText) {
    const rows = db.prepare(`
      SELECT m.*, (-f.rank) AS ts_score
        FROM self_memories_fts f
        JOIN self_memories m ON m.rowid = f.rowid
       WHERE self_memories_fts MATCH @q AND ${where}
       ORDER BY ts_score DESC
       LIMIT @cap
    `).all({ ...baseParams, q: ftsQuery, cap });
    const maxScore = Math.max(...rows.map(r => Number(r.ts_score) || 0), 0.001);
    return rows.map(r => ({ ...rowToSelf(r), similarity: Number(r.ts_score) / maxScore }));
  }

  // No query → list by importance (this is the preload path).
  const rows = db.prepare(`
    SELECT m.* FROM self_memories m
     WHERE ${where}
     ORDER BY m.importance DESC, m.created_at DESC
     LIMIT @cap
  `).all({ ...baseParams, cap });
  return rows.map(r => ({ ...rowToSelf(r), similarity: r.confidence ?? 1.0 }));
}
