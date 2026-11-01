// db/postgres/selfMemories.js
// The agent's own walled-off memory store (Postgres half).
//
// Split out of db/postgres/store.js by S3.2 (aperio-reset) — the method bodies
// moved verbatim. self_memories is a SEPARATE table from `memories`: nothing
// here touches `memories` and nothing in store.js touches self_memories, which
// is exactly why this is a clean seam. The SQLite twin is
// db/sqlite/selfMemories.js; the shared contract is
// tests/integration/db/contract/self-memory.test.js.
import { isUuid, rowToSelf, toVec } from './mappers.js';
import { recallSelfMemories } from './search.js';

export const withSelfMemories = (Base) => class extends Base {
  // ── Self-memories (the agent's own walled-off store) ──────────────────────
  // A SEPARATE table from `memories`; none of the methods above touch it. No
  // versioning/expiry/pin — updates are in-place.
  async insertSelf(input, embedding) {
    const { rows } = await this.pool.query(
      `INSERT INTO self_memories (title, content, tags, importance, source, embedding, lang, confidence, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        input.title, input.content, input.tags ?? [], input.importance ?? 3,
        input.source ?? 'self', embedding ? toVec(embedding) : null,
        input.lang ?? 'english', input.confidence ?? 1.0,
        input.generated_by ?? null,
      ]
    );
    return rowToSelf(rows[0]);
  }

  async getSelfById(id) {
    if (!isUuid(id)) return null;
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
    if (!isUuid(id)) return;
    await this.pool.query(`UPDATE self_memories SET embedding = $1 WHERE id = $2`, [toVec(embedding), id]);
  }

  // Self-memories missing a vector — mirrors listWithoutEmbeddings() for the
  // user-facing `memories` table so initEmbeddings() can backfill this store
  // the same way. Without this, a provider/model change (or a dims resize)
  // that clears self_memories.embedding leaves self-memory search
  // permanently disabled — nothing else scans for and re-embeds these rows.
  async listSelfWithoutEmbeddings({ limit = null, offset = 0 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT id, title, content FROM self_memories WHERE embedding IS NULL
        ORDER BY id LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows;
  }

  async deleteSelf(id) {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query(
      `DELETE FROM self_memories WHERE id = $1 RETURNING title`, [id]
    );
    return rows[0]?.title ?? null;
  }

  async recallSelf(args) {
    return recallSelfMemories(this.pool, args);
  }
};
