// db/postgres.js
// Power-user backend — requires Docker + pgvector.
// Matches migrations 001_init.sql + 002_pgvector.sql + 003_fts_lang.sql exactly.

import pg from 'pg';
import { runMigrations } from './migrate.js';
import { deserialiseRow } from './types.js';

// Maps locale codes to PostgreSQL text-search config names.
// Languages without a native pg config fall back to 'simple' (no stemming,
// but tokenises correctly for any script).
export const LOCALE_TO_PG_CONFIG = {
  en: 'english', de: 'german',  fr: 'french',  es: 'spanish',
  it: 'italian', nl: 'dutch',   da: 'danish',  fi: 'finnish',
  pt: 'portuguese', sv: 'swedish',
  // no native pg config — use language-agnostic tokeniser
  bg: 'simple', cs: 'simple', pl: 'simple', sk: 'simple', sl: 'simple',
};

export function localeToPgConfig(locale) {
  return LOCALE_TO_PG_CONFIG[locale] ?? 'english';
}

function toVec(embedding) {
  return `[${embedding.join(',')}]`;
}

function rowToMemory(row) {
  return { ...deserialiseRow(row), lang: row.lang ?? 'english' };
}

export class PostgresStore {
  constructor(pool) {
    this.pool = pool;
  }

  static async init() {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await runMigrations(pool);
    return new PostgresStore(pool);
  }

  async counts() {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) AS total, COUNT(embedding) AS embedded FROM memories`
    );
    return {
      total:    Number.parseInt(rows[0].total),
      embedded: Number.parseInt(rows[0].embedded),
    };
  }

  async insert(input, embedding) {
    const { rows } = await this.pool.query(
      `INSERT INTO memories
         (type, title, content, tags, importance, expires_at, source, embedding, lang, confidence, valid_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       RETURNING *`,
      [
        input.type, input.title, input.content,
        input.tags ?? [], input.importance ?? 3,
        input.expires_at ?? null, input.source ?? 'manual',
        embedding ? toVec(embedding) : null,
        input.lang ?? 'english',
        input.confidence ?? 1.0,
      ]
    );
    return rowToMemory(rows[0]);
  }

  async bulkInsert(inputs) {
    if (!inputs.length) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const input of inputs) {
        const { rows } = await client.query(
          `INSERT INTO memories
             (type, title, content, tags, importance, expires_at, source, confidence, valid_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
           RETURNING *`,
          [
            input.type, input.title, input.content,
            input.tags ?? [], input.importance ?? 3,
            input.expires_at ?? null, input.source ?? 'import',
            input.confidence ?? 1.0,
          ]
        );
        results.push(rowToMemory(rows[0]));
      }
      await client.query('COMMIT');
      return results;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getById(id) {
    const { rows } = await this.pool.query(
      `SELECT * FROM memories WHERE id = $1`, [id]
    );
    return rows.length ? rowToMemory(rows[0]) : null;
  }

  async update(id, input, embedding) {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Memory ${id} not found`);
    if (existing.valid_until) throw new Error(`Memory ${id} has been superseded`);

    const merged = {
      type:       input.type       ?? existing.type,
      title:      input.title      ?? existing.title,
      content:    input.content    ?? existing.content,
      tags:       input.tags       ?? existing.tags,
      importance: input.importance ?? existing.importance,
      expires_at: existing.expires_at ?? null,
      source:     existing.source,
      lang:       existing.lang,
      confidence: input.confidence ?? existing.confidence,
    };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE memories SET valid_until = now() WHERE id = $1`, [id]
      );
      const { rows } = await client.query(
        `INSERT INTO memories
           (type, title, content, tags, importance, expires_at, source, embedding, lang, confidence, valid_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         RETURNING *`,
        [
          merged.type, merged.title, merged.content,
          merged.tags, merged.importance,
          merged.expires_at, merged.source,
          embedding ? toVec(embedding) : null,
          merged.lang, merged.confidence,
        ]
      );
      await client.query('COMMIT');
      return rowToMemory(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async setEmbedding(id, embedding) {
    await this.pool.query(
      `UPDATE memories SET embedding = $1 WHERE id = $2`,
      [toVec(embedding), id]
    );
  }

  async listAll() {
    const { rows } = await this.pool.query(
      `SELECT * FROM memories
       WHERE valid_until IS NULL AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY importance DESC`
    );
    return rows.map(rowToMemory);
  }

  async recall({ query, queryEmbedding, type, tags, limit = 10, mode = 'auto', lang = 'english', asOf = null }) {
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

      if (type)         { baseConditions.push(`type = $${idx++}`);  params.push(type); }
      if (tags?.length) { baseConditions.push(`tags && $${idx++}`); params.push(tags); }
      params.push(limit);

      const base = baseConditions.join(' AND ');
      const { rows } = await this.pool.query(`
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

      return rows.map(r => ({ ...rowToMemory(r), similarity: Number.parseFloat(r.rrf_score) }));
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

      if (type)         { conditions.push(`type = $${idx++}`);  params.push(type); }
      if (tags?.length) { conditions.push(`tags && $${idx++}`); params.push(tags); }
      params.push(limit);

      const { rows } = await this.pool.query(
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

    if (type)         { conditions.push(`type = $${idx++}`);  params.push(type); }
    if (tags?.length) { conditions.push(`tags && $${idx++}`); params.push(tags); }
    if (query) {
      conditions.push(
        `search_vector @@ plainto_tsquery('${lang}', $${idx++})`
      );
      params.push(query);
    }
    params.push(limit);

    const { rows } = await this.pool.query(
      `SELECT * FROM memories
       WHERE ${conditions.join(' AND ')}
       ORDER BY importance DESC, created_at DESC
       LIMIT $${idx}`,
      params
    );
    return rows.map(rowToMemory);
  }

  async listWithoutEmbeddings() {
    const { rows } = await this.pool.query(
      `SELECT id, title, content FROM memories WHERE embedding IS NULL AND valid_until IS NULL`
    );
    return rows;
  }

  async findDuplicates(threshold) {
    const { rows } = await this.pool.query(
      `SELECT
         a.id AS id_a, a.title AS title_a, a.type AS type_a,
         b.id AS id_b, b.title AS title_b, b.type AS type_b,
         1 - (a.embedding <=> b.embedding) AS similarity
       FROM memories a
       JOIN memories b ON a.id < b.id
       WHERE a.embedding IS NOT NULL
         AND b.embedding IS NOT NULL
         AND a.valid_until IS NULL
         AND b.valid_until IS NULL
         AND 1 - (a.embedding <=> b.embedding) >= $1
       ORDER BY similarity DESC
       LIMIT 20`,
      [threshold]
    );
    return rows.map(r => ({ ...r, similarity: Number.parseFloat(r.similarity) }));
  }

  async mergeDuplicate(id_a, id_b) {
    const { rows } = await this.pool.query(
      `SELECT id, content FROM memories WHERE id = ANY($1)`, [[id_a, id_b]]
    );
    const a = rows.find(r => r.id === id_a);
    const b = rows.find(r => r.id === id_b);
    if (a && b && !a.content.includes(b.content.slice(0, 40))) {
      await this.pool.query(
        `UPDATE memories SET content = content || ' | ' || $1 WHERE id = $2`,
        [b.content, id_a]
      );
    }
    await this.pool.query(`DELETE FROM memories WHERE id = $1`, [id_b]);
  }

  async delete(id) {
    const { rows } = await this.pool.query(
      `DELETE FROM memories WHERE id = $1 RETURNING title`, [id]
    );
    return rows[0]?.title ?? null;
  }

  async close() {
    await this.pool.end();
  }
}