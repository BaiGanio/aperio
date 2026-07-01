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
import { mkdirSync, existsSync, copyFileSync, renameSync, unlinkSync } from 'fs';
import { dirname, resolve } from 'path';
import { runSqliteMigrations } from './migrate-sqlite.js';
import { deserialiseRow } from './types.js';
import logger, { logError } from '../lib/helpers/logger.js';
import { getOrCreateKey, prepareDatabase, finalizeDatabase, isEncryptionEnabled,
         readExistingKey, isPlaintextSqlite, decryptFile, KeyUnreadableError } from './encrypt.js';
import { WIKI_SEED } from './wiki-seed.js';
import { MEMORY_SEED } from './memory-seed.js';
import { DB_TABLES, isAllowedTable } from './tables.js';

const EMBED_DIMS = parseInt(process.env.EMBEDDING_DIMS || '1024', 10);
const DEFAULT_PATH = process.env.SQLITE_PATH || './.sqlite/aperio.db';

// ── Helpers ──────────────────────────────────────────────────────────────────

// Decrypt an on-disk encrypted DB back to plaintext, in place, when the user
// has turned encryption off. Exported (underscore-prefixed) so it can be unit
// tested with a known key. Safety contract:
//   • Reads the EXISTING key only — never generates one (readExistingKey).
//   • Decryption is AES-256-GCM authenticated, so a wrong key throws rather than
//     producing garbage; the plaintext is byte-identical to the original.
//   • Verifies the result opens as a real SQLite DB BEFORE replacing the file.
//   • Swaps via an atomic rename, so the original is never half-written.
//   • Keeps a single .encrypted.bak only for the brief migration window, then
//     removes it on success — so repeated on/off flips never accumulate backups.
export function _decryptDbFileInPlace(dbPath, key) {
  const backup = dbPath + '.encrypted.bak';
  const tmp    = dbPath + '.decrypted.tmp';
  copyFileSync(dbPath, backup);
  try {
    decryptFile(dbPath, tmp, key);                 // throws on wrong key / corruption
    if (!isPlaintextSqlite(tmp)) {
      throw new Error('decrypted output is not a SQLite database');
    }
    const probe = new Database(tmp, { readonly: true });
    try { probe.prepare('SELECT count(*) FROM sqlite_master').get(); }
    finally { probe.close(); }
    renameSync(tmp, dbPath);                        // atomic: encrypted → plaintext
    unlinkSync(backup);                             // verified → leave no .bak behind
    logger.info('[sqlite] APERIO_DB_ENCRYPT is off — database decrypted to plaintext on disk (one-time migration).');
  } catch (err) {
    // The original is only replaced by the atomic rename AFTER verification, so
    // on any failure it is still the intact encrypted file. Just clean up.
    for (const p of [tmp, backup]) { try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ } }
    throw err;
  }
}

// Acquire the key, then decrypt. Split from _decryptDbFileInPlace so the latter
// stays key-injectable for tests and the keychain interaction lives here.
function decryptDbFileInPlace(dbPath) {
  let key;
  try {
    key = readExistingKey();
  } catch (err) {
    if (err instanceof KeyUnreadableError) {
      throw new Error(
        `Your database is encrypted, but APERIO_DB_ENCRYPT is off and its key can't be read.\n` +
        `  • To keep it encrypted: set APERIO_DB_ENCRYPT=1 and restart.\n` +
        `  • To repair key access: run \`npm run db:fix-keychain\`, then restart.\n` +
        `  (${err.message})`
      );
    }
    throw err;
  }
  if (!key) {
    throw new Error(
      `Your database file is encrypted, but APERIO_DB_ENCRYPT is off and no encryption key was found ` +
      `in the keychain. Set APERIO_DB_ENCRYPT=1 to open it, or restore a plaintext backup.`
    );
  }
  try {
    _decryptDbFileInPlace(dbPath, key);
  } catch (err) {
    throw new Error(
      `Couldn't auto-decrypt the database after APERIO_DB_ENCRYPT was turned off: ${err.message}\n` +
      `Your original encrypted file is intact — set APERIO_DB_ENCRYPT=1 to keep using it.`
    );
  }
}

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

function rowToSelf(row) {
  if (!row) return null;
  // Self-memories have no type/pin/versioning — a lean shape distinct from
  // the user `memories` row.
  return {
    id:         row.id,
    title:      row.title,
    content:    row.content,
    tags:       row.tags ? JSON.parse(row.tags) : [],
    importance: Number(row.importance),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    source:     row.source ?? 'self',
    lang:       row.lang ?? 'english',
    confidence: row.confidence !== null ? Number(row.confidence) : 1.0,
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
    // ':memory:' opens an ephemeral in-RAM database — no file is created on disk
    // (used by tests, and available to callers wanting a throwaway store).
    const memory = DEFAULT_PATH === ':memory:';
    const dbPath = memory ? ':memory:' : resolve(DEFAULT_PATH);
    if (!memory) mkdirSync(dirname(dbPath), { recursive: true });

    // ── Reconcile: encryption OFF but the file on disk is still encrypted ──
    // prepareDatabase already migrates the other three states (off+plaintext,
    // on+plaintext→encrypt, on+encrypted→decrypt-to-temp). The one direction it
    // can't is this: the user turned APERIO_DB_ENCRYPT off (or commented it out)
    // while aperio.db is still an encrypted blob — opening it raw throws the
    // cryptic SQLITE_NOTADB the non-coder reported. Transparently decrypt it back
    // to plaintext in place, one time, so the file always follows the flag both
    // ways and startup never crashes on a mismatch.
    if (!memory && !isEncryptionEnabled() && existsSync(dbPath) && !isPlaintextSqlite(dbPath)) {
      decryptDbFileInPlace(dbPath);
    }

    // ── Encryption (opt-in via APERIO_DB_ENCRYPT=1) ──────────────────
    // When enabled: the file at dbPath IS the encrypted file. We decrypt
    // it to a temp location and open that; on close() we re-encrypt back.
    // :memory: databases are never encrypted (transient by definition).
    const encryptKey = memory ? null : getOrCreateKey();
    const tempDbPath = encryptKey ? prepareDatabase(dbPath, encryptKey) : null;
    const encrypted = tempDbPath !== null;
    // Freshness: when encrypted, a fresh DB means no encrypted file existed
    // before prepareDatabase — so the temp file we'll open is brand new.
    const isFresh = encrypted
      ? !existsSync(dbPath)
      : (memory ? true : !existsSync(dbPath));

    const openPath = encrypted ? tempDbPath : dbPath;
    const db = new Database(openPath);
    // DELETE journal mode when encrypted: WAL/SHM files would leak plaintext
    // to the temp directory even after the main file is encrypted on close.
    // For single-user local access, the performance difference is negligible.
    db.pragma(encrypted ? 'journal_mode = DELETE' : 'journal_mode = WAL');
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
    // Persist encryption state so close() can re-encrypt and clean up.
    store._encrypted        = encrypted;
    store._encryptKey       = encryptKey;
    store._encryptTempPath  = tempDbPath;
    store._encryptSourcePath = dbPath;

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

  // ── Data portability (export / import) ─────────────────────────────────────

  async exportAll() {
    const memories = this.db.prepare(`
      SELECT id, type, title, content, tags, importance,
             expires_at, source, pinned, lang, confidence
        FROM memories
       WHERE valid_until IS NULL
       ORDER BY pinned DESC, importance DESC
    `).all().map(m => ({
      id:         m.id,
      type:       m.type,
      title:      m.title,
      content:    m.content,
      tags:       JSON.parse(m.tags || '[]'),
      importance: Number(m.importance),
      expires_at: m.expires_at || null,
      source:     m.source,
      pinned:     !!m.pinned,
      lang:       m.lang ?? 'english',
      confidence: m.confidence !== null ? Number(m.confidence) : 1.0,
    }));

    const articles = this.db.prepare(`
      SELECT a.id, a.slug, a.title, a.summary, a.body_md, a.tags,
             a.generated_by, a.revision
        FROM wiki_articles a
       WHERE a.status != 'archived'
       ORDER BY a.generated_at DESC
    `).all();

    const getSources = this.db.prepare(
      `SELECT memory_id FROM wiki_article_sources WHERE article_id = ?`
    );

    const wiki_articles = articles.map(a => ({
      slug:              a.slug,
      title:             a.title,
      summary:           a.summary,
      body_md:           a.body_md,
      tags:              JSON.parse(a.tags || '[]'),
      generated_by:      a.generated_by,
      revision:          a.revision,
      source_memory_ids: getSources.all(a.id).map(r => r.memory_id),
    }));

    // ── Agent jobs + recent runs ─────────────────────────────────
    const agentRows = this.db.prepare(`
      SELECT * FROM agent_jobs ORDER BY updated_at DESC
    `).all();
    const agent_jobs = agentRows.map(r => this._rowToJob(r));

    const getRuns = this.db.prepare(`
      SELECT job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, model, error, tools, answer
        FROM agent_runs
       WHERE job_id = ?
       ORDER BY started_at DESC
       LIMIT 10
    `);
    const agent_runs = [];
    for (const job of agentRows) {
      agent_runs.push(...getRuns.all(job.id));
    }

    const self_memories = this.db.prepare(`
      SELECT id, title, content, tags, importance, source, lang, confidence
        FROM self_memories
       ORDER BY importance DESC, created_at DESC
    `).all().map(sm => ({
      id:         sm.id,
      title:      sm.title,
      content:    sm.content,
      tags:       JSON.parse(sm.tags || '[]'),
      importance: Number(sm.importance),
      source:     sm.source,
      lang:       sm.lang ?? 'english',
      confidence: sm.confidence !== null ? Number(sm.confidence) : 1.0,
    }));

    return { memories, wiki_articles, agent_jobs, agent_runs, self_memories };
  }

  async importAll({ memories = [], wiki_articles = [], agent_jobs = [], agent_runs = [], self_memories = [] }) {
    const result = {
      imported: { memories: 0, wiki: 0, jobs: 0, runs: 0, self_memories: 0 },
      skipped:  { memories: 0, wiki: 0, jobs: 0, runs: 0, self_memories: 0 },
    };

    const tx = this.db.transaction(() => {
      const insertMem = this.db.prepare(`
        INSERT OR IGNORE INTO memories
          (id, type, title, content, tags, importance, expires_at, source, pinned, lang, confidence, valid_from)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const m of memories) {
        const info = insertMem.run(
          m.id, m.type, m.title, m.content, JSON.stringify(m.tags ?? []),
          m.importance ?? 3, m.expires_at ?? null, m.source ?? 'import',
          m.pinned ? 1 : 0, m.lang ?? 'english', m.confidence ?? 1.0,
          new Date().toISOString()
        );
        info.changes > 0 ? result.imported.memories++ : result.skipped.memories++;
      }

      const upsertWiki = this.db.prepare(`
        INSERT OR IGNORE INTO wiki_articles
          (id, slug, title, summary, body_md, tags, generated_by, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertSource = this.db.prepare(
        `INSERT OR IGNORE INTO wiki_article_sources (article_id, memory_id) VALUES (?, ?)`
      );

      for (const a of wiki_articles) {
        const wikiId = randomUUID();
        const info = upsertWiki.run(
          wikiId, a.slug, a.title, a.summary ?? null, a.body_md,
          JSON.stringify(a.tags ?? []), a.generated_by ?? 'import', a.revision ?? 1
        );
        if (info.changes > 0) {
          result.imported.wiki++;
          for (const memId of (a.source_memory_ids ?? [])) {
            try { insertSource.run(wikiId, memId); } catch { /* memory may not exist */ }
          }
        } else {
          result.skipped.wiki++;
        }
      }

      // ── Agent jobs ───────────────────────────────────────────
      if (agent_jobs.length) {
        const upsertJob = this.db.prepare(`
          INSERT OR IGNORE INTO agent_jobs (id, enabled, definition, updated_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const j of agent_jobs) {
          const def = { ...j };
          delete def.id; delete def.enabled; delete def.created_at; delete def.updated_at;
          const info = upsertJob.run(j.id, j.enabled ? 1 : 0, JSON.stringify(def), j.updated_at ?? nowIso());
          info.changes > 0 ? result.imported.jobs++ : result.skipped.jobs++;
        }
      }

      // ── Agent runs (dedup by job_id + started_at) ────────────
      if (agent_runs.length) {
        const upsertRun = this.db.prepare(`
          INSERT OR IGNORE INTO agent_runs
            (job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, model, error, tools, answer)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of agent_runs) {
          const info = upsertRun.run(
            r.job_id, r.started_at, r.finished_at ?? null, r.duration_ms ?? null,
            r.verdict ?? null, r.mode ?? null, r.trigger ?? null, r.model ?? null,
            r.error ?? null, r.tools ?? null, r.answer ?? null
          );
          info.changes > 0 ? result.imported.runs++ : result.skipped.runs++;
        }
      }

      // ── Self-memories (dedup by id, like memories) ───────────
      if (self_memories.length) {
        const insertSelfMem = this.db.prepare(`
          INSERT OR IGNORE INTO self_memories
            (id, title, content, tags, importance, source, lang, confidence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const sm of self_memories) {
          const info = insertSelfMem.run(
            sm.id, sm.title, sm.content, JSON.stringify(sm.tags ?? []),
            sm.importance ?? 3, sm.source ?? 'import', sm.lang ?? 'english', sm.confidence ?? 1.0
          );
          info.changes > 0 ? result.imported.self_memories++ : result.skipped.self_memories++;
        }
      }
    });

    tx();
    return result;
  }

  async close() {
    // When encryption is enabled, checkpoint writes and re-encrypt the
    // temp DB back to the source path before closing.
    if (this._encrypted) {
      try {
        // wal_checkpoint is a no-op in DELETE journal mode (our default
        // for encrypted DBs), but safe to call either way.
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch { /* DELETE mode — no WAL to checkpoint */ }
      finalizeDatabase(this._encryptSourcePath, this._encryptTempPath, this._encryptKey);
    }
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
      // Tombstone+insert means the AFTER-UPDATE stale trigger never sees this edit
      // (only valid_until changes; the new content arrives via a fresh-id INSERT).
      // Do explicitly what Postgres's trigger does: mark citing fresh articles stale,
      // then re-point their source links from the old id to the new version so
      // provenance keeps resolving to a live memory instead of a dangling UUID.
      this.db.prepare(`
        UPDATE wiki_articles SET status = 'stale'
         WHERE status = 'fresh'
           AND id IN (SELECT article_id FROM wiki_article_sources WHERE memory_id = ?)
      `).run(id);
      this.db.prepare(`UPDATE wiki_article_sources SET memory_id = ? WHERE memory_id = ?`)
        .run(newId, id);
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
      // Fold the duplicate's wiki citations into the survivor before it's deleted:
      // mark citing fresh articles stale, then re-point their sources from id_b to
      // id_a. OR IGNORE drops the redundant row if the article already cites id_a;
      // the leftover then cascade-deletes with id_b below. Without this, the DELETE
      // would silently cascade away id_b's source rows and leave dangling citations.
      this.db.prepare(`
        UPDATE wiki_articles SET status = 'stale'
         WHERE status = 'fresh'
           AND id IN (SELECT article_id FROM wiki_article_sources WHERE memory_id = ?)
      `).run(id_b);
      this.db.prepare(`UPDATE OR IGNORE wiki_article_sources SET memory_id = ? WHERE memory_id = ?`)
        .run(id_a, id_b);
      this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id_b);
    });
    tx();
    await this.refreshCache();
  }

  // ── Self-memories (the agent's own walled-off store) ──────────────────────
  // A SEPARATE table from `memories`; none of the methods above touch it and
  // none below touch `memories`. No versioning/expiry/pin — updates are
  // in-place. The vec sidecar (vec_self_memories) is kept in sync by hand on
  // insert/update/setEmbedding; the FTS5 index is maintained by triggers.
  async insertSelf(input, embedding) {
    const id = randomUUID();
    const tx = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO self_memories (id, title, content, tags, importance, source, lang, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.title, input.content,
        JSON.stringify(input.tags ?? []),
        input.importance ?? 3,
        input.source ?? 'self',
        input.lang ?? 'english',
        input.confidence ?? 1.0,
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

  async deleteSelf(id) {
    const row = this.db.prepare(`SELECT title FROM self_memories WHERE id = ?`).get(id);
    if (!row) return null;
    this.db.prepare(`DELETE FROM self_memories WHERE id = ?`).run(id);
    return row.title;
  }

  async recallSelf({ query, queryEmbedding, tags, limit = 10, mode = 'auto' }) {
    const useVector = !!queryEmbedding && mode !== 'fulltext';
    const useText   = !!query          && mode !== 'semantic';
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
      const rows = this.db.prepare(`
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
      `).all({ ...baseParams, vec: vecBuf(queryEmbedding), q: query, cap });
      const maxRrf = Number(rows[0]?.rrf_score) || 1;
      return rows.map(r => ({ ...rowToSelf(r), similarity: Number(r.rrf_score) / maxRrf }));
    }

    if (useVector) {
      const rows = this.db.prepare(`
        SELECT m.*, (1.0 - v.distance) AS similarity
          FROM vec_self_memories v
          JOIN self_memories m ON m.rowid = v.rowid
         WHERE v.embedding MATCH @vec AND k = @cap AND ${where}
         ORDER BY similarity DESC
      `).all({ ...baseParams, vec: vecBuf(queryEmbedding), cap });
      if (rows.length) return rows.map(r => ({ ...rowToSelf(r), similarity: Number(r.similarity) }));
    }

    if (useText) {
      const rows = this.db.prepare(`
        SELECT m.*, (-f.rank) AS ts_score
          FROM self_memories_fts f
          JOIN self_memories m ON m.rowid = f.rowid
         WHERE self_memories_fts MATCH @q AND ${where}
         ORDER BY ts_score DESC
         LIMIT @cap
      `).all({ ...baseParams, q: query, cap });
      const maxScore = Math.max(...rows.map(r => Number(r.ts_score) || 0), 0.001);
      return rows.map(r => ({ ...rowToSelf(r), similarity: Number(r.ts_score) / maxScore }));
    }

    // No query → list by importance (this is the preload path).
    const rows = this.db.prepare(`
      SELECT m.* FROM self_memories m
       WHERE ${where}
       ORDER BY m.importance DESC, m.created_at DESC
       LIMIT @cap
    `).all({ ...baseParams, cap });
    return rows.map(r => ({ ...rowToSelf(r), similarity: r.confidence ?? 1.0 }));
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

  // ── Background-agent jobs + run history (Phase 4) ─────────────────────────
  // A job's heterogeneous shape lives in the `definition` JSON blob; id/enabled
  // are promoted columns. _rowToJob re-merges them into the flat object the
  // scheduler and API expect.
  _rowToJob(row) {
    if (!row) return null;
    const def = JSON.parse(row.definition);
    return { id: row.id, enabled: !!row.enabled, ...def, created_at: row.created_at, updated_at: row.updated_at };
  }

  async listAgentJobs() {
    const rows = this.db.prepare(`SELECT * FROM agent_jobs ORDER BY id`).all();
    return rows.map(r => this._rowToJob(r));
  }

  async getAgentJob(id) {
    return this._rowToJob(this.db.prepare(`SELECT * FROM agent_jobs WHERE id = ?`).get(id));
  }

  async upsertAgentJob(job) {
    const { id, enabled = true, created_at, updated_at, ...definition } = job;
    if (!id) throw new Error("agent job requires an id");
    this.db.prepare(`
      INSERT INTO agent_jobs (id, enabled, definition, updated_at)
        VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE
        SET enabled = excluded.enabled, definition = excluded.definition, updated_at = excluded.updated_at
    `).run(id, enabled ? 1 : 0, JSON.stringify(definition), nowIso());
    return this.getAgentJob(id);
  }

  async deleteAgentJob(id) {
    const info = this.db.prepare(`DELETE FROM agent_jobs WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  async recordAgentRun(run) {
    const info = this.db.prepare(`
      INSERT INTO agent_runs
        (job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, model, error, tools, answer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.jobId, run.startedAt, run.finishedAt ?? null, run.durationMs ?? null,
      run.verdict, run.mode ?? null, run.trigger ?? null, run.model ?? null, run.error ?? null,
      run.tools != null ? JSON.stringify(run.tools) : null, run.answer ?? null,
    );
    return info.lastInsertRowid;
  }

  async listAgentRuns(jobId, limit = 20) {
    const rows = this.db.prepare(
      `SELECT * FROM agent_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`
    ).all(jobId, limit);
    return rows.map(r => ({ ...r, tools: r.tools ? JSON.parse(r.tools) : null }));
  }

  // Delete one run by id (manual cleanup from the History view). Returns true
  // when a row was removed.
  async deleteAgentRun(runId) {
    const info = this.db.prepare(`DELETE FROM agent_runs WHERE id = ?`).run(runId);
    return info.changes > 0;
  }

  // Garbage-collect runs older than `retentionDays` (the run-history sibling of
  // pruneOldSessions). started_at is an ISO-8601 string, so a lexicographic
  // compare against an ISO cutoff is correct. Returns the number removed.
  async pruneAgentRuns(retentionDays) {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const info = this.db.prepare(`DELETE FROM agent_runs WHERE started_at < ?`).run(cutoff);
    return info.changes;
  }

  // ── Issue-triage ledger ───────────────────────────────────────────────────
  // updatedAt is GitHub's issue.updated_at and is the dedup key: when it changes
  // the row is reset to pending (triaged_at = NULL) so the issue is re-triaged.
  // `IS` is SQLite's null-safe equality.
  async upsertIssue({ repo, number, title, state, updatedAt }) {
    this.db.prepare(`
      INSERT INTO issue_triage (repo, issue_number, title, state, updated_at)
        VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo, issue_number) DO UPDATE SET
        title      = excluded.title,
        state      = excluded.state,
        triaged_at = CASE WHEN issue_triage.updated_at IS excluded.updated_at
                          THEN issue_triage.triaged_at ELSE NULL END,
        updated_at = excluded.updated_at
    `).run(repo, number, title ?? null, state ?? null, updatedAt ?? null);
  }

  async listPendingIssues(repo) {
    const sql = repo
      ? `SELECT * FROM issue_triage WHERE triaged_at IS NULL AND repo = ? ORDER BY updated_at`
      : `SELECT * FROM issue_triage WHERE triaged_at IS NULL ORDER BY updated_at`;
    return repo ? this.db.prepare(sql).all(repo) : this.db.prepare(sql).all();
  }

  async markTriaged({ repo, number, priority, verdict, runId }) {
    this.db.prepare(`
      UPDATE issue_triage
         SET triaged_at = ?, priority = ?, verdict = ?, run_id = ?
       WHERE repo = ? AND issue_number = ?
    `).run(nowIso(), priority ?? null, verdict ?? null, runId ?? null, repo, number);
  }
}
