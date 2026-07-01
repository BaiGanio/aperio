// db/postgres.js
// Power-user backend — requires Docker + pgvector.
// Matches migrations 001_init.sql + 002_pgvector.sql + 003_fts_lang.sql exactly.

import pg from 'pg';
import { runMigrations } from './migrate.js';
import { deserialiseRow } from './types.js';
import { DB_TABLES, isAllowedTable } from './tables.js';

// The example/default Postgres password shipped in .env.example. Connecting
// with it means the user never set a real one — refuse rather than run with a
// known-public credential. APERIO_ALLOW_DEFAULT_DB_PASSWORD=1 opts out for
// throwaway local dev.
const DEFAULT_DB_PASSWORD = 'aperio_secret';
export function assertNonDefaultDbUrl(url, allow = process.env.APERIO_ALLOW_DEFAULT_DB_PASSWORD) {
  if (allow === '1') return;
  if (typeof url === 'string' && url.includes(`:${DEFAULT_DB_PASSWORD}@`)) {
    throw new Error(
      'DATABASE_URL uses the example default Postgres password (aperio_secret). ' +
      'Set a real password in .env, or APERIO_ALLOW_DEFAULT_DB_PASSWORD=1 to override (local dev only).'
    );
  }
}

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

function rowToSelf(row) {
  // Self-memories have no type/pin/versioning — a lean shape distinct from
  // the user `memories` row.
  return {
    id:         row.id,
    title:      row.title,
    content:    row.content,
    tags:       Array.isArray(row.tags) ? row.tags : [],
    importance: row.importance,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    source:     row.source ?? 'self',
    lang:       row.lang ?? 'english',
    confidence: row.confidence ?? 1.0,
  };
}

export class PostgresStore {
  constructor(pool) {
    this.pool = pool;
  }

  static async init() {
    assertNonDefaultDbUrl(process.env.DATABASE_URL);
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await runMigrations(pool);
    return new PostgresStore(pool);
  }

