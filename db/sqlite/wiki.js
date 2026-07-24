// db/sqlite/wiki.js
// Wiki sub-store (store.wiki compatibility shape). Table names are
// configurable so the same class backs both the user-facing wiki (default
// names below) and the agent's self-wiki (self_wiki_articles /
// self_wiki_article_sources — see agent-self-memory.md Phase 2). Self-wiki has
// no search surface (only self_wiki_write/self_wiki_get exist), so it never
// calls search()/listWithoutEmbeddings()/setEmbedding() and is constructed
// without an `fts`/`vec` table — those methods are simply unused on that path.

import { randomUUID } from 'node:crypto';
import { logError } from '../../lib/helpers/logger.js';
import { ftsMatchQuery, nowIso, rowToArticle, vecBuf } from './mappers.js';

export const WIKI_TABLES = { articles: 'wiki_articles', sources: 'wiki_article_sources', fts: 'wiki_articles_fts', vec: 'vec_wiki' };
export const SELF_WIKI_TABLES = { articles: 'self_wiki_articles', sources: 'self_wiki_article_sources' };

export class SqliteWiki {
  constructor(db, tables = WIKI_TABLES) { this.db = db; this.t = tables; }

  async upsert({ slug, title, summary, body_md, tags, generated_by, source_hash, source_memory_ids }, embedding) {
    const { articles, sources, vec } = this.t;
    const existing = this.db.prepare(`SELECT id, revision, rowid FROM ${articles} WHERE slug = ?`).get(slug);
    const tagsJson = JSON.stringify(tags ?? []);

    const tx = this.db.transaction(() => {
      let id, revision, rowid;
      if (existing) {
        id       = existing.id;
        revision = existing.revision + 1;
        rowid    = existing.rowid;
        this.db.prepare(`
          UPDATE ${articles}
             SET title = ?, summary = ?, body_md = ?, tags = ?,
                 generated_by = ?, generated_at = ?, source_hash = ?,
                 revision = ?, status = 'fresh'
           WHERE id = ?
        `).run(title, summary ?? null, body_md, tagsJson,
                generated_by ?? null, nowIso(), source_hash ?? null, revision, id);
      } else {
        id = randomUUID();
        revision = 1;
        const info = this.db.prepare(`
          INSERT INTO ${articles} (id, slug, title, summary, body_md, tags, generated_by, source_hash, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(id, slug, title, summary ?? null, body_md, tagsJson,
                generated_by ?? null, source_hash ?? null);
        rowid = info.lastInsertRowid;
      }

      if (embedding && vec) {
        // vec0 has no UPSERT; manually delete + insert by rowid.
        this.db.prepare(`DELETE FROM ${vec} WHERE rowid = ?`).run(BigInt(rowid));
        this.db.prepare(`INSERT INTO ${vec} (rowid, embedding) VALUES (?, ?)`)
          .run(BigInt(rowid), vecBuf(embedding));
      }

      // Replace sources atomically.
      this.db.prepare(`DELETE FROM ${sources} WHERE article_id = ?`).run(id);
      const insSource = this.db.prepare(`INSERT INTO ${sources} (article_id, memory_id) VALUES (?, ?)`);
      for (const memId of (source_memory_ids ?? [])) {
        try { insSource.run(id, memId); }
        catch (err) { logError(`[sqlite/wiki] skip unknown source memory ${memId}`, err); }
      }
      return { id, revision, inserted: !existing };
    });
    return tx();
  }

  // ── Draft / propose ─────────────────────────────────────────────────────
  async proposeDraft({ slug, title, summary, body_md, tags, generated_by, source_memory_ids }) {
    const { articles, sources } = this.t;
    const existing = this.db.prepare(`SELECT id FROM ${articles} WHERE slug = ?`).get(slug);
    if (existing) throw new Error(`Wiki article with slug "${slug}" already exists`);

    const id = randomUUID();
    const tagsJson = JSON.stringify(tags ?? []);
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO ${articles} (id, slug, title, summary, body_md, tags, generated_by, source_hash, revision, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft')
      `).run(id, slug, title, summary ?? null, body_md, tagsJson, generated_by ?? null, null);

      const insSource = this.db.prepare(`INSERT INTO ${sources} (article_id, memory_id) VALUES (?, ?)`);
      for (const memId of (source_memory_ids ?? [])) {
        try { insSource.run(id, memId); }
        catch (err) { logError(`[sqlite/wiki] skip unknown source memory ${memId}`, err); }
      }
      return { id, slug, revision: 1 };
    });
    return tx();
  }

  listDrafts() {
    const { articles } = this.t;
    return this.db.prepare(`
      SELECT id, slug, title, summary, tags, generated_by, generated_at, revision
        FROM ${articles} WHERE status = 'draft' ORDER BY generated_at DESC
    `).all().map(r => ({ ...r, tags: JSON.parse(r.tags ?? '[]') }));
  }

  publishDraft(slug) {
    const { articles } = this.t;
    const row = this.db.prepare(`SELECT id FROM ${articles} WHERE slug = ? AND status = 'draft'`).get(slug);
    if (!row) throw new Error(`Draft with slug "${slug}" not found`);
    this.db.prepare(`UPDATE ${articles} SET status = 'fresh', generated_at = ? WHERE id = ?`)
      .run(nowIso(), row.id);
    return { id: row.id, slug, status: 'fresh' };
  }

  async list({ tag, status, updated_since, limit = 25, offset = 0 }) {
    const { articles } = this.t;
    const cap  = Math.min(Math.max(parseInt(limit,  10) || 25, 1), 100);
    const off  = Math.max(parseInt(offset, 10) || 0, 0);
    const parts = [];
    const params = {};
    if (status) { parts.push(`status = @status`);                              params.status = status; }
    else        { parts.push(`status <> 'archived'`); }
    if (tag)    { parts.push(`EXISTS (SELECT 1 FROM json_each(tags) WHERE value = @tag)`); params.tag = tag; }
    if (updated_since) { parts.push(`generated_at >= @us`); params.us = updated_since; }
    const where = parts.join(' AND ');
    const rows = this.db.prepare(`
      SELECT slug, title, summary, tags, status, revision, generated_at, generated_by
        FROM ${articles}
       WHERE ${where}
       ORDER BY generated_at DESC
       LIMIT @cap OFFSET @off
    `).all({ ...params, cap, off });
    return rows.map(rowToArticle);
  }

  async get(slug) {
    const { articles, sources } = this.t;
    const row = this.db.prepare(`
      SELECT id, slug, title, summary, body_md, tags, status,
             generated_by, generated_at, revision
        FROM ${articles}
       WHERE slug = ?
    `).get(slug);
    if (!row) return null;
    const rows = this.db.prepare(`
      SELECT memory_id FROM ${sources} WHERE article_id = ?
    `).all(row.id).map(r => r.memory_id);
    return { ...rowToArticle(row), source_memory_ids: rows };
  }

  async search({ query, queryEmbedding, tags, status, limit = 10, mode = 'auto' }) {
    const { articles, fts, vec } = this.t;
    const cap = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
    const ftsQuery  = ftsMatchQuery(query);
    const useVector = !!queryEmbedding && mode !== 'fulltext';
    const useText   = !!ftsQuery && mode !== 'semantic';

    if (useVector && useText) {
      // Reciprocal Rank Fusion across both indices, computed in SQL.
      const rows = this.db.prepare(`
        WITH vector_ranked AS (
          SELECT v.rowid AS rid, ROW_NUMBER() OVER (ORDER BY v.distance) AS rank
            FROM ${vec} v
           WHERE v.embedding MATCH ? AND k = 60
        ),
        fts_ranked AS (
          SELECT f.rowid AS rid, ROW_NUMBER() OVER (ORDER BY f.rank) AS rank
            FROM ${fts} f
           WHERE ${fts} MATCH ?
           LIMIT 60
        ),
        fused AS (
          SELECT COALESCE(v.rid, f.rid) AS rid,
                 COALESCE(1.0 / (60 + v.rank), 0.0) + COALESCE(1.0 / (60 + f.rank), 0.0) AS rrf
            FROM vector_ranked v
            LEFT JOIN fts_ranked f ON v.rid = f.rid
          UNION
          SELECT COALESCE(v.rid, f.rid) AS rid,
                 COALESCE(1.0 / (60 + v.rank), 0.0) + COALESCE(1.0 / (60 + f.rank), 0.0) AS rrf
            FROM fts_ranked f
            LEFT JOIN vector_ranked v ON v.rid = f.rid
        )
        SELECT a.id, a.slug, a.title, a.summary, a.tags, a.status, a.revision, a.generated_at,
               MAX(fu.rrf) * CASE WHEN a.status = 'stale' THEN 0.7 ELSE 1.0 END AS score
          FROM fused fu
          JOIN ${articles} a ON a.rowid = fu.rid
         GROUP BY a.id
         ORDER BY score DESC
         LIMIT ?
      `).all(vecBuf(queryEmbedding), ftsQuery, cap);
      return rows.map(r => ({ ...rowToArticle(r), score: Number(r.score) }));
    }

    if (useVector) {
      const rows = this.db.prepare(`
        SELECT a.id, a.slug, a.title, a.summary, a.tags, a.status, a.revision, a.generated_at,
               (1.0 - v.distance) * CASE WHEN a.status='stale' THEN 0.7 ELSE 1.0 END AS score
          FROM ${vec} v
          JOIN ${articles} a ON a.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY score DESC
      `).all(vecBuf(queryEmbedding), cap);
      return rows.map(r => ({ ...rowToArticle(r), score: Number(r.score) }));
    }

    // Fulltext only — note FTS5 `rank` is more-negative = better; negate it.
    const rows = this.db.prepare(`
      SELECT a.id, a.slug, a.title, a.summary, a.tags, a.status, a.revision, a.generated_at,
             (-f.rank) * CASE WHEN a.status='stale' THEN 0.7 ELSE 1.0 END AS score
        FROM ${fts} f
        JOIN ${articles} a ON a.rowid = f.rowid
       WHERE ${fts} MATCH ?
       ORDER BY score DESC
       LIMIT ?
    `).all(ftsQuery, cap);
    return rows.map(r => ({ ...rowToArticle(r), score: Number(r.score) }));
  }

  async listWithoutEmbeddings() {
    const { articles, vec } = this.t;
    return this.db.prepare(`
      SELECT a.id, a.title, a.body_md
        FROM ${articles} a
        LEFT JOIN ${vec} v ON v.rowid = a.rowid
       WHERE v.rowid IS NULL
    `).all();
  }

  async setEmbedding(id, embedding) {
    const { articles, vec } = this.t;
    const row = this.db.prepare(`SELECT rowid FROM ${articles} WHERE id = ?`).get(id);
    if (!row) return;
    this.db.prepare(`DELETE FROM ${vec} WHERE rowid = ?`).run(BigInt(row.rowid));
    this.db.prepare(`INSERT INTO ${vec} (rowid, embedding) VALUES (?, ?)`)
      .run(BigInt(row.rowid), vecBuf(embedding));
  }

  async close() { /* shared connection — main store closes it */ }
}
