// db/postgres.js
// Power-user backend — requires Docker + pgvector.
// Matches migrations 001_init.sql + 002_pgvector.sql exactly.

import pg from 'pg';

function toVec(embedding) {
  return `[${embedding.join(',')}]`;
}

function rowToMemory(row) {
  return {
    id:         row.id,
    type:       row.type,
    title:      row.title,
    content:    row.content,
    tags:       row.tags ?? [],
    importance: row.importance,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    expires_at: row.expires_at ? new Date(row.expires_at) : undefined,
    source:     row.source ?? 'manual',
  };
}

export class PostgresStore {
  constructor(pool) {
    this.pool = pool;
  }

  static async init() {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    client.release();
    return new PostgresStore(pool);
  }

  async counts() {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) AS total, COUNT(embedding) AS embedded FROM memories`
    );
    return {
      total:    parseInt(rows[0].total),
      embedded: parseInt(rows[0].embedded),
    };
  }

  async insert(input, embedding) {
    const { rows } = await this.pool.query(
      `INSERT INTO memories
         (type, title, content, tags, importance, expires_at, source, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        input.type, input.title, input.content,
        input.tags ?? [], input.importance ?? 3,
        input.expires_at ?? null, input.source ?? 'manual',
        embedding ? toVec(embedding) : null,
      ]
    );
    return rowToMemory(rows[0]);
  }

  async getById(id) {
    const { rows } = await this.pool.query(
      `SELECT * FROM memories WHERE id = $1`, [id]
    );
    return rows.length ? rowToMemory(rows[0]) : null;
  }

  async update(id, input, embedding) {
    const sets = [], params = [];
    let idx = 1;

    for (const f of ['type','title','content','tags','importance','expires_at','source']) {
      if (input[f] !== undefined) { sets.push(`${f} = $${idx++}`); params.push(input[f]); }
    }
    if (embedding !== undefined) {
      sets.push(`embedding = $${idx++}`);
      params.push(embedding ? toVec(embedding) : null);
    }
    if (!sets.length) {
      const existing = await this.getById(id);
      if (!existing) throw new Error(`Memory ${id} not found`);
      return existing;
    }
    params.push(id);
    const { rows } = await this.pool.query(
      `UPDATE memories SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return rowToMemory(rows[0]);
  }

  async setEmbedding(id, embedding) {
    await this.pool.query(
      `UPDATE memories SET embedding = $1 WHERE id = $2`,
      [toVec(embedding), id]
    );
  }

  async recall({ query, queryEmbedding, type, tags, limit = 10, mode = 'auto' }) {
    const useVector = queryEmbedding && (mode === 'semantic' || mode === 'auto');

    // ── Semantic path ────────────────────────────────────────────────────────
    if (useVector) {
      const conditions = [
        `(expires_at IS NULL OR expires_at > now())`,
        `embedding IS NOT NULL`,
      ];
      const params = [toVec(queryEmbedding)];
      let idx = 2;

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
        return rows.map(r => ({ ...rowToMemory(r), similarity: parseFloat(r.similarity) }));
      }
    }

    // ── Fulltext fallback ────────────────────────────────────────────────────
    const conditions = [`(expires_at IS NULL OR expires_at > now())`];
    const params = [];
    let idx = 1;

    if (type)         { conditions.push(`type = $${idx++}`);  params.push(type); }
    if (tags?.length) { conditions.push(`tags && $${idx++}`); params.push(tags); }
    if (query) {
      conditions.push(
        `to_tsvector('english', title || ' ' || content) @@ plainto_tsquery('english', $${idx++})`
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
      `SELECT id, title, content FROM memories WHERE embedding IS NULL`
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
         AND 1 - (a.embedding <=> b.embedding) >= $1
       ORDER BY similarity DESC
       LIMIT 20`,
      [threshold]
    );
    return rows.map(r => ({ ...r, similarity: parseFloat(r.similarity) }));
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