// db/sqlite/store.js
// SqliteStore: the SQLite backend for Aperio.
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
import { loadVectorExtension, fallbackVecTableSql, reconcileVecSidecars } from './vecSupport.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { runSqliteMigrations } from '../migrate-sqlite.js';
import logger, { logError } from '../../lib/helpers/logger.js';
import { recordRebuiltVectorStores } from '../../lib/helpers/vecMeta.js';
import { getOrCreateKey, prepareDatabase, finalizeDatabase, isEncryptionEnabled, isPlaintextSqlite } from '../encrypt.js';
import { WIKI_SEED } from '../wiki-seed.js';
import { MEMORY_SEED } from '../memory-seed.js';
import { MEMORY_SEED_LITE } from '../memory-seed-lite.js';
import { SELF_MEMORY_SEED } from '../self-memory-seed.js';
import { AGENT_JOB_SEED } from '../agent-job-seed.js';
import { normalizeAgentJobDefinition } from '../../lib/agent/job-spec.js';
import { DB_TABLES, isAllowedTable } from '../tables.js';
import { decryptDbFileInPlace } from './encryption.js';
import { restrictFileMode, precreateSecureFile } from '../../lib/helpers/secureFile.js';
import { SqliteWiki, SELF_WIKI_TABLES } from './wiki.js';
import { recallMemories, recallSelfMemories } from './search.js';
import {
  assertJsonPersistable,
  nowIso,
  parseJsonColumn,
  rowToMemory,
  rowToSelf,
  vecBuf,
} from './mappers.js';

const EMBED_DIMS = parseInt(process.env.EMBEDDING_DIMS || '1024', 10);
const DEFAULT_PATH = process.env.SQLITE_PATH || './.sqlite/aperio.db';
// sqlite-vec's vec0 rejects FLOAT[N] columns wider than this at CREATE time.
const SQLITE_VEC_MAX_DIMS = 8192;
// The database file plus every sidecar SQLite may put beside it. All of them
// carry the same rows, so all of them get the same 0600 treatment.
const DB_FILE_SUFFIXES = ['', '-wal', '-shm', '-journal'];

// Tighten a database file and every sidecar that can hold the same rows, for each
// given root path. Two roots matter when encryption is on: openPath is the
// decrypted temp copy we actually read/write, while dbPath holds the encrypted
// blob — but a pre-#466 unclean shutdown in WAL mode can have left *plaintext*
// -wal/-shm next to dbPath, and nothing else ever revisits them.
export function _hardenDbFiles(...roots) {
  for (const root of new Set(roots.filter(Boolean))) {
    for (const suffix of DB_FILE_SUFFIXES) restrictFileMode(root + suffix);
  }
}

// Logical vector store name → its vec0 sidecar table. Single source for
// clearing (all or one) and resizing, so a new store can't be added to one
// path and forgotten in the other. Keys must match VECTOR_STORES in
// lib/helpers/vecMeta.js — a test asserts that.
const SQLITE_VEC_TABLES = Object.freeze({
  memories:      'vec_memories',
  wiki:          'vec_wiki',
  self_memories: 'vec_self_memories',
  codegraph:     'vec_cg_symbols',
  docgraph:      'vec_docgraph_chunks',
});

// ── Main store ──────────────────────────────────────────────────────────────
export class SqliteStore {
  constructor(db) {
    this.db       = db;
    this.wiki     = new SqliteWiki(db);
    this.selfWiki = new SqliteWiki(db, SELF_WIKI_TABLES);
    this.cache = [];   // in-memory snapshot of current memories
    // Whether sqlite-vec loaded. Assumed true until SqliteStore.init() says
    // otherwise, so a directly-constructed store (tests, advanced callers)
    // behaves exactly as it did before this flag existed.
    this._vectorSupported = true;
    this._rebuiltVectorStores = [];
    // PostgresStore exposes .pool; we don't, but expose .db for advanced
    // callers (e.g. codegraph handlers in Phase 2).
  }

  // Read by lib/helpers/vecMeta.js to serve every store FTS-only when the
  // platform has no sqlite-vec extension. PostgresStore has no equivalent —
  // pgvector is a server-side extension that is either installed or the
  // migrations fail outright — so the gate treats `undefined` as supported.
  get vectorSupported() {
    return this._vectorSupported !== false;
  }

  // Logical store names whose vector storage was physically rebuilt at open
  // time, destroying their embeddings. lib/helpers/embeddings.js marks these
  // stale so the reindex driver refills them; empty on every ordinary boot.
  get rebuiltVectorStores() {
    return this._rebuiltVectorStores ?? [];
  }

