// db/postgres/search.js
// Hybrid/semantic/fulltext recall over `memories` and `self_memories`.
// Standalone functions taking `pool` explicitly, mirroring db/sqlite/search.js.

import { rowToMemory, rowToSelf, toVec } from './mappers.js';

export async function recallMemories(pool, { query, queryEmbedding, type, tags, limit = 10, mode = 'auto', lang = 'english', asOf = null, order = 'importance', maxTier = 3 }) {
  const useVector = !!queryEmbedding && mode !== 'fulltext';
  const useText   = !!query          && mode !== 'semantic';

  // Temporal filter — "current" by default, point-in-time when asOf is set.
  // asOf is pushed once as a parameter even though it appears twice in the SQL;
  // Postgres allows reusing $N in the same query.
  const buildTemporalFilter = (paramIdx) => {
    if (!asOf) return { sql: `valid_until IS NULL`, params: [], nextIdx: paramIdx };
    return {
      sql: `(valid_from <= $${paramIdx}::timestamptz AND (valid_until IS NULL OR valid_until > $${paramIdx}::timestamptz))`,
      params: [asOf],
      nextIdx: paramIdx + 1,
    };
  };

  // ── Hybrid path (RRF) ────────────────────────────────────────────────────
  if (useVector && useText) {
    // $1 = vector, $2 = query text; optional filters start at $3
    const params = [toVec(queryEmbedding), query];
    let idx = 3;

    const temporal = buildTemporalFilter(idx);
    idx = temporal.nextIdx;
    params.push(...temporal.params);

    const baseConditions = [
      `(expires_at IS NULL OR expires_at > now())`,
      temporal.sql,
    ];

    baseConditions.push(`tier <= $${idx++}`);
    params.push(maxTier);

    if (type)         { baseConditions.push(`type = $${idx++}`);  params.push(type); }
    if (tags?.length) { baseConditions.push(`tags && $${idx++}`); params.push(tags); }
    params.push(limit);

    const base = baseConditions.join(' AND ');
    const { rows } = await pool.query(`
      WITH vector_ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
        FROM memories
        WHERE ${base} AND embedding IS NOT NULL
        LIMIT 60
      ),
      fts_ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          ORDER BY ts_rank(search_vector,
                           plainto_tsquery('${lang}', $2)) DESC
        ) AS rank
        FROM memories
        WHERE ${base}
          AND search_vector @@ plainto_tsquery('${lang}', $2)
        LIMIT 60
      ),
      fused AS (
        SELECT
          COALESCE(v.id, f.id) AS id,
          COALESCE(1.0 / (60 + v.rank), 0.0)
            + COALESCE(1.0 / (60 + f.rank), 0.0) AS rrf_score
        FROM vector_ranked v
        FULL OUTER JOIN fts_ranked f ON v.id = f.id
      )
      SELECT m.*, fu.rrf_score
      FROM fused fu
      JOIN memories m ON m.id = fu.id
      ORDER BY fu.rrf_score DESC
      LIMIT $${idx}
    `, params);

    const maxRrf = Number.parseFloat(rows[0]?.rrf_score) || 1;
    return rows.map(r => ({ ...rowToMemory(r), similarity: Number.parseFloat(r.rrf_score) / maxRrf }));
  }

  // ── Semantic-only path ───────────────────────────────────────────────────
  if (useVector) {
    const params = [toVec(queryEmbedding)];
    let idx = 2;

    const temporal = buildTemporalFilter(idx);
    idx = temporal.nextIdx;
    params.push(...temporal.params);

    const conditions = [
      `(expires_at IS NULL OR expires_at > now())`,
      temporal.sql,
      `embedding IS NOT NULL`,
    ];

    conditions.push(`tier <= $${idx++}`);
    params.push(maxTier);

    if (type)         { conditions.push(`type = $${idx++}`);  params.push(type); }
    if (tags?.length) { conditions.push(`tags && $${idx++}`); params.push(tags); }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
       FROM memories
       WHERE ${conditions.join(' AND ')}
       ORDER BY embedding <=> $1::vector
       LIMIT $${idx}`,
      params
    );
    if (rows.length) {
      return rows.map(r => ({ ...rowToMemory(r), similarity: Number.parseFloat(r.similarity) }));
    }
  }

  // ── Fulltext-only path ───────────────────────────────────────────────────
  const params = [];
  let idx = 1;

  const temporal = buildTemporalFilter(idx);
  idx = temporal.nextIdx;
  params.push(...temporal.params);

  const conditions = [
    `(expires_at IS NULL OR expires_at > now())`,
    temporal.sql,
  ];

  conditions.push(`tier <= $${idx++}`);
  params.push(maxTier);

  if (type)         { conditions.push(`type = $${idx++}`);  params.push(type); }
  if (tags?.length) { conditions.push(`tags && $${idx++}`); params.push(tags); }
  let queryParamIdx = null;
  if (query) {
    queryParamIdx = idx;
    conditions.push(
      `search_vector @@ plainto_tsquery('${lang}', $${idx++})`
    );
    params.push(query);
  }
  params.push(limit);

  const selectScore = queryParamIdx !== null
    ? `, ts_rank(search_vector, plainto_tsquery('${lang}', $${queryParamIdx})) AS ts_score`
    : '';

  // Recency ordering only applies to the no-query listing; a fulltext query
  // keeps its relevance-then-importance order.
  const orderBy = (order === 'recent' && queryParamIdx === null)
    ? 'created_at DESC'
    : 'importance DESC, created_at DESC';
  const { rows } = await pool.query(
    `SELECT *${selectScore} FROM memories
     WHERE ${conditions.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT $${idx}`,
    params
  );

  if (queryParamIdx !== null) {
    const maxScore = Math.max(...rows.map(r => parseFloat(r.ts_score) || 0), 0.001);
    return rows.map(r => ({ ...rowToMemory(r), similarity: parseFloat(r.ts_score) / maxScore }));
  }
  return rows.map(r => ({ ...rowToMemory(r), similarity: r.confidence ?? 1.0 }));
}

export async function recallSelfMemories(pool, { query, queryEmbedding, tags, limit = 10, mode = 'auto', lang = 'english' }) {
  const useVector = !!queryEmbedding && mode !== 'fulltext';
  const useText   = !!query          && mode !== 'semantic';

  // ── Hybrid path (RRF) ──
  if (useVector && useText) {
    const params = [toVec(queryEmbedding), query];
    let idx = 3;
    const conds = [];
    if (tags?.length) { conds.push(`tags && $${idx++}`); params.push(tags); }
    const tagFilter = conds.length ? ` AND ${conds.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await pool.query(`
      WITH vector_ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
        FROM self_memories WHERE embedding IS NOT NULL${tagFilter}
        LIMIT 60
      ),
      fts_ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          ORDER BY ts_rank(search_vector, plainto_tsquery('${lang}', $2)) DESC
        ) AS rank
        FROM self_memories
        WHERE search_vector @@ plainto_tsquery('${lang}', $2)${tagFilter}
        LIMIT 60
      ),
      fused AS (
        SELECT COALESCE(v.id, f.id) AS id,
               COALESCE(1.0 / (60 + v.rank), 0.0) + COALESCE(1.0 / (60 + f.rank), 0.0) AS rrf_score
        FROM vector_ranked v FULL OUTER JOIN fts_ranked f ON v.id = f.id
      )
      SELECT m.*, fu.rrf_score FROM fused fu
      JOIN self_memories m ON m.id = fu.id
      ORDER BY fu.rrf_score DESC
      LIMIT $${idx}
    `, params);
    const maxRrf = Number.parseFloat(rows[0]?.rrf_score) || 1;
    return rows.map(r => ({ ...rowToSelf(r), similarity: Number.parseFloat(r.rrf_score) / maxRrf }));
  }

  // ── Semantic-only path ──
  if (useVector) {
    const params = [toVec(queryEmbedding)];
    let idx = 2;
    const conds = [`embedding IS NOT NULL`];
    if (tags?.length) { conds.push(`tags && $${idx++}`); params.push(tags); }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
       FROM self_memories
       WHERE ${conds.join(' AND ')}
       ORDER BY embedding <=> $1::vector
       LIMIT $${idx}`,
      params
    );
    if (rows.length) return rows.map(r => ({ ...rowToSelf(r), similarity: Number.parseFloat(r.similarity) }));
  }

  // ── Fulltext / list-by-importance path ──
  const params = [];
  let idx = 1;
  const conds = [];
  if (tags?.length) { conds.push(`tags && $${idx++}`); params.push(tags); }
  let queryParamIdx = null;
  if (query) {
    queryParamIdx = idx;
    conds.push(`search_vector @@ plainto_tsquery('${lang}', $${idx++})`);
    params.push(query);
  }
  params.push(limit);
  const selectScore = queryParamIdx !== null
    ? `, ts_rank(search_vector, plainto_tsquery('${lang}', $${queryParamIdx})) AS ts_score`
    : '';
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT *${selectScore} FROM self_memories
     ${where}
     ORDER BY importance DESC, created_at DESC
     LIMIT $${idx}`,
    params
  );
  if (queryParamIdx !== null) {
    const maxScore = Math.max(...rows.map(r => parseFloat(r.ts_score) || 0), 0.001);
    return rows.map(r => ({ ...rowToSelf(r), similarity: parseFloat(r.ts_score) / maxScore }));
  }
  return rows.map(r => ({ ...rowToSelf(r), similarity: r.confidence ?? 1.0 }));
}
