// db/postgres/store.js
// Power-user backend — requires Docker + pgvector.
// Matches migrations 001_init.sql + 002_pgvector.sql + 003_fts_lang.sql exactly.

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../migrate.js';
import { DB_TABLES, isAllowedTable } from '../tables.js';
import { MEMORY_SEED } from '../memory-seed.js';
import { MEMORY_SEED_LITE } from '../memory-seed-lite.js';
import { WIKI_SEED } from '../wiki-seed.js';
import { SELF_MEMORY_SEED } from '../self-memory-seed.js';
import { AGENT_JOB_SEED } from '../agent-job-seed.js';
import { normalizeAgentJobDefinition } from '../../lib/agent/job-spec.js';
import logger from '../../lib/helpers/logger.js';
import { assertJsonPersistable, isUuid, rowToMemory, rowToSelf, toIso, toVec } from './mappers.js';
import { recallMemories, recallSelfMemories } from './search.js';

// Per-domain mixins. Each holds the methods of one cohesive responsibility,
// moved verbatim out of this file by S3.2 (aperio-reset); db/sqlite/store.js
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

const PostgresStoreBase = composeStore(
  withPortability,
  withVectorMeta,
  withSelfMemories,
  withAgentJobs,
  withAgentInterrupts,
  withIssueTriage,
);

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

export class PostgresStore extends PostgresStoreBase {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  static async init() {
    assertNonDefaultDbUrl(process.env.DATABASE_URL);
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await runMigrations(pool);
    const store = new PostgresStore(pool);
    await store.seedBaseline();
    return store;
  }

