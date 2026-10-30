// db/sqlite/selfMemories.js
// The agent's own walled-off memory store (SQLite half).
//
// Split out of db/sqlite/store.js by S3.2 (aperio-reset) — the method bodies
// moved verbatim. self_memories is a SEPARATE table from `memories`: nothing
// here touches `memories` and nothing in store.js touches self_memories, which
// is exactly why this is a clean seam. The Postgres twin is
// db/postgres/selfMemories.js; the shared contract is
// tests/integration/db/contract/self-memory.test.js.
import { randomUUID } from 'node:crypto';
import { recallSelfMemories } from './search.js';
import { rowToSelf, vecBuf } from './mappers.js';

export const withSelfMemories = (Base) => class extends Base {
  // ── Self-memories (the agent's own walled-off store) ──────────────────────
  // A SEPARATE table from `memories`; none of the methods above touch it and
  // none below touch `memories`. No versioning/expiry/pin — updates are
  // in-place. The vec sidecar (vec_self_memories) is kept in sync by hand on
  // insert/update/setEmbedding; the FTS5 index is maintained by triggers.
  async insertSelf(input, embedding) {
    const id = randomUUID();
    const tx = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO self_memories (id, title, content, tags, importance, source, lang, confidence, generated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.title, input.content,
        JSON.stringify(input.tags ?? []),
        input.importance ?? 3,
        input.source ?? 'self',
        input.lang ?? 'english',
        input.confidence ?? 1.0,
        input.generated_by ?? null,
      );
      if (embedding) {
        this.db.prepare(`INSERT INTO vec_self_memories (rowid, embedding) VALUES (?, ?)`)
          .run(BigInt(info.lastInsertRowid), vecBuf(embedding));
      }
    });
    tx();
    return this.getSelfById(id);
  }

  getSelfById(id) {
    return rowToSelf(this.db.prepare(`SELECT * FROM self_memories WHERE id = ?`).get(id));
  }

  async listSelf(limit = 50) {
    const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    return this.db.prepare(`
      SELECT * FROM self_memories
       ORDER BY importance DESC, created_at DESC
       LIMIT ?
    `).all(cap).map(rowToSelf);
  }

  async updateSelf(id, input, embedding) {
    const existing = this.getSelfById(id);
    if (!existing) throw new Error(`Self-memory ${id} not found`);

    const merged = {
      title:      input.title      ?? existing.title,
      content:    input.content    ?? existing.content,
      tags:       input.tags       ?? existing.tags,
      importance: input.importance ?? existing.importance,
      confidence: input.confidence ?? existing.confidence,
    };
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT rowid FROM self_memories WHERE id = ?`).get(id);
      this.db.prepare(`
        UPDATE self_memories SET title = ?, content = ?, tags = ?, importance = ?, confidence = ?
         WHERE id = ?
      `).run(merged.title, merged.content, JSON.stringify(merged.tags ?? []),
              merged.importance, merged.confidence, id);
      if (embedding) {
        this.db.prepare(`DELETE FROM vec_self_memories WHERE rowid = ?`).run(BigInt(row.rowid));
        this.db.prepare(`INSERT INTO vec_self_memories (rowid, embedding) VALUES (?, ?)`)
          .run(BigInt(row.rowid), vecBuf(embedding));
      }
    });
    tx();
    return this.getSelfById(id);
  }

  async setSelfEmbedding(id, embedding) {
    const row = this.db.prepare(`SELECT rowid FROM self_memories WHERE id = ?`).get(id);
    if (!row) return;
    this.db.prepare(`DELETE FROM vec_self_memories WHERE rowid = ?`).run(BigInt(row.rowid));
    this.db.prepare(`INSERT INTO vec_self_memories (rowid, embedding) VALUES (?, ?)`)
      .run(BigInt(row.rowid), vecBuf(embedding));
  }

  // Self-memories missing a vector — same shape as listWithoutEmbeddings()
  // for the user-facing `memories` table, so initEmbeddings() can backfill
  // this store the same way. Without this, a provider/model change (or a
  // dims resize) that clears vec_self_memories leaves self-memory search
  // permanently disabled — nothing else scans for and re-embeds these rows.
  async listSelfWithoutEmbeddings({ limit = null, offset = 0 } = {}) {
    return this.db.prepare(`
      SELECT sm.id, sm.title, sm.content
      FROM self_memories sm
      LEFT JOIN vec_self_memories v ON v.rowid = sm.rowid
      WHERE v.rowid IS NULL
      ORDER BY sm.rowid
      LIMIT ? OFFSET ?
    `).all(limit ?? -1, offset);
  }

  async deleteSelf(id) {
    const row = this.db.prepare(`SELECT title FROM self_memories WHERE id = ?`).get(id);
    if (!row) return null;
    this.db.prepare(`DELETE FROM self_memories WHERE id = ?`).run(id);
    return row.title;
  }

  async recallSelf(args) {
    return recallSelfMemories(this.db, args);
  }
};
