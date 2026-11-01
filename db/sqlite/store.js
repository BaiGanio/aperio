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

// Per-domain mixins. Each holds the methods of one cohesive responsibility,
// moved verbatim out of this file by S3.2 (aperio-reset); db/postgres/store.js
// composes a mirror set under the same names. See db/mixins.js for why these
// are mixins rather than helper modules, and
// tests/unit/db/store-surface-parity.test.js for the guard that fails if one
// backend gains or loses a method the other does not.
import { composeStore } from '../mixins.js';
import { withPortability } from './portability.js';
import { withVectorMeta } from './vectorMeta.js';
import { withSelfMemories } from './selfMemories.js';
import { withAgentJobs } from './agentJobs.js';
import { withAgentInterrupts } from './agentInterrupts.js';
import { withIssueTriage } from './issueTriage.js';

const SqliteStoreBase = composeStore(
  withPortability,
  withVectorMeta,
  withSelfMemories,
  withAgentJobs,
  withAgentInterrupts,
  withIssueTriage,
);

const EMBED_DIMS = parseInt(process.env.EMBEDDING_DIMS || '1024', 10);
const DEFAULT_PATH = process.env.SQLITE_PATH || './.sqlite/aperio.db';
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
// ── Main store ──────────────────────────────────────────────────────────────
export class SqliteStore extends SqliteStoreBase {
  constructor(db) {
    super();
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

}
