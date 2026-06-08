// db/sqlite.js
// SQLite backend for Aperio.
//
// Surface area is the union of two store shapes: the store.pool patterns (so
// Postgres-style handlers work) AND the store.wiki/store.cache sub-store shape
// (so handlers built around the in-memory cache also work). Carrying both lets
// every handler run unchanged regardless of backend; the redundant paths could
// be collapsed in a future cleanup.
//
// Storage layout:
//   • memories         — main table; rowid is the FTS5 + vec0 join key
//   • memories_fts     — FTS5 over title+content (BM25)
//   • vec_memories     — sqlite-vec virtual table holding embeddings
//   • wiki_articles    — same trio for the wiki
//   • settings         — k/v JSONB-like store
//
// Search semantics match Postgres:
//   • mode='fulltext'  — BM25 only
//   • mode='semantic'  — cosine distance only
//   • mode='auto'      — Reciprocal Rank Fusion of both
//
// Notes on dialect mapping:
//   • Postgres pgvector returns cosine *distance* (0=same); sqlite-vec returns
//     the same. We expose `similarity = 1 - distance` so callers see the same
//     range as before.
//   • FTS5 BM25 returns *negative* scores (smaller = better). We negate so
//     "higher = better" matches Postgres' ts_rank.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { runSqliteMigrations } from './migrate-sqlite.js';
import { deserialiseRow } from './types.js';
import logger, { logError } from '../lib/helpers/logger.js';
import { WIKI_SEED } from './wiki-seed.js';
import { MEMORY_SEED } from './memory-seed.js';
import { DB_TABLES, isAllowedTable } from './tables.js';

const EMBED_DIMS = parseInt(process.env.EMBEDDING_DIMS || '1024', 10);
const DEFAULT_PATH = process.env.SQLITE_PATH || './sqlite/aperio.db';

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function vecBuf(embedding) {
  // sqlite-vec accepts a Float32Array as the vector payload.
  return Float32Array.from(embedding);
}

function rowToMemory(row) {
  if (!row) return null;
  // Tags come back as JSON text; parse for caller. Match Postgres' shape —
  // `lang` is preserved on the returned object so update() can re-use it.
  return {
    ...deserialiseRow({
      ...row,
      tags:        row.tags ? JSON.parse(row.tags) : [],
      pinned:      !!row.pinned,
      confidence:  row.confidence !== null ? Number(row.confidence) : 1.0,
      importance:  Number(row.importance),
    }),
    lang: row.lang ?? 'english',
  };
}

function rowToArticle(row) {
  if (!row) return null;
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

// ── Wiki sub-store (store.wiki compatibility shape) ──────────────────────────
class SqliteWiki {
  constructor(db) { this.db = db; }

  async upsert({ slug, title, summary, body_md, tags, generated_by, source_hash, source_memory_ids }, embedding) {
    const existing = this.db.prepare(`SELECT id, revision, rowid FROM wiki_articles WHERE slug = ?`).get(slug);
    const tagsJson = JSON.stringify(tags ?? []);

    const tx = this.db.transaction(() => {
      let id, revision, rowid;
      if (existing) {
        id       = existing.id;
        revision = existing.revision + 1;
        rowid    = existing.rowid;
        this.db.prepare(`
          UPDATE wiki_articles
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
          INSERT INTO wiki_articles (id, slug, title, summary, body_md, tags, generated_by, source_hash, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(id, slug, title, summary ?? null, body_md, tagsJson,
                generated_by ?? null, source_hash ?? null);
        rowid = info.lastInsertRowid;
      }

      if (embedding) {
        // vec0 has no UPSERT; manually delete + insert by rowid.
        this.db.prepare(`DELETE FROM vec_wiki WHERE rowid = ?`).run(BigInt(rowid));
        this.db.prepare(`INSERT INTO vec_wiki (rowid, embedding) VALUES (?, ?)`)
          .run(BigInt(rowid), vecBuf(embedding));
      }

      // Replace sources atomically.
      this.db.prepare(`DELETE FROM wiki_article_sources WHERE article_id = ?`).run(id);
      const insSource = this.db.prepare(`INSERT INTO wiki_article_sources (article_id, memory_id) VALUES (?, ?)`);
      for (const memId of (source_memory_ids ?? [])) {
        try { insSource.run(id, memId); }
        catch (err) { logError(`[sqlite/wiki] skip unknown source memory ${memId}`, err); }
      }
      return { id, revision, inserted: !existing };
    });
    return tx();
  }

  async list({ tag, status, updated_since, limit = 25, offset = 0 }) {
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
        FROM wiki_articles
       WHERE ${where}
       ORDER BY generated_at DESC
       LIMIT @cap OFFSET @off
    `).all({ ...params, cap, off });
    return rows.map(rowToArticle);
  }

  async get(slug) {
    const row = this.db.prepare(`
      SELECT id, slug, title, summary, body_md, tags, status,
             generated_by, generated_at, revision
        FROM wiki_articles
       WHERE slug = ?
    `).get(slug);
    if (!row) return null;
    const sources = this.db.prepare(`
      SELECT memory_id FROM wiki_article_sources WHERE article_id = ?
    `).all(row.id).map(r => r.memory_id);
    return { ...rowToArticle(row), source_memory_ids: sources };
  }

  async search({ query, queryEmbedding, tags, status, limit = 10, mode = 'auto' }) {
    const cap = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
    const useVector = !!queryEmbedding && mode !== 'fulltext';
    const useText   = !!query && mode !== 'semantic';

    if (useVector && useText) {
      // Reciprocal Rank Fusion across both indices, computed in SQL.
      const rows = this.db.prepare(`
        WITH vector_ranked AS (
          SELECT v.rowid AS rid, ROW_NUMBER() OVER (ORDER BY v.distance) AS rank
            FROM vec_wiki v
           WHERE v.embedding MATCH ? AND k = 60
        ),
        fts_ranked AS (
          SELECT f.rowid AS rid, ROW_NUMBER() OVER (ORDER BY f.rank) AS rank
            FROM wiki_articles_fts f
           WHERE wiki_articles_fts MATCH ?
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
          JOIN wiki_articles a ON a.rowid = fu.rid
         GROUP BY a.id
         ORDER BY score DESC
         LIMIT ?
      `).all(vecBuf(queryEmbedding), query, cap);
      return rows.map(r => ({ ...rowToArticle(r), score: Number(r.score) }));
    }

    if (useVector) {
      const rows = this.db.prepare(`
        SELECT a.id, a.slug, a.title, a.summary, a.tags, a.status, a.revision, a.generated_at,
               (1.0 - v.distance) * CASE WHEN a.status='stale' THEN 0.7 ELSE 1.0 END AS score
          FROM vec_wiki v
          JOIN wiki_articles a ON a.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY score DESC
      `).all(vecBuf(queryEmbedding), cap);
      return rows.map(r => ({ ...rowToArticle(r), score: Number(r.score) }));
    }

    // Fulltext only — note FTS5 `rank` is more-negative = better; negate it.
    const rows = this.db.prepare(`
      SELECT a.id, a.slug, a.title, a.summary, a.tags, a.status, a.revision, a.generated_at,
             (-f.rank) * CASE WHEN a.status='stale' THEN 0.7 ELSE 1.0 END AS score
        FROM wiki_articles_fts f
        JOIN wiki_articles a ON a.rowid = f.rowid
       WHERE wiki_articles_fts MATCH ?
       ORDER BY score DESC
       LIMIT ?
    `).all(query, cap);
    return rows.map(r => ({ ...rowToArticle(r), score: Number(r.score) }));
  }

  async listWithoutEmbeddings() {
    return this.db.prepare(`
      SELECT a.id, a.title, a.body_md
        FROM wiki_articles a
        LEFT JOIN vec_wiki v ON v.rowid = a.rowid
       WHERE v.rowid IS NULL
    `).all();
  }

  async setEmbedding(id, embedding) {
    const row = this.db.prepare(`SELECT rowid FROM wiki_articles WHERE id = ?`).get(id);
    if (!row) return;
    this.db.prepare(`DELETE FROM vec_wiki WHERE rowid = ?`).run(BigInt(row.rowid));
    this.db.prepare(`INSERT INTO vec_wiki (rowid, embedding) VALUES (?, ?)`)
      .run(BigInt(row.rowid), vecBuf(embedding));
  }

  async close() { /* shared connection — main store closes it */ }
}

// ── Main store ──────────────────────────────────────────────────────────────
export class SqliteStore {
  constructor(db) {
    this.db    = db;
    this.wiki  = new SqliteWiki(db);
    this.cache = [];   // in-memory snapshot of current memories
    // PostgresStore exposes .pool; we don't, but expose .db for advanced
    // callers (e.g. codegraph handlers in Phase 2).
  }

  static async init() {
    const dbPath = resolve(DEFAULT_PATH);
    mkdirSync(dirname(dbPath), { recursive: true });

    const isFresh = !existsSync(dbPath);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');

    // Load sqlite-vec extension. allow_load_extension is required for ext APIs.
    db.loadExtension = db.loadExtension.bind(db);   // safety: ensure presence
    sqliteVec.load(db);
    // Sanity check the dim — vec0 tables encode it at CREATE time.
    if (!isFresh) {
      try {
        const probe = db.prepare(`SELECT vec_length(?) AS d`).get(vecBuf(new Array(EMBED_DIMS).fill(0)));
        if (probe.d !== EMBED_DIMS) {
          throw new Error(`vector dim mismatch — set EMBEDDING_DIMS=${probe.d} or delete ${dbPath}`);
        }
      } catch (err) {
        // vec_length unavailable in older versions; soft-skip.
        logger.debug(`[sqlite] dim probe skipped: ${err.message}`);
      }
    }

    await runSqliteMigrations(db);
    const store = new SqliteStore(db);
    await store.refreshCache();

    // Seed baseline memories on a fresh or empty memories table. Mirrors the
    // wiki seed below: gives the sidebar + memory table something to render
    // on first boot, and primes the LLM with context about Aperio itself.
    const memoryCount = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get().n;
    if (memoryCount === 0) {
      const insMem = db.prepare(`
        INSERT INTO memories (id, type, title, content, tags, importance, source, pinned)
        VALUES (?, ?, ?, ?, ?, ?, 'system', ?)
      `);
      const txMem = db.transaction(() => {
        for (const m of MEMORY_SEED) {
          insMem.run(
            randomUUID(), m.type, m.title, m.content,
            JSON.stringify(m.tags ?? []),
            m.importance ?? 3,
            m.pinned ? 1 : 0,
          );
        }
      });
      txMem();
      await store.refreshCache();
      logger.info(`[sqlite] Seeded ${MEMORY_SEED.length} baseline memories.`);
    }

    // Seed baseline wiki articles on a fresh or empty wiki.
    const articleCount = db.prepare(`SELECT COUNT(*) AS n FROM wiki_articles`).get().n;
    if (articleCount === 0) {
      const ins = db.prepare(`
        INSERT INTO wiki_articles (id, slug, title, summary, body_md, tags, generated_by, source_hash, revision)
        VALUES (?, ?, ?, ?, ?, ?, 'system', NULL, 1)
      `);
      const tx = db.transaction(() => {
        for (const a of WIKI_SEED) {
          ins.run(randomUUID(), a.slug, a.title, a.summary ?? null, a.body_md,
                  JSON.stringify(a.tags ?? []));
        }
      });
      tx();
      logger.info(`[sqlite] Seeded ${WIKI_SEED.length} baseline wiki articles.`);
    }

    return store;
  }

  async close() {
    try { this.db.close(); } catch (err) { logError('[sqlite] close failed', err); }
  }

  // ── In-memory cache (store.cache compatibility shape) ─────────────────────
  async refreshCache() {
    const rows = this.db.prepare(`
      SELECT * FROM memories
       WHERE valid_until IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY pinned DESC, importance DESC
    `).all(nowIso());
    this.cache = rows.map(rowToMemory);
  }

  // ── Counts ────────────────────────────────────────────────────────────────
  async counts() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN v.rowid IS NOT NULL THEN 1 ELSE 0 END) AS embedded
        FROM memories m
        LEFT JOIN vec_memories v ON v.rowid = m.rowid
    `).get();
    // `current` = recall-able rows the UI actually shows (latest, unexpired),
    // distinct from `total` which counts tombstoned/superseded versions too.
    const current = this.db.prepare(
      `SELECT COUNT(*) AS c FROM memories
        WHERE valid_until IS NULL AND (expires_at IS NULL OR expires_at > ?)`
    ).get(nowIso()).c;
    return { total: Number(row.total), embedded: Number(row.embedded ?? 0), current: Number(current) };
  }

  // ── Insert / bulkInsert ───────────────────────────────────────────────────
  async insert(input, embedding) {
    const id  = randomUUID();
    const tx  = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO memories (id, type, title, content, tags, importance, expires_at, source, lang, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.type, input.title, input.content,
        JSON.stringify(input.tags ?? []),
        input.importance ?? 3,
        input.expires_at ? new Date(input.expires_at).toISOString() : null,
        input.source ?? 'manual',
        input.lang ?? 'english',
        input.confidence ?? 1.0,
      );
      const rowid = info.lastInsertRowid;
      if (embedding) {
        this.db.prepare(`INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)`)
          .run(BigInt(rowid), vecBuf(embedding));
      }
      return rowid;
    });
    tx();
    await this.refreshCache();
    return this.getById(id);
  }

  async bulkInsert(inputs) {
    if (!inputs.length) return [];
    const ids = [];
    const insMem = this.db.prepare(`
      INSERT INTO memories (id, type, title, content, tags, importance, expires_at, source, lang, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const input of inputs) {
        const id = randomUUID();
        insMem.run(
          id, input.type, input.title, input.content,
          JSON.stringify(input.tags ?? []),
          input.importance ?? 3,
          input.expires_at ? new Date(input.expires_at).toISOString() : null,
          input.source ?? 'import',
          input.lang ?? 'english',
          input.confidence ?? 1.0,
        );
        ids.push(id);
      }
    });
    tx();
    await this.refreshCache();
    return ids.map(id => this._getByIdSync(id));
  }

  // ── Read ─────────────────────────────────────────────────────────────────
  _getByIdSync(id) {
    return rowToMemory(this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id));
  }
  async getById(id) { return this._getByIdSync(id); }

  async listAll() {
    return this.db.prepare(`
      SELECT * FROM memories
       WHERE valid_until IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY pinned DESC, importance DESC
    `).all(nowIso()).map(rowToMemory);
  }

  async listWithoutEmbeddings() {
    return this.db.prepare(`
      SELECT m.id, m.title, m.content FROM memories m
       LEFT JOIN vec_memories v ON v.rowid = m.rowid
       WHERE v.rowid IS NULL AND m.valid_until IS NULL
    `).all();
  }

  // ── Generic DB browser (whitelisted tables only) ─────────────────────────
  async listTables() {
    return DB_TABLES.map(({ name, label }) => {
      // For memories, count what the UI actually shows: current, unexpired rows.
      const { sql, params } = name === 'memories'
        ? { sql: `SELECT COUNT(*) AS c FROM memories
                   WHERE valid_until IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
            params: [nowIso()] }
        : { sql: `SELECT COUNT(*) AS c FROM ${name}`, params: [] };
      return { name, label, count: this.db.prepare(sql).get(...params).c };
    });
  }

  async readTable(name) {
    if (!isAllowedTable(name)) throw new Error(`Unknown table: ${name}`);
    const where  = name === 'memories'
      ? ` WHERE valid_until IS NULL AND (expires_at IS NULL OR expires_at > ?)` : '';
    const params = name === 'memories' ? [nowIso()] : [];
    const stmt    = this.db.prepare(`SELECT * FROM ${name}${where}`);
    const columns = stmt.columns().map(c => c.name);
    return { columns, rows: stmt.all(...params) };
  }

  // ── Mutate ───────────────────────────────────────────────────────────────
  async update(id, input, embedding) {
    const existing = this._getByIdSync(id);
    if (!existing)                throw new Error(`Memory ${id} not found`);
    if (existing.valid_until)     throw new Error(`Memory ${id} has been superseded`);

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

    const newId = randomUUID();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE memories SET valid_until = ? WHERE id = ?`).run(nowIso(), id);
      const info = this.db.prepare(`
        INSERT INTO memories (id, type, title, content, tags, importance, expires_at, source, lang, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId, merged.type, merged.title, merged.content,
        JSON.stringify(merged.tags ?? []),
        merged.importance,
        merged.expires_at ? new Date(merged.expires_at).toISOString() : null,
        merged.source, merged.lang, merged.confidence,
      );
      if (embedding) {
        this.db.prepare(`INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)`)
          .run(BigInt(info.lastInsertRowid), vecBuf(embedding));
      }
    });
    tx();
    await this.refreshCache();
    return this._getByIdSync(newId);
  }

  async setEmbedding(id, embedding) {
    const row = this.db.prepare(`SELECT rowid FROM memories WHERE id = ?`).get(id);
    if (!row) return;
    this.db.prepare(`DELETE FROM vec_memories WHERE rowid = ?`).run(BigInt(row.rowid));
    this.db.prepare(`INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)`)
      .run(BigInt(row.rowid), vecBuf(embedding));
  }

  async clearAllEmbeddings() {
    this.db.prepare(`DELETE FROM vec_memories`).run();
    this.db.prepare(`DELETE FROM vec_wiki`).run();
  }

  async setPin(id, pinned) {
    const info = this.db.prepare(`
      UPDATE memories SET pinned = ? WHERE id = ? AND valid_until IS NULL
    `).run(pinned ? 1 : 0, id);
    if (info.changes > 0) await this.refreshCache();
    return info.changes > 0;
  }

  async setExpiry(id, expiresAt) {
    const info = this.db.prepare(`
      UPDATE memories SET expires_at = ? WHERE id = ? AND valid_until IS NULL
    `).run(expiresAt ? new Date(expiresAt).toISOString() : null, id);
    if (info.changes > 0) await this.refreshCache();
    return info.changes > 0;
  }

  async delete(id) {
    const row = this.db.prepare(`SELECT title FROM memories WHERE id = ?`).get(id);
    if (!row) return null;
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    await this.refreshCache();
    return row.title;
  }

  // ── Recall (hybrid / semantic / fulltext) ─────────────────────────────────
  async recall({ query, queryEmbedding, type, tags, limit = 10, mode = 'auto', asOf = null }) {
    const useVector = !!queryEmbedding && mode !== 'fulltext';
    const useText   = !!query          && mode !== 'semantic';
    const cap       = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);

    // Temporal + base filter as a SQL fragment.
    const baseConds = [`(m.expires_at IS NULL OR m.expires_at > @now)`];
    const baseParams = { now: nowIso() };
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
      const rows = this.db.prepare(`
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
      `).all({ ...baseParams, vec: vecBuf(queryEmbedding), q: query, cap });
      const maxRrf = Number(rows[0]?.rrf_score) || 1;
      return rows.map(r => ({ ...rowToMemory(r), similarity: Number(r.rrf_score) / maxRrf }));
    }

    if (useVector) {
      const rows = this.db.prepare(`
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
      const rows = this.db.prepare(`
        SELECT m.*, (-f.rank) AS ts_score
          FROM memories_fts f
          JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH @q AND ${where}
         ORDER BY ts_score DESC
         LIMIT @cap
      `).all({ ...baseParams, q: query, cap });
      const maxScore = Math.max(...rows.map(r => Number(r.ts_score) || 0), 0.001);
      return rows.map(r => ({ ...rowToMemory(r), similarity: Number(r.ts_score) / maxScore }));
    }

    // No query at all → list by importance, like Postgres.
    const rows = this.db.prepare(`
      SELECT m.* FROM memories m
       WHERE ${where}
       ORDER BY m.importance DESC, m.created_at DESC
       LIMIT @cap
    `).all({ ...baseParams, cap });
    return rows.map(r => ({ ...rowToMemory(r), similarity: r.confidence ?? 1.0 }));
  }

  // ── Duplicates ────────────────────────────────────────────────────────────
  async findDuplicates(threshold) {
    // Brute-force pairwise cosine over the current rows.
    const rows = this.db.prepare(`
      SELECT m.id, m.title, m.type, v.embedding
        FROM memories m
        JOIN vec_memories v ON v.rowid = m.rowid
       WHERE m.valid_until IS NULL
    `).all();
    // Decode embeddings (sqlite-vec returns BLOB → Buffer; reinterpret as Float32).
    const decoded = rows.map(r => ({
      id: r.id, title: r.title, type: r.type,
      vec: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
    }));
    const out = [];
    for (let i = 0; i < decoded.length; i++) {
      for (let j = i + 1; j < decoded.length; j++) {
        const a = decoded[i], b = decoded[j];
        if (a.vec.length !== b.vec.length) continue;
        let dot = 0, na = 0, nb = 0;
        for (let k = 0; k < a.vec.length; k++) {
          dot += a.vec[k] * b.vec[k];
          na  += a.vec[k] * a.vec[k];
          nb  += b.vec[k] * b.vec[k];
        }
        const sim = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
        if (sim >= threshold) {
          out.push({
            id_a: a.id, title_a: a.title, type_a: a.type,
            id_b: b.id, title_b: b.title, type_b: b.type,
            similarity: sim,
          });
        }
      }
    }
    return out.sort((x, y) => y.similarity - x.similarity).slice(0, 20);
  }

  async mergeDuplicate(id_a, id_b) {
    const tx = this.db.transaction(() => {
      const a = this._getByIdSync(id_a);
      const b = this._getByIdSync(id_b);
      if (a && b && !a.content.includes(b.content.slice(0, 40))) {
        this.db.prepare(`UPDATE memories SET content = content || ' | ' || ? WHERE id = ?`)
          .run(b.content, id_a);
      }
      this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id_b);
    });
    tx();
    await this.refreshCache();
  }

  // ── Settings (k/v JSON) ───────────────────────────────────────────────────
  async getSetting(key) {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
    return row ? JSON.parse(row.value) : null;
  }

  async setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), nowIso());
    return value;
  }

  async getSettings() {
    const rows = this.db.prepare(`SELECT key, value FROM settings`).all();
    return Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]));
  }

  async deleteSetting(key) {
    const info = this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
    return info.changes > 0;
  }
}