  // Seed baseline memories / wiki / self-memories on a fresh, empty database
  // (parity with the SQLite backend). Each table is guarded by its own count so
  // existing deployments are never touched. Best-effort: a failure here must
  // never block server boot, so it's wrapped and swallowed with a warning.
  async seedBaseline() {
    try {
      const count = async (t) => (await this.pool.query(`SELECT COUNT(*)::int AS c FROM ${t}`)).rows[0].c;

      if (await count('memories') === 0) {
        // The lite profile (APERIO_LITE=on) gets the non-coder starter set.
        const memorySeed = process.env.APERIO_LITE === 'on' ? MEMORY_SEED_LITE : MEMORY_SEED;
        for (const m of memorySeed) {
          await this.pool.query(
            `INSERT INTO memories (id, type, title, content, tags, importance, source, pinned, lang, confidence, valid_from)
             VALUES ($1,$2,$3,$4,$5,$6,'system',$7,'english',1.0, now()) ON CONFLICT (id) DO NOTHING`,
            [randomUUID(), m.type, m.title, m.content, m.tags ?? [], m.importance ?? 3, m.pinned ?? false]);
        }
      }
      if (await count('wiki_articles') === 0) {
        for (const a of WIKI_SEED) {
          await this.pool.query(
            `INSERT INTO wiki_articles (slug, title, summary, body_md, tags, generated_by, revision)
             VALUES ($1,$2,$3,$4,$5,'system',1) ON CONFLICT (slug) DO NOTHING`,
            [a.slug, a.title, a.summary ?? null, a.body_md, a.tags ?? []]);
        }
      }
      if (await count('self_memories') === 0) {
        for (const s of SELF_MEMORY_SEED) {
          await this.pool.query(
            `INSERT INTO self_memories (title, content, tags, importance, source, lang, confidence, generated_by)
             VALUES ($1,$2,$3,$4,'system','english',1.0,'seed')`,
            [s.title, s.content, s.tags ?? [], s.importance ?? 3]);
        }
      }
      if (await count('agent_jobs') === 0) {
        for (const job of AGENT_JOB_SEED) {
          const { id, enabled, created_at, updated_at, ...definition } = normalizeAgentJobDefinition(job);
          await this.pool.query(
            `INSERT INTO agent_jobs (id, enabled, definition, updated_at)
             VALUES ($1,$2,$3::jsonb, now()) ON CONFLICT (id) DO NOTHING`,
            [id, !!enabled, JSON.stringify(definition)]);
        }
      }
    } catch (err) {
      // logger (not console) so the line lands on stderr in MCP mode — stdout
      // is the JSON-RPC channel there. err.message is interpolated into the
      // message itself: this logger has no splat format, so a second argument
      // would be dropped and the failure would become undiagnosable.
      logger.warn(`[postgres] baseline seed skipped: ${err.message}`);
    }
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
         (type, title, content, tags, importance, tier, expires_at, source, embedding, lang, confidence, valid_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       RETURNING *`,
      [
        input.type, input.title, input.content,
        input.tags ?? [], input.importance ?? 3,
        input.tier ?? 1,
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
              (type, title, content, tags, importance, tier, expires_at, source, confidence, valid_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
           RETURNING *`,
          [
            input.type, input.title, input.content,
            input.tags ?? [], input.importance ?? 3,
            input.tier ?? 1,
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
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query(
      `SELECT * FROM memories WHERE id = $1`, [id]
    );
    return rows.length ? rowToMemory(rows[0]) : null;
  }

  // ── Pending memories (inbox) ─────────────────────────────────────────────
  async insertPending(input) {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO pending_memories
         (id, type, title, content, tags, importance, tier, source, lang, confidence, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, title, type`,
      [id, input.type ?? 'fact', input.title, input.content,
       input.tags ?? [], input.importance ?? 3, input.tier ?? 1,
       input.source ?? 'agent', input.lang ?? 'english',
       input.confidence ?? 1.0, input.session_id ?? null]
    );
    return { ...rows[0], status: 'pending' };
  }

  async listPending() {
    const { rows } = await this.pool.query(
      `SELECT * FROM pending_memories WHERE status = 'pending' ORDER BY proposed_at DESC`
    );
    return rows;
  }

  async countPending() {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS c FROM pending_memories WHERE status = 'pending'`
    );
    return rows[0].c;
  }

  // The memory insert runs on THIS client (not this.insert(), which grabs its
  // own autocommit connection from the pool and would commit outside this
  // transaction) so a rollback here can't leave an orphaned promoted memory
  // behind. `FOR UPDATE` takes the row lock at the SELECT, and the UPDATE is
  // re-guarded by `AND status = 'pending'` with its row count checked, so a
  // second concurrent approval of the same id blocks on the lock, then — once
  // this transaction commits — finds the row no longer pending and fails
  // loudly instead of silently promoting a duplicate memory.
  async approvePending(id) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [row] } = await client.query(
        `SELECT * FROM pending_memories WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id]
      );
      if (!row) throw new Error(`Pending memory ${id} not found`);

      const { rows: [mem] } = await client.query(
        `INSERT INTO memories
           (type, title, content, tags, importance, tier, expires_at, source, embedding, lang, confidence, valid_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         RETURNING id, title`,
        [row.type, row.title, row.content, row.tags, row.importance, row.tier,
         null, row.source, null, row.lang, row.confidence]
      );

      const { rowCount } = await client.query(
        `UPDATE pending_memories SET status = 'approved', reviewed_at = NOW() WHERE id = $1 AND status = 'pending'`, [id]
      );
      if (rowCount === 0) throw new Error(`Pending memory ${id} was already reviewed`);

      await client.query('COMMIT');
      return { id: mem.id, title: mem.title };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async rejectPending(id) {
    const { rowCount } = await this.pool.query(
      `UPDATE pending_memories SET status = 'rejected', reviewed_at = NOW()
        WHERE id = $1 AND status = 'pending'`, [id]
    );
    if (!rowCount) throw new Error(`Pending memory ${id} not found`);
    return { id, status: 'rejected' };
  }

  async update(id, input, embedding) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the existing row so no concurrent transaction can tombstone
      // or modify this memory between the read and the write.
      const { rows: lockRows } = await client.query(
        `SELECT * FROM memories WHERE id = $1 FOR UPDATE`, [id]
      );
      const existing = lockRows.length ? rowToMemory(lockRows[0]) : null;
      if (!existing) throw new Error(`Memory ${id} not found`);
      if (existing.valid_until) throw new Error(`Memory ${id} has been superseded`);

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

      await client.query(
        `UPDATE memories SET valid_until = now() WHERE id = $1`, [id]
      );
      const { rows } = await client.query(
        `INSERT INTO memories
           (type, title, content, tags, importance, tier, expires_at, source, embedding, lang, confidence, valid_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         RETURNING *`,
        [
          merged.type, merged.title, merged.content,
          merged.tags, merged.importance,
          merged.tier ?? 1,
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
    if (!isUuid(id)) return;
    await this.pool.query(
      `UPDATE memories SET embedding = $1 WHERE id = $2`,
      [toVec(embedding), id]
    );
  }

  async hasEmbedding(id) {
    if (!isUuid(id)) return false;
    const { rows } = await this.pool.query(
      `SELECT 1 FROM memories WHERE id = $1 AND embedding IS NOT NULL`, [id]
    );
    return rows.length > 0;
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
    if (!isUuid(id)) return false;
    const { rows } = await this.pool.query(
      `UPDATE memories SET pinned = $1 WHERE id = $2 AND valid_until IS NULL RETURNING id`,
      [!!pinned, id]
    );
    return rows.length > 0;
  }

  async setExpiry(id, expiresAt) {
    if (!isUuid(id)) return false;
    const { rows } = await this.pool.query(
      `UPDATE memories SET expires_at = $1 WHERE id = $2 AND valid_until IS NULL RETURNING id`,
      [expiresAt ? new Date(expiresAt) : null, id]
    );
    return rows.length > 0;
  }

  async recall(args) {
    return recallMemories(this.pool, args);
  }

  // `limit`/`offset` let the reindex driver walk a large corpus in bounded
  // pages instead of holding every pending row's full text in memory at once.
  // The ORDER BY is what makes an offset mean the same thing across calls.
  async listWithoutEmbeddings({ limit = null, offset = 0 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT id, title, content FROM memories
        WHERE embedding IS NULL AND valid_until IS NULL
        ORDER BY id LIMIT $1 OFFSET $2`,
      [limit, offset]
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
    if (!isUuid(id_a) || !isUuid(id_b)) return;
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
    if (!isUuid(id)) return null;
    // Mark citing wiki articles stale before the delete cascades away the
    // source links — same staleness contract as update()'s tombstone path.
    await this.pool.query(`
      UPDATE wiki_articles SET status = 'stale'
       WHERE status = 'fresh'
         AND id IN (SELECT article_id FROM wiki_article_sources WHERE memory_id = $1)
    `, [id]);
    const { rows } = await this.pool.query(
      `DELETE FROM memories WHERE id = $1 RETURNING title`, [id]
    );
    return rows[0]?.title ?? null;
  }

  // Set-based purge for an owned tag/source namespace — e.g. the docgraph
  // bridge retiring every memory it promoted for a set of documents that
  // just left the index (#360). Matches purely at the SQL layer (source
  // exact-match + `tags && $` array overlap), so a memory with a different
  // `source` is never touched even when its tags collide, and there is no
  // row-count cap the way recall() has — every matching row is found and
  // deleted. Batched by `batchSize` tags per round trip (a few queries
  // total, not one per document). Returns the number of memories deleted.
  async deleteByTagsAndSource(tags, source, { batchSize = 500 } = {}) {
    if (!tags?.length) return 0;
    let deleted = 0;
    for (let i = 0; i < tags.length; i += batchSize) {
      const batch = tags.slice(i, i + batchSize);
      const { rows } = await this.pool.query(
        `SELECT id FROM memories WHERE source = $1 AND tags && $2`, [source, batch]
      );
      if (!rows.length) continue;
      const ids = rows.map(r => r.id);
      await this.pool.query(`
        UPDATE wiki_articles SET status = 'stale'
         WHERE status = 'fresh'
           AND id IN (SELECT article_id FROM wiki_article_sources WHERE memory_id = ANY($1))
      `, [ids]);
      await this.pool.query(`DELETE FROM memories WHERE id = ANY($1)`, [ids]);
      deleted += ids.length;
    }
    return deleted;
  }

  // ── Wiki drafts ──────────────────────────────────────────────────────────
  async proposeWikiDraft({ slug, title, summary, body_md, tags, generated_by, source_memory_ids }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID();
      await client.query(
        `INSERT INTO wiki_articles (id, slug, title, summary, body_md, tags, generated_by, revision, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,'draft')`,
        [id, slug, title, summary ?? null, body_md, tags ?? [], generated_by ?? null]
      );
      for (const memId of (source_memory_ids ?? [])) {
        try {
          await client.query(
            `INSERT INTO wiki_article_sources (article_id, memory_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, memId]
          );
        } catch { /* memory may not exist */ }
      }
      await client.query('COMMIT');
      return { id, slug, revision: 1 };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  }

  async listWikiDrafts() {
    const { rows } = await this.pool.query(
      `SELECT id, slug, title, summary, tags, generated_by, generated_at, revision
         FROM wiki_articles WHERE status = 'draft' ORDER BY generated_at DESC`
    );
    return rows;
  }

  async publishWikiDraft(slug) {
    const { rows: [row] } = await this.pool.query(
      `UPDATE wiki_articles SET status = 'fresh', generated_at = NOW()
        WHERE slug = $1 AND status = 'draft'
        RETURNING id, slug`,
      [slug]
    );
    if (!row) throw new Error(`Draft with slug "${slug}" not found`);
    return { id: row.id, slug, status: 'fresh' };
  }

  // ── Settings (key/value preferences) ──────────────────────────────────────
  // value is JSONB; pg parses it back to a JS value on read.
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

  async getModelFacts() {
    const { rows } = await this.pool.query(`
      SELECT alias, hf, size_gb, max_context, kv_bytes_per_token,
             architecture, active_params, mmproj
        FROM model_facts
       ORDER BY alias
    `);
    return rows.map(row => ({
      alias: row.alias,
      hf: row.hf,
      sizeGB: Number(row.size_gb),
      maxContext: Number(row.max_context),
      kvBytesPerToken: Number(row.kv_bytes_per_token),
      architecture: row.architecture,
      activeParams: row.active_params == null ? null : Number(row.active_params),
      mmproj: row.mmproj,
    }));
  }

  async close() {
    await this.pool.end();
  }
}