  static async init() {
    // ':memory:' opens an ephemeral in-RAM database — no file is created on disk
    // (used by tests, and available to callers wanting a throwaway store).
    const memory = DEFAULT_PATH === ':memory:';
    const dbPath = memory ? ':memory:' : resolve(DEFAULT_PATH);
    // 0700 applies only to directories we create here — an existing dir keeps
    // its mode, so pointing SQLITE_PATH into a shared folder never re-permissions it.
    if (!memory) mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

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
    // SECRET-02, creation — better-sqlite3 opens the file itself, so it takes no
    // `mode` and the umask (0644 by default) decides. Create it 0600 first: a
    // chmod after the fact cannot revoke a descriptor another local user grabbed
    // during that window. No-ops when the database already exists.
    if (!memory) precreateSecureFile(openPath);

    // SECRET-02, pre-flight pass — precreateSecureFile only creates; it no-ops on
    // a database that already exists, so a legacy 0644 install (and its 0644
    // WAL/SHM) is still wide open at this point. The reconciliation below opens
    // and, on a platform transition, writes those exact files, so they have to be
    // tightened before it touches them rather than after.
    if (!memory) _hardenDbFiles(openPath, dbPath);

    // Pre-flight: a database whose sidecars were built on the *other* kind of
    // machine has to be reconciled before anything queries it — a surviving
    // vec0 table fails every read here with "no such module: vec0", and a
    // surviving plain table silently breaks KNN back on a supported one.
    // Its own connection, because deleting a schema row does not invalidate
    // the deleting connection's cached schema. Skipped for :memory: and for a
    // brand-new file, which have no sidecars yet.
    let rebuiltVectorStores = [];
    try {
      if (!memory && !isFresh && existsSync(openPath)) {
        rebuiltVectorStores = reconcileVecSidecars(openPath).rebuilt;
      }
    } finally {
      // The pre-flight connection can materialise -wal/-shm sidecars of its own,
      // carrying the same rows as the database file. In `finally` because a
      // reconciliation that throws still leaves them behind, and that boot must
      // not hand a legacy install to other local users on its way out.
      if (!memory) _hardenDbFiles(openPath, dbPath);
    }

    const db = new Database(openPath);
    // SECRET-02, first pass — tighten everything that exists the instant the
    // handle is open, before anything that can throw. better-sqlite3 creates the
    // file under the process umask (0644 by default) and it holds every memory
    // and, since #252, the provider API keys in the settings overlay. Everything
    // between here and the second pass below can fail hard — runSqliteMigrations()
    // still throws uncaught — and a boot that never finished must not leave a
    // legacy install readable. The sidecars are included because
    // an unclean exit leaves them on disk (a clean close checkpoints them away),
    // so a pre-#466 database can arrive here with 0644 WAL/SHM already present
    // holding the same rows. restrictFileMode no-ops on the ones not yet created,
    // and swallows the chmod that Windows cannot perform.
    if (!memory) _hardenDbFiles(openPath, dbPath);
    // DELETE journal mode when encrypted: WAL/SHM files would leak plaintext
    // to the temp directory even after the main file is encrypted on close.
    // For single-user local access, the performance difference is negligible.
    db.pragma(encrypted ? 'journal_mode = DELETE' : 'journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    // Load sqlite-vec. A platform with no prebuilt extension (win32-arm64) is
    // a supported degraded mode, not a fatal error — see db/sqlite/vecSupport.js.
    const vectorSupported = loadVectorExtension(db);
    // Sanity check the dim — vec0 tables encode it at CREATE time.
    if (!isFresh && vectorSupported) {
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

    await runSqliteMigrations(db, { vectorSupported });
    // SECRET-02, second pass — sidecars the first pass could not have seen: the
    // WAL, SHM and journal files this boot materialised itself, which appear only
    // once the journal-mode pragma and the migrations start writing.
    if (!memory) _hardenDbFiles(openPath, dbPath);
    const store = new SqliteStore(db);
    store._vectorSupported = vectorSupported;
    // Read by lib/helpers/embeddings.js: these stores lost their vectors to the
    // pre-flight above and need reindexing.
    store._rebuiltVectorStores = rebuiltVectorStores;
    // …and recorded in the database as well, because the property alone dies
    // with the process. Only the server and the MCP entrypoint run
    // checkEmbeddingProvider(); scripts/config-sync.js, the terminal runtime and
    // both graph indexers open a store and exit without it. Any of those can be
    // the first process to open a database after a platform transition, and the
    // reconciliation above has already destroyed the vectors by then. The next
    // server boot would find correctly-shaped, empty sidecars, an empty rebuilt
    // list, and vec_meta still reading `current` — semantic search silently
    // enabled over nothing. The marker is consumed and cleared by
    // checkEmbeddingProvider(), which is also the first point where vec_meta
    // rows are guaranteed to have been seeded.
    if (rebuiltVectorStores.length) await recordRebuiltVectorStores(store, rebuiltVectorStores);
    await store.refreshCache();
    // Persist encryption state so close() can re-encrypt and clean up.
    store._encrypted        = encrypted;
    store._encryptKey       = encryptKey;
    store._encryptTempPath  = tempDbPath;
    store._encryptSourcePath = dbPath;

    // Seed baseline memories on a fresh or empty memories table. Mirrors the
    // wiki seed below: gives the sidebar + memory table something to render
    // on first boot, and primes the LLM with context about Aperio itself.
    // The lite profile (APERIO_LITE=on) gets the non-coder starter set.
    const memorySeed = process.env.APERIO_LITE === 'on' ? MEMORY_SEED_LITE : MEMORY_SEED;
    const memoryCount = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get().n;
    if (memoryCount === 0) {
      const insMem = db.prepare(`
        INSERT INTO memories (id, type, title, content, tags, importance, source, pinned)
        VALUES (?, ?, ?, ?, ?, ?, 'system', ?)
      `);
      const txMem = db.transaction(() => {
        for (const m of memorySeed) {
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
      logger.info(`[sqlite] Seeded ${memorySeed.length} baseline memories.`);
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

    // Seed baseline self-memories (the agent-private store) on a fresh/empty table.
    const selfCount = db.prepare(`SELECT COUNT(*) AS n FROM self_memories`).get().n;
    if (selfCount === 0) {
      const insSelf = db.prepare(`
        INSERT INTO self_memories (id, title, content, tags, importance, source, lang, confidence, generated_by)
        VALUES (?, ?, ?, ?, ?, 'system', 'english', 1.0, 'seed')
      `);
      const txSelf = db.transaction(() => {
        for (const s of SELF_MEMORY_SEED) {
          insSelf.run(randomUUID(), s.title, s.content, JSON.stringify(s.tags ?? []), s.importance ?? 3);
        }
      });
      txSelf();
      logger.info(`[sqlite] Seeded ${SELF_MEMORY_SEED.length} baseline self-memories.`);
    }

    const jobCount = db.prepare(`SELECT COUNT(*) AS n FROM agent_jobs`).get().n;
    if (jobCount === 0) {
      const insJob = db.prepare(`
        INSERT INTO agent_jobs (id, enabled, definition, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      const txJobs = db.transaction(() => {
        for (const job of AGENT_JOB_SEED) {
          const { id, enabled, created_at, updated_at, ...definition } = normalizeAgentJobDefinition(job);
          insJob.run(id, enabled ? 1 : 0, JSON.stringify(definition), nowIso());
        }
      });
      txJobs();
      logger.info(`[sqlite] Seeded ${AGENT_JOB_SEED.length} baseline background-agent job(s).`);
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
          const def = normalizeAgentJobDefinition(j);
          delete def.id; delete def.enabled; delete def.created_at; delete def.updated_at;
          const info = upsertJob.run(j.id, j.enabled ? 1 : 0, JSON.stringify(def), j.updated_at ?? nowIso());
          info.changes > 0 ? result.imported.jobs++ : result.skipped.jobs++;
        }
      }

      // ── Agent runs (dedup by job_id + started_at) ────────────
      if (agent_runs.length) {
        const upsertRun = this.db.prepare(`
          INSERT OR IGNORE INTO agent_runs
            (job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, model,
             error, tools, answer, artifact_count, artifact_bytes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of agent_runs) {
          const info = upsertRun.run(
            r.job_id, r.started_at, r.finished_at ?? null, r.duration_ms ?? null,
            r.verdict ?? null, r.mode ?? null, r.trigger ?? null, r.model ?? null,
            r.error ?? null, r.tools ?? null, r.answer ?? null,
            r.artifact_count ?? 0, r.artifact_bytes ?? 0
          );
          info.changes > 0 ? result.imported.runs++ : result.skipped.runs++;
        }
      }

      // ── Self-memories (dedup by id, like memories) ───────────
      if (self_memories.length) {
        const insertSelfMem = this.db.prepare(`
          INSERT OR IGNORE INTO self_memories
            (id, title, content, tags, importance, source, lang, confidence, generated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const sm of self_memories) {
          const info = insertSelfMem.run(
            sm.id, sm.title, sm.content, JSON.stringify(sm.tags ?? []),
            sm.importance ?? 3, sm.source ?? 'import', sm.lang ?? 'english', sm.confidence ?? 1.0,
            sm.generated_by ?? null
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
  // Synchronous core of insert() — just the row write, no cache refresh. Split
  // out so approvePending() can compose it into ITS OWN db.transaction() (the
  // pending-row status check and the memory insert must commit atomically, or
  // two concurrent approvals of the same pending id can both pass the
  // status='pending' check and each create a promoted memory). Callers are
  // responsible for awaiting refreshCache() afterward, same as insert() does.
  _insertRowSync(input, embedding) {
    const id = randomUUID();
    const info = this.db.prepare(`
      INSERT INTO memories (id, type, title, content, tags, importance, tier, expires_at, source, lang, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.type, input.title, input.content,
      JSON.stringify(input.tags ?? []),
      input.importance ?? 3,
      input.tier ?? 1,
      input.expires_at ? new Date(input.expires_at).toISOString() : null,
      input.source ?? 'manual',
      input.lang ?? 'english',
      input.confidence ?? 1.0,
    );
    if (embedding) {
      this.db.prepare(`INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)`)
        .run(BigInt(info.lastInsertRowid), vecBuf(embedding));
    }
    return id;
  }

  async insert(input, embedding) {
    const tx = this.db.transaction(() => this._insertRowSync(input, embedding));
    const id = tx();
    await this.refreshCache();
    return this.getById(id);
  }

  async bulkInsert(inputs) {
    if (!inputs.length) return [];
    const ids = [];
    const insMem = this.db.prepare(`
      INSERT INTO memories (id, type, title, content, tags, importance, tier, expires_at, source, lang, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const input of inputs) {
        const id = randomUUID();
        insMem.run(
          id, input.type, input.title, input.content,
          JSON.stringify(input.tags ?? []),
          input.importance ?? 3,
          input.tier ?? 1,
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

  // ── Pending memories (inbox) ─────────────────────────────────────────────
  async insertPending(input) {
    const id = randomUUID();
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO pending_memories
        (id, type, title, content, tags, importance, tier, proposed_at, source, lang, confidence, status, session_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)
    `).run(
      id, input.type ?? 'fact', input.title, input.content,
      JSON.stringify(input.tags ?? []), input.importance ?? 3,
      input.tier ?? 1, now, input.source ?? 'agent',
      input.lang ?? 'english', input.confidence ?? 1.0,
      input.session_id ?? null
    );
    return { id, title: input.title, type: input.type ?? 'fact', status: 'pending' };
  }

  listPending() {
    return this.db.prepare(`
      SELECT * FROM pending_memories WHERE status = 'pending' ORDER BY proposed_at DESC
    `).all().map(r => ({ ...r, tags: JSON.parse(r.tags ?? '[]') }));
  }

  countPending() {
    return this.db.prepare(
      `SELECT COUNT(*) AS c FROM pending_memories WHERE status = 'pending'`
    ).get().c;
  }

  // async only for the refreshCache() at the end — the promotion itself (pending
  // row check + memory insert + status flip) runs inside ONE db.transaction(),
  // using the shared _insertRowSync() core so it never awaits mid-transaction.
  // That atomicity matters: without it, two concurrent approvals of the same
  // pending id could both pass the status='pending' check before either writes
  // 'approved', each promoting its own duplicate memory. The status UPDATE is
  // itself re-guarded by `AND status = 'pending'` and checked via info.changes,
  // so a losing concurrent call fails loudly (and rolls back its insert) instead
  // of silently double-promoting.
  async approvePending(id) {
    const result = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM pending_memories WHERE id = ? AND status = 'pending'`
      ).get(id);
      if (!row) throw new Error(`Pending memory ${id} not found`);

      const memId = this._insertRowSync({
        type: row.type, title: row.title, content: row.content,
        tags: JSON.parse(row.tags ?? '[]'), importance: row.importance,
        tier: row.tier, source: row.source, lang: row.lang,
        confidence: row.confidence,
      }, null);

      const info = this.db.prepare(
        `UPDATE pending_memories SET status = 'approved', reviewed_at = ? WHERE id = ? AND status = 'pending'`
      ).run(nowIso(), id);
      if (info.changes === 0) throw new Error(`Pending memory ${id} was already reviewed`);

      return { id: memId, title: row.title };
    })();
    await this.refreshCache();
    return result;
  }

  rejectPending(id) {
    const row = this.db.prepare(
      `SELECT * FROM pending_memories WHERE id = ? AND status = 'pending'`
    ).get(id);
    if (!row) throw new Error(`Pending memory ${id} not found`);
    this.db.prepare(
      `UPDATE pending_memories SET status = 'rejected', reviewed_at = ? WHERE id = ?`
    ).run(nowIso(), id);
    return { id, status: 'rejected' };
  }

  async listAll() {
    return this.db.prepare(`
      SELECT * FROM memories
       WHERE valid_until IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY pinned DESC, importance DESC
    `).all(nowIso()).map(rowToMemory);
  }

  // `limit`/`offset` let the reindex driver walk a large corpus in bounded
  // pages instead of holding every pending row's full text in memory at once.
  // The ORDER BY is what makes an offset mean the same thing across calls.
  async listWithoutEmbeddings({ limit = null, offset = 0 } = {}) {
    return this.db.prepare(`
      SELECT m.id, m.title, m.content FROM memories m
       LEFT JOIN vec_memories v ON v.rowid = m.rowid
       WHERE v.rowid IS NULL AND m.valid_until IS NULL
       ORDER BY m.rowid
       LIMIT ? OFFSET ?
    `).all(limit ?? -1, offset);
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
      tier:       input.tier       ?? existing.tier,
      expires_at: existing.expires_at ?? null,
      source:     existing.source,
      lang:       existing.lang,
      confidence: input.confidence ?? existing.confidence,
    };

    const newId = randomUUID();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE memories SET valid_until = ? WHERE id = ?`).run(nowIso(), id);
      const info = this.db.prepare(`
        INSERT INTO memories (id, type, title, content, tags, importance, tier, expires_at, source, lang, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId, merged.type, merged.title, merged.content,
        JSON.stringify(merged.tags ?? []),
        merged.importance,
        merged.tier ?? 1,
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

  async hasEmbedding(id) {
    const row = this.db.prepare(`
      SELECT 1 FROM vec_memories WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)
    `).get(id);
    return !!row;
  }

  // ── vec_meta: per-store signature + reindex state (issue #287, WS1) ───────
  // Kept deliberately dumb — the state machine itself lives in
  // lib/helpers/vecMeta.js so both backends can't drift on the rules.

  async listVecMeta() {
    return this.db.prepare(
      `SELECT store_name, signature, dims, status, vectors_cleared, reindex_owner, reindex_expires_at, updated_at
         FROM vec_meta ORDER BY store_name`
    ).all();
  }

  async getVecMeta(storeName) {
    return this.db.prepare(
      `SELECT store_name, signature, dims, status, vectors_cleared, reindex_owner, reindex_expires_at, updated_at
         FROM vec_meta WHERE store_name = ?`
    ).get(storeName) ?? null;
  }

  // Insert only if absent — seeding must never clobber the recorded state of a
  // store that already has one (that state is what says "these vectors are in
  // the old space and still need reindexing").
  async seedVecMeta(storeName, { signature, dims, status = "current" }) {
    const info = this.db.prepare(
      `INSERT INTO vec_meta (store_name, signature, dims, status, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(store_name) DO NOTHING`
    ).run(storeName, signature, dims, status, nowIso());
    return info.changes > 0;
  }

  // Partial update; only the keys present in `patch` are written, so a caller
  // flipping status can't accidentally overwrite the recorded signature.
  // Atomically take ownership of a store's reindex. Returns the status the row
  // held *before* the claim, and whether this reindex has already cleared the
  // store's old-space vectors — the caller must clear them exactly once, and
  // clearing again mid-run would destroy work an earlier run completed.
  //
  // Claiming a `stale` store starts a fresh reindex, so the checkpoint resets
  // to false in the same atomic write that flips the status: a crash between
  // the two would otherwise resume into "already cleared" with every old
  // vector still in place.
  //
  // Runs inside an immediate transaction — the write lock is taken up front
  // rather than on first write, so two processes racing this call cannot both
  // read the row before either acquires it. A deferred transaction (the
  // default) lets that happen: both readers proceed, and the loser hits
  // SQLITE_BUSY upgrading its own transaction to a write lock instead of
  // cleanly returning { claimed: false } — turning the exact concurrent-runner
  // case this lease exists for into a thrown error.
  //
  // `expectedSignature` closes a race the ownership check alone cannot: if a
  // configuration change retargets this row between the caller listing it as
  // pending and this claim running, the row's signature no longer matches what
  // the caller is about to reindex toward. Claiming and completing it anyway
  // would finalize the row as current under the caller's *old* target while it
  // actually holds vectors for neither space — cross-space comparison for
  // whoever reads it next. Passing it through this same predicate keeps the
  // check atomic with the claim; omitted (undefined), the check is skipped for
  // callers that only care about ownership, not target (existing direct tests).
  async claimVecMetaReindex(storeName, owner, leaseMs, expectedSignature = undefined) {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT status, signature, vectors_cleared, reindex_owner, reindex_expires_at FROM vec_meta WHERE store_name = ?`
      ).get(storeName);
      if (!row || row.status === 'current') return { claimed: false, previousStatus: row?.status ?? null };

      if (expectedSignature !== undefined && row.signature !== expectedSignature) {
        return { claimed: false, previousStatus: row.status, retargeted: true };
      }

      // A live lease held by someone else wins; an expired one is up for grabs
      // so a crashed runner cannot block the store forever.
      const heldByOther = row.reindex_owner && row.reindex_owner !== owner;
      const leaseLive = row.reindex_expires_at && row.reindex_expires_at > nowIso();
      if (heldByOther && leaseLive) {
        return { claimed: false, previousStatus: row.status, heldBy: row.reindex_owner };
      }

      const vectorsCleared = row.status === 'stale' ? false : !!row.vectors_cleared;
      this.db.prepare(
        `UPDATE vec_meta
            SET status = 'reindexing', vectors_cleared = ?, reindex_owner = ?, reindex_expires_at = ?, updated_at = ?
          WHERE store_name = ?`
      ).run(vectorsCleared ? 1 : 0, owner, new Date(Date.now() + leaseMs).toISOString(), nowIso(), storeName);
      return { claimed: true, previousStatus: row.status, vectorsCleared };
    });
    return claim.immediate();
  }

  // Records that this reindex has cleared the store's old-space vectors. Called
  // immediately after the clear, so a crash can only ever leave a window in
  // which the next runner re-clears a store that is already empty.
  async markVectorsCleared(storeName) {
    const info = this.db.prepare(
      `UPDATE vec_meta SET vectors_cleared = 1, updated_at = ? WHERE store_name = ?`
    ).run(nowIso(), storeName);
    return info.changes > 0;
  }

  // Extends a lease we still hold. False means someone else took the store —
  // the caller must stop rather than write into a reindex it no longer owns.
  async renewVecMetaLease(storeName, owner, leaseMs) {
    const info = this.db.prepare(
      `UPDATE vec_meta SET reindex_expires_at = ?, updated_at = ?
        WHERE store_name = ? AND reindex_owner = ?`
    ).run(new Date(Date.now() + leaseMs).toISOString(), nowIso(), storeName, owner);
    return info.changes > 0;
  }

  async releaseVecMetaReindex(storeName, owner) {
    const info = this.db.prepare(
      `UPDATE vec_meta SET reindex_owner = NULL, reindex_expires_at = NULL, updated_at = ?
        WHERE store_name = ? AND reindex_owner = ?`
    ).run(nowIso(), storeName, owner);
    return info.changes > 0;
  }

  // Completes a reindex only if this owner still holds the store. One
  // statement so there is no gap between checking ownership and flipping the
  // status for another writer to land in — the failure mode a separate
  // renew-then-markCurrent pair leaves open. The owner check alone is enough
  // to catch a reassigned target: markStaleWhereChanged() clears reindex_owner
  // in the same write that moves a store to a new signature, so a target
  // change always shows up here as an owner mismatch — checking signature too
  // would additionally require the row to already carry the exact string this
  // call is completing to, which does not hold for every valid caller (a
  // store nudged into `reindexing` without markStaleWhereChanged first
  // recording that target, for instance).
  async finalizeVecMetaReindex(storeName, owner, { signature, dims }) {
    const info = this.db.prepare(
      `UPDATE vec_meta
          SET status = 'current', vectors_cleared = 0, reindex_owner = NULL, reindex_expires_at = NULL,
              signature = ?, dims = ?, updated_at = ?
        WHERE store_name = ? AND reindex_owner = ?`
    ).run(signature, dims, nowIso(), storeName, owner);
    return info.changes > 0;
  }

  async updateVecMeta(storeName, patch) {
    const allowed = ["signature", "dims", "status", "vectors_cleared", "reindex_owner", "reindex_expires_at"];
    const cols = allowed.filter(k => Object.hasOwn(patch, k));
    if (!cols.length) return false;
    const sets = cols.map(c => `${c} = ?`).join(", ");
    // better-sqlite3 refuses to bind booleans; the shared state machine speaks
    // in booleans so both backends can take the same patch object.
    const values = cols.map(c => (typeof patch[c] === "boolean" ? (patch[c] ? 1 : 0) : patch[c]));
    const info = this.db.prepare(
      `UPDATE vec_meta SET ${sets}, updated_at = ? WHERE store_name = ?`
    ).run(...values, nowIso(), storeName);
    return info.changes > 0;
  }

  // Clears one logical store's vectors (issue #287, WS1). The reindex driver
  // calls this when a stale store starts reindexing, so the store's rows show
  // up in the existing "without embeddings" scans and get re-embedded.
  async clearStoreEmbeddings(storeName) {
    const table = SQLITE_VEC_TABLES[storeName];
    if (!table) throw new Error(`clearStoreEmbeddings: unknown store "${storeName}"`);
    this.db.prepare(`DELETE FROM ${table}`).run();
  }

  async clearAllEmbeddings() {
    for (const table of Object.values(SQLITE_VEC_TABLES)) {
      this.db.prepare(`DELETE FROM ${table}`).run();
    }
  }

  // Drops and recreates every vec0 sidecar table at the new dimension. Needed
  // because vec0 columns are FLOAT[N] fixed at CREATE time — a plain
  // clearAllEmbeddings() empties the rows but leaves every subsequent insert
  // at the old N failing once EMBEDDING_DIMS changes.
  async resizeVectorStorage(dims) {
    if (!Number.isInteger(dims) || dims <= 0 || dims > SQLITE_VEC_MAX_DIMS) {
      throw new Error(`resizeVectorStorage: invalid dims ${dims} (must be an integer from 1 to ${SQLITE_VEC_MAX_DIMS})`);
    }
    const tables = Object.values(SQLITE_VEC_TABLES);
    // sqlite-vec's vec0 CREATE VIRTUAL TABLE does not participate in
    // SQLite's transaction rollback (confirmed empirically: its shadow-table
    // setup commits independently of an enclosing BEGIN/ROLLBACK), so this
    // loop can't be made atomic with a wrapping transaction the way ordinary
    // DDL could. The dims-range check above is the real defense — it
    // eliminates the only failure this loop was actually hitting in
    // practice (a width above sqlite-vec's max). Anything else that fails
    // mid-loop is fatal with a diagnostic naming exactly which tables were
    // and weren't replaced, rather than continuing into a half-resized DB.
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      try {
        this.db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
        // Without the extension the sidecar is an ordinary table of the same
        // name and width, so the resize keeps the schema self-consistent (and
        // getVectorDims() readable) even though nothing will KNN-query it.
        this.db.prepare(
          this.vectorSupported
            ? `CREATE VIRTUAL TABLE ${table} USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${dims}])`
            : fallbackVecTableSql(table, dims)
        ).run();
      } catch (err) {
        const done = tables.slice(0, i);
        const notDone = tables.slice(i);
        throw new Error(
          `resizeVectorStorage: failed replacing ${table} (${err.message}) — already replaced at ${dims} dims: [${done.join(", ") || "none"}]; not replaced: [${notDone.join(", ")}]`
        );
      }
    }
  }

  // Physical width of vec_memories, read from the table's own CREATE SQL
  // rather than trusting the stored fingerprint — a freshly-created DB
  // (migrations hardcode FLOAT[1024]) or a DB upgraded from before
  // resizeVectorStorage existed can both have a fingerprint that already
  // claims the configured dims without storage ever having been resized.
  async getVectorDims() {
    const row = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_memories'`
    ).get();
    const match = row?.sql?.match(/FLOAT\[(\d+)\]/);
    return match ? parseInt(match[1], 10) : null;
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
    // Mark citing wiki articles stale before the delete cascades away the
    // source links — same staleness contract as update()'s tombstone path.
    this.db.prepare(`
      UPDATE wiki_articles SET status = 'stale'
       WHERE status = 'fresh'
         AND id IN (SELECT article_id FROM wiki_article_sources WHERE memory_id = ?)
    `).run(id);
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    await this.refreshCache();
    return row.title;
  }

  // Set-based purge for an owned tag/source namespace — e.g. the docgraph
  // bridge retiring every memory it promoted for a set of documents that
  // just left the index (#360). Matches purely at the SQL layer (source
  // exact-match + tag overlap), so a memory with a different `source` is
  // never touched even when its tags collide, and there is no row-count cap
  // the way recall() has — every matching row is found and deleted. Batched
  // by `batchSize` tags per round trip (a few queries total, not one per
  // document) and refreshes the cache once at the end rather than per row.
  // Returns the number of memories deleted.
  async deleteByTagsAndSource(tags, source, { batchSize = 500 } = {}) {
    if (!tags?.length) return 0;
    let deleted = 0;
    for (let i = 0; i < tags.length; i += batchSize) {
      const batch = tags.slice(i, i + batchSize);
      const tagPlaceholders = batch.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT id FROM memories m
         WHERE m.source = ?
           AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value IN (${tagPlaceholders}))
      `).all(source, ...batch);
      if (!rows.length) continue;
      const ids = rows.map(r => r.id);
      const idPlaceholders = ids.map(() => '?').join(',');
      this.db.prepare(`
        UPDATE wiki_articles SET status = 'stale'
         WHERE status = 'fresh'
           AND id IN (SELECT article_id FROM wiki_article_sources WHERE memory_id IN (${idPlaceholders}))
      `).run(...ids);
      this.db.prepare(`DELETE FROM memories WHERE id IN (${idPlaceholders})`).run(...ids);
      deleted += ids.length;
    }
    if (deleted) await this.refreshCache();
    return deleted;
  }

  // ── Recall (hybrid / semantic / fulltext) ─────────────────────────────────
  async recall(args) {
    return recallMemories(this.db, args);
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

  // ── Wiki drafts (parity with PostgresStore — api-wiki.js and the
  //    wiki_propose handler call these on the top-level store, not store.wiki) ─
  async proposeWikiDraft(draft) {
    return this.wiki.proposeDraft(draft);
  }

  async listWikiDrafts() {
    const rows = this.db.prepare(`
      SELECT id, slug, title, summary, tags, generated_by, generated_at, revision
        FROM wiki_articles WHERE status = 'draft' ORDER BY generated_at DESC
    `).all();
    return rows.map(r => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));
  }

  async publishWikiDraft(slug) {
    const row = this.db.prepare(`SELECT id FROM wiki_articles WHERE slug = ? AND status = 'draft'`).get(slug);
    if (!row) throw new Error(`Draft with slug "${slug}" not found`);
    this.db.prepare(`UPDATE wiki_articles SET status = 'fresh', generated_at = ? WHERE id = ?`)
      .run(nowIso(), row.id);
    return { id: row.id, slug, status: 'fresh' };
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

  async getModelFacts() {
    return this.db.prepare(`
      SELECT alias, hf,
             size_gb AS sizeGB,
             max_context AS maxContext,
             kv_bytes_per_token AS kvBytesPerToken,
             architecture,
             active_params AS activeParams,
             mmproj
        FROM model_facts
       ORDER BY alias
    `).all();
  }

  // ── Background-agent jobs + run history (Phase 4) ─────────────────────────
  // A job's heterogeneous shape lives in the `definition` JSON blob; id/enabled
  // are promoted columns. _rowToJob re-merges them into the flat object the
  // scheduler and API expect.
  _rowToJob(row) {
    if (!row) return null;
    const def = JSON.parse(row.definition);
    return normalizeAgentJobDefinition({
      id: row.id,
      enabled: !!row.enabled,
      ...def,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  async listAgentJobs() {
    const rows = this.db.prepare(`SELECT * FROM agent_jobs ORDER BY id`).all();
    return rows.map(r => this._rowToJob(r));
  }

  async getAgentJob(id) {
    return this._rowToJob(this.db.prepare(`SELECT * FROM agent_jobs WHERE id = ?`).get(id));
  }

  async upsertAgentJob(job) {
    const normalized = normalizeAgentJobDefinition(job);
    const { id, enabled = true, created_at, updated_at, ...definition } = normalized;
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
        (job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, model,
         error, tools, answer, artifact_count, artifact_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.jobId, run.startedAt, run.finishedAt ?? null, run.durationMs ?? null,
      run.verdict, run.mode ?? null, run.trigger ?? null, run.model ?? null, run.error ?? null,
      run.tools != null ? JSON.stringify(run.tools) : null, run.answer ?? null,
      run.artifactCount ?? 0, run.artifactBytes ?? 0,
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

  // ── Durable agent interrupts ──────────────────────────────────────────────
  _rowToAgentInterrupt(row) {
    if (!row) return null;
    return {
      id: row.id,
      session_id: row.session_id ?? null,
      run_id: row.run_id ?? null,
      tool_name: row.tool_name,
      canonical_arguments: parseJsonColumn(row.canonical_arguments),
      protected_payload_ref: parseJsonColumn(row.protected_payload_ref),
      digest: row.digest,
      allowed_decisions: parseJsonColumn(row.allowed_decisions),
      decision: row.decision ?? null,
      decision_payload: parseJsonColumn(row.decision_payload),
      claim_id: row.claim_id ?? null,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      decided_at: row.decided_at ?? null,
      claimed_at: row.claimed_at ?? null,
      completed_at: row.completed_at ?? null,
      expires_at: row.expires_at ?? null,
    };
  }

  async createAgentInterrupt(input) {
    const id = input.id ?? randomUUID();
    if (!input.sessionId && !input.runId) throw new Error("agent interrupt requires a sessionId or runId");
    if (!input.toolName) throw new Error("agent interrupt requires a toolName");
    if (!input.digest) throw new Error("agent interrupt requires a digest");
    if (!Array.isArray(input.allowedDecisions) || input.allowedDecisions.length === 0) {
      throw new Error("agent interrupt requires allowedDecisions");
    }
    const canonicalArguments = assertJsonPersistable(input.canonicalArguments, "canonicalArguments");
    const protectedPayloadRef = assertJsonPersistable(input.protectedPayloadRef, "protectedPayloadRef");
    if (canonicalArguments == null && protectedPayloadRef == null) {
      throw new Error("agent interrupt requires canonicalArguments or protectedPayloadRef");
    }
    const allowedDecisions = assertJsonPersistable(input.allowedDecisions, "allowedDecisions");
    this.db.prepare(`
      INSERT INTO agent_interrupts
        (id, session_id, run_id, tool_name, canonical_arguments, protected_payload_ref,
         digest, allowed_decisions, status, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sessionId ?? null,
      input.runId ?? null,
      input.toolName,
      canonicalArguments,
      protectedPayloadRef,
      input.digest,
      allowedDecisions,
      input.status ?? "pending",
      input.createdAt ?? nowIso(),
      input.updatedAt ?? input.createdAt ?? nowIso(),
      input.expiresAt ?? null,
    );
    return this.getAgentInterrupt(id);
  }

  async getAgentInterrupt(id) {
    return this._rowToAgentInterrupt(this.db.prepare(`SELECT * FROM agent_interrupts WHERE id = ?`).get(id));
  }

  async listAgentInterrupts({ sessionId, runId, status = "pending", includeExpired = false, limit = 50 } = {}) {
    const where = [];
    const params = {};
    if (sessionId) { where.push(`session_id = @sessionId`); params.sessionId = sessionId; }
    if (runId) { where.push(`run_id = @runId`); params.runId = runId; }
    if (status) { where.push(`status = @status`); params.status = status; }
    if (!includeExpired) {
      where.push(`(expires_at IS NULL OR expires_at > @now)`);
      params.now = nowIso();
    }
    params.limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const sql = `
      SELECT * FROM agent_interrupts
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT @limit
    `;
    return this.db.prepare(sql).all(params).map(r => this._rowToAgentInterrupt(r));
  }

  async updateAgentInterruptStatus(id, status) {
    const info = this.db.prepare(`
      UPDATE agent_interrupts
         SET status = ?, updated_at = ?
       WHERE id = ?
    `).run(status, nowIso(), id);
    return info.changes > 0 ? this.getAgentInterrupt(id) : null;
  }

  async expireAgentInterrupts(now = nowIso()) {
    const info = this.db.prepare(`
      UPDATE agent_interrupts
         SET status = 'expired', updated_at = ?
       WHERE status = 'pending'
         AND expires_at IS NOT NULL
         AND expires_at <= ?
    `).run(now, now);
    return info.changes;
  }

  async decideAgentInterrupt(id, { decision, status, decisionPayload = null, now = nowIso() }) {
    const payload = assertJsonPersistable(decisionPayload, "decisionPayload");
    const info = this.db.prepare(`
      UPDATE agent_interrupts
         SET decision = ?, decision_payload = ?, status = ?, decided_at = ?, updated_at = ?
       WHERE id = ?
         AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > ?)
    `).run(decision, payload, status, now, now, id, now);
    return info.changes > 0 ? this.getAgentInterrupt(id) : null;
  }

  async claimAgentInterrupt(id, { claimId, now = nowIso() }) {
    const info = this.db.prepare(`
      UPDATE agent_interrupts
         SET status = 'claimed', claim_id = ?, claimed_at = ?, updated_at = ?
       WHERE id = ?
         AND status IN ('approved', 'edited')
         AND (expires_at IS NULL OR expires_at > ?)
    `).run(claimId, now, now, id, now);
    return info.changes > 0 ? this.getAgentInterrupt(id) : null;
  }

  async completeAgentInterrupt(id, { status = "executed", now = nowIso() } = {}) {
    const info = this.db.prepare(`
      UPDATE agent_interrupts
         SET status = ?, completed_at = ?, updated_at = ?
       WHERE id = ?
         AND status = 'claimed'
    `).run(status, now, now, id);
    return info.changes > 0 ? this.getAgentInterrupt(id) : null;
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