  async counts() {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) AS total,
              COUNT(embedding) AS embedded,
              COUNT(*) FILTER (WHERE valid_until IS NULL AND (expires_at IS NULL OR expires_at > NOW())) AS current
         FROM memories`
    );
    return {
      total:    Number.parseInt(rows[0].total),
      embedded: Number.parseInt(rows[0].embedded),
      // recall-able rows (latest, unexpired) — what the UI shows, distinct from
      // `total` which also counts tombstoned/superseded versions.
      current:  Number.parseInt(rows[0].current),
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
       ORDER BY pinned DESC, importance DESC`
    );
    return rows.map(rowToMemory);
  }

  // ── Generic DB browser (whitelisted tables only) ─────────────────────────
  async listTables() {
    const out = [];
    for (const { name, label } of DB_TABLES) {
      // For memories, count what the UI actually shows: current, unexpired rows.
      const sql = name === 'memories'
        ? `SELECT COUNT(*)::int AS c FROM memories
            WHERE valid_until IS NULL AND (expires_at IS NULL OR expires_at > NOW())`
        : `SELECT COUNT(*)::int AS c FROM ${name}`;
      const { rows } = await this.pool.query(sql);
      out.push({ name, label, count: rows[0].c });
    }
    return out;
  }

  async readTable(name) {
    if (!isAllowedTable(name)) throw new Error(`Unknown table: ${name}`);
    const where = name === 'memories'
      ? ` WHERE valid_until IS NULL AND (expires_at IS NULL OR expires_at > NOW())` : '';
    const { rows, fields } = await this.pool.query(`SELECT * FROM ${name}${where}`);
    return { columns: fields.map(f => f.name), rows };
  }

  async setPin(id, pinned) {
    const { rows } = await this.pool.query(
      `UPDATE memories SET pinned = $1 WHERE id = $2 AND valid_until IS NULL RETURNING id`,
      [!!pinned, id]
    );
    return rows.length > 0;
  }

  async setExpiry(id, expiresAt) {
    const { rows } = await this.pool.query(
      `UPDATE memories SET expires_at = $1 WHERE id = $2 AND valid_until IS NULL RETURNING id`,
      [expiresAt ? new Date(expiresAt) : null, id]
    );
    return rows.length > 0;
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

    const { rows } = await this.pool.query(
      `SELECT *${selectScore} FROM memories
       WHERE ${conditions.join(' AND ')}
       ORDER BY importance DESC, created_at DESC
       LIMIT $${idx}`,
      params
    );

    if (queryParamIdx !== null) {
      const maxScore = Math.max(...rows.map(r => parseFloat(r.ts_score) || 0), 0.001);
      return rows.map(r => ({ ...rowToMemory(r), similarity: parseFloat(r.ts_score) / maxScore }));
    }
    return rows.map(r => ({ ...rowToMemory(r), similarity: r.confidence ?? 1.0 }));
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
    // Fold the duplicate's wiki citations into the survivor before it's deleted:
    // mark citing fresh articles stale, then re-point their sources from id_b to
    // id_a. Skip articles that already cite id_a (avoids a PK collision); those
    // leftover id_b rows cascade-delete with the memory below. Without this the
    // DELETE would silently cascade away id_b's source rows, leaving dangling
    // citations and no staleness signal.
    await this.pool.query(
      `UPDATE wiki_articles SET status = 'stale'
        WHERE status = 'fresh'
          AND id IN (SELECT article_id FROM wiki_article_sources WHERE memory_id = $1)`,
      [id_b]
    );
    await this.pool.query(
      `UPDATE wiki_article_sources SET memory_id = $1
        WHERE memory_id = $2
          AND article_id NOT IN (SELECT article_id FROM wiki_article_sources WHERE memory_id = $1)`,
      [id_a, id_b]
    );
    await this.pool.query(`DELETE FROM memories WHERE id = $1`, [id_b]);
  }

  async delete(id) {
    const { rows } = await this.pool.query(
      `DELETE FROM memories WHERE id = $1 RETURNING title`, [id]
    );
    return rows[0]?.title ?? null;
  }

  // ── Self-memories (the agent's own walled-off store) ──────────────────────
  // A SEPARATE table from `memories`; none of the methods above touch it. No
  // versioning/expiry/pin — updates are in-place.
  async insertSelf(input, embedding) {
    const { rows } = await this.pool.query(
      `INSERT INTO self_memories (title, content, tags, importance, source, embedding, lang, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        input.title, input.content, input.tags ?? [], input.importance ?? 3,
        input.source ?? 'self', embedding ? toVec(embedding) : null,
        input.lang ?? 'english', input.confidence ?? 1.0,
      ]
    );
    return rowToSelf(rows[0]);
  }

  async getSelfById(id) {
    const { rows } = await this.pool.query(`SELECT * FROM self_memories WHERE id = $1`, [id]);
    return rows.length ? rowToSelf(rows[0]) : null;
  }

  async listSelf(limit = 50) {
    const { rows } = await this.pool.query(
      `SELECT * FROM self_memories ORDER BY importance DESC, created_at DESC LIMIT $1`,
      [Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]
    );
    return rows.map(rowToSelf);
  }

  async updateSelf(id, input, embedding) {
    const existing = await this.getSelfById(id);
    if (!existing) throw new Error(`Self-memory ${id} not found`);
    const merged = {
      title:      input.title      ?? existing.title,
      content:    input.content    ?? existing.content,
      tags:       input.tags       ?? existing.tags,
      importance: input.importance ?? existing.importance,
      confidence: input.confidence ?? existing.confidence,
    };
    const { rows } = await this.pool.query(
      `UPDATE self_memories
          SET title = $1, content = $2, tags = $3, importance = $4, confidence = $5
              ${embedding ? ', embedding = $7' : ''}
        WHERE id = $6
        RETURNING *`,
      embedding
        ? [merged.title, merged.content, merged.tags, merged.importance, merged.confidence, id, toVec(embedding)]
        : [merged.title, merged.content, merged.tags, merged.importance, merged.confidence, id]
    );
    return rowToSelf(rows[0]);
  }

  async setSelfEmbedding(id, embedding) {
    await this.pool.query(`UPDATE self_memories SET embedding = $1 WHERE id = $2`, [toVec(embedding), id]);
  }

  async deleteSelf(id) {
    const { rows } = await this.pool.query(
      `DELETE FROM self_memories WHERE id = $1 RETURNING title`, [id]
    );
    return rows[0]?.title ?? null;
  }

  async recallSelf({ query, queryEmbedding, tags, limit = 10, mode = 'auto', lang = 'english' }) {
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
      const { rows } = await this.pool.query(`
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
      const { rows } = await this.pool.query(
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
    const { rows } = await this.pool.query(
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

  // ── Settings (key/value preferences) ──────────────────────────────────────
  // value is JSONB; pg parses it back to a JS value on read.

  async clearAllEmbeddings() {
    await this.pool.query(`UPDATE memories SET embedding = NULL`);
    await this.pool.query(`UPDATE wiki_articles SET embedding = NULL`);
  }

  async getSetting(key) {
    const { rows } = await this.pool.query(
      `SELECT value FROM settings WHERE key = $1`, [key]
    );
    return rows.length ? rows[0].value : null;
  }

  async setSetting(key, value) {
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
    return value;
  }

  async getSettings() {
    const { rows } = await this.pool.query(`SELECT key, value FROM settings`);
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }

  async deleteSetting(key) {
    const { rows } = await this.pool.query(
      `DELETE FROM settings WHERE key = $1 RETURNING key`, [key]
    );
    return rows.length > 0;
  }

  // ── Background-agent jobs + run history (Phase 4) ─────────────────────────
  // definition is JSONB; pg parses it back to a JS object on read. _rowToJob
  // re-merges id/enabled into the flat object the scheduler and API expect.
  _rowToJob(row) {
    if (!row) return null;
    return { id: row.id, enabled: row.enabled, ...row.definition, created_at: row.created_at, updated_at: row.updated_at };
  }

  async listAgentJobs() {
    const { rows } = await this.pool.query(`SELECT * FROM agent_jobs ORDER BY id`);
    return rows.map(r => this._rowToJob(r));
  }

  async getAgentJob(id) {
    const { rows } = await this.pool.query(`SELECT * FROM agent_jobs WHERE id = $1`, [id]);
    return this._rowToJob(rows[0]);
  }

  async upsertAgentJob(job) {
    const { id, enabled = true, created_at, updated_at, ...definition } = job;
    if (!id) throw new Error("agent job requires an id");
    await this.pool.query(
      `INSERT INTO agent_jobs (id, enabled, definition, updated_at)
         VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (id) DO UPDATE
         SET enabled = EXCLUDED.enabled, definition = EXCLUDED.definition, updated_at = now()`,
      [id, !!enabled, JSON.stringify(definition)]
    );
    return this.getAgentJob(id);
  }

  async deleteAgentJob(id) {
    const { rows } = await this.pool.query(`DELETE FROM agent_jobs WHERE id = $1 RETURNING id`, [id]);
    return rows.length > 0;
  }

  async recordAgentRun(run) {
    const { rows } = await this.pool.query(
      `INSERT INTO agent_runs
         (job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, model, error, tools, answer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING id`,
      [
        run.jobId, run.startedAt, run.finishedAt ?? null, run.durationMs ?? null,
        run.verdict, run.mode ?? null, run.trigger ?? null, run.model ?? null, run.error ?? null,
        run.tools != null ? JSON.stringify(run.tools) : null, run.answer ?? null,
      ]
    );
    return rows[0].id;
  }

  async listAgentRuns(jobId, limit = 20) {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_runs WHERE job_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2`,
      [jobId, limit]
    );
    return rows;
  }

  // Delete one run by id (manual cleanup from the History view). Returns true
  // when a row was removed.
  async deleteAgentRun(runId) {
    const { rowCount } = await this.pool.query(`DELETE FROM agent_runs WHERE id = $1`, [runId]);
    return rowCount > 0;
  }

  // Garbage-collect runs older than `retentionDays` (the run-history sibling of
  // pruneOldSessions). started_at is an ISO-8601 string. Returns the count removed.
  async pruneAgentRuns(retentionDays) {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const { rowCount } = await this.pool.query(`DELETE FROM agent_runs WHERE started_at < $1`, [cutoff]);
    return rowCount;
  }

  // ── Issue-triage ledger ───────────────────────────────────────────────────
  // updatedAt is GitHub's issue.updated_at and is the dedup key: when it changes
  // the row is reset to pending (triaged_at = NULL) so the issue is re-triaged.
  // IS NOT DISTINCT FROM is null-safe equality.
  async upsertIssue({ repo, number, title, state, updatedAt }) {
    await this.pool.query(
      `INSERT INTO issue_triage (repo, issue_number, title, state, updated_at)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (repo, issue_number) DO UPDATE SET
         title      = EXCLUDED.title,
         state      = EXCLUDED.state,
         triaged_at = CASE WHEN issue_triage.updated_at IS NOT DISTINCT FROM EXCLUDED.updated_at
                           THEN issue_triage.triaged_at ELSE NULL END,
         updated_at = EXCLUDED.updated_at`,
      [repo, number, title ?? null, state ?? null, updatedAt ?? null]
    );
  }

  async listPendingIssues(repo) {
    const { rows } = repo
      ? await this.pool.query(
          `SELECT * FROM issue_triage WHERE triaged_at IS NULL AND repo = $1 ORDER BY updated_at`,
          [repo])
      : await this.pool.query(
          `SELECT * FROM issue_triage WHERE triaged_at IS NULL ORDER BY updated_at`);
    return rows;
  }

  async markTriaged({ repo, number, priority, verdict, runId }) {
    await this.pool.query(
      `UPDATE issue_triage
          SET triaged_at = now(), priority = $1, verdict = $2, run_id = $3
        WHERE repo = $4 AND issue_number = $5`,
      [priority ?? null, verdict ?? null, runId ?? null, repo, number]
    );
  }

  // ── Data portability (export / import) ─────────────────────────────────────

  async exportAll() {
    const { rows: memories } = await this.pool.query(`
      SELECT id, type, title, content, tags, importance,
             expires_at, source, pinned, lang, confidence
        FROM memories
       WHERE valid_until IS NULL
       ORDER BY pinned DESC, importance DESC
    `);

    const { rows: articles } = await this.pool.query(`
      SELECT a.slug, a.title, a.summary, a.body_md, a.tags,
             a.generated_by, a.revision,
             COALESCE(json_agg(s.memory_id) FILTER (WHERE s.memory_id IS NOT NULL), '[]'::json) AS source_memory_ids
        FROM wiki_articles a
        LEFT JOIN wiki_article_sources s ON s.article_id = a.id
       WHERE a.status != 'archived'
       GROUP BY a.id, a.slug, a.title, a.summary, a.body_md, a.tags, a.generated_by, a.revision, a.generated_at
       ORDER BY a.generated_at DESC
    `);

    // ── Agent jobs + recent runs ─────────────────────────────────
    const { rows: agentRows } = await this.pool.query(
      `SELECT * FROM agent_jobs ORDER BY updated_at DESC`
    );
    const agent_jobs = agentRows.map(r => {
      const def = r.definition ? (typeof r.definition === 'string' ? JSON.parse(r.definition) : r.definition) : {};
      return { id: r.id, enabled: !!r.enabled, ...def, created_at: r.created_at, updated_at: r.updated_at };
    });

    const getRuns = await this.pool.query(
      `SELECT job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, model, error, tools, answer
         FROM agent_runs
        WHERE job_id = ANY($1)
        ORDER BY job_id, started_at DESC`, [agentRows.map(r => r.id)]
    );
    // Limit to 10 most recent per job
    const runsByJob = {};
    for (const r of getRuns.rows) {
      if (!runsByJob[r.job_id]) runsByJob[r.job_id] = [];
      if (runsByJob[r.job_id].length < 10) runsByJob[r.job_id].push(r);
    }
    const agent_runs = Object.values(runsByJob).flat();

    return {
      memories: memories.map(m => ({
        id:         m.id,
        type:       m.type,
        title:      m.title,
        content:    m.content,
        tags:       m.tags || [],
        importance: Number(m.importance),
        expires_at: m.expires_at,
        source:     m.source,
        pinned:     m.pinned,
        lang:       m.lang ?? 'english',
        confidence: m.confidence !== null ? Number(m.confidence) : 1.0,
      })),
      wiki_articles: articles.map(a => ({
        slug:              a.slug,
        title:             a.title,
        summary:           a.summary,
        body_md:           a.body_md,
        tags:              a.tags || [],
        generated_by:      a.generated_by,
        revision:          a.revision,
        source_memory_ids: a.source_memory_ids || [],
      })),
      agent_jobs,
      agent_runs,
    };
  }

  async importAll({ memories = [], wiki_articles = [], agent_jobs = [], agent_runs = [] }) {
    const result = {
      imported: { memories: 0, wiki: 0, jobs: 0, runs: 0 },
      skipped:  { memories: 0, wiki: 0, jobs: 0, runs: 0 },
    };

    for (const m of memories) {
      const { rowCount } = await this.pool.query(`
        INSERT INTO memories (id, type, title, content, tags, importance, expires_at, source, pinned, lang, confidence, valid_from)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
        ON CONFLICT (id) DO NOTHING
      `, [m.id, m.type, m.title, m.content, m.tags ?? [],
          m.importance ?? 3, m.expires_at ?? null, m.source ?? 'import',
          m.pinned ?? false, m.lang ?? 'english', m.confidence ?? 1.0]);
      rowCount > 0 ? result.imported.memories++ : result.skipped.memories++;
    }

    for (const a of wiki_articles) {
      const { rowCount } = await this.pool.query(`
        INSERT INTO wiki_articles (slug, title, summary, body_md, tags, generated_by, revision)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (slug) DO NOTHING
        RETURNING id
      `, [a.slug, a.title, a.summary ?? null, a.body_md,
          a.tags ?? [], a.generated_by ?? 'import', a.revision ?? 1]);

      if (rowCount > 0) {
        result.imported.wiki++;
        if (a.source_memory_ids?.length) {
          const wikiId = (await this.pool.query(`SELECT id FROM wiki_articles WHERE slug = $1`, [a.slug])).rows[0]?.id;
          if (wikiId) {
            for (const memId of a.source_memory_ids) {
              try {
                await this.pool.query(
                  `INSERT INTO wiki_article_sources (article_id, memory_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                  [wikiId, memId]
                );
              } catch { /* memory may not exist */ }
            }
          }
        }
      } else {
        result.skipped.wiki++;
      }
    }

    // ── Agent jobs ───────────────────────────────────────────────
    for (const j of agent_jobs) {
      const def = { ...j };
      delete def.id; delete def.enabled; delete def.created_at; delete def.updated_at;
      const { rowCount } = await this.pool.query(`
        INSERT INTO agent_jobs (id, enabled, definition, updated_at)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (id) DO NOTHING
      `, [j.id, j.enabled ? true : false, JSON.stringify(def), j.updated_at ?? new Date().toISOString()]);
      rowCount > 0 ? result.imported.jobs++ : result.skipped.jobs++;
    }

    // ── Agent runs (dedup by job_id + started_at) ────────────────
    for (const r of agent_runs) {
      const { rowCount } = await this.pool.query(`
        INSERT INTO agent_runs (job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, model, error, tools, answer)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT DO NOTHING
      `, [r.job_id, r.started_at, r.finished_at ?? null, r.duration_ms ?? null,
          r.verdict ?? null, r.mode ?? null, r.trigger ?? null, r.model ?? null,
          r.error ?? null, r.tools ?? null, r.answer ?? null]);
      rowCount > 0 ? result.imported.runs++ : result.skipped.runs++;
    }

    return result;
  }

  async close() {
    await this.pool.end();
  }
}