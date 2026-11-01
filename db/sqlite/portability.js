// db/sqlite/portability.js
// Export / import of the whole store as one JSON document (SQLite half).
//
// Split out of db/sqlite/store.js by S3.2 (aperio-reset) — the method bodies
// moved verbatim. The Postgres twin is db/postgres/portability.js and the two
// are expected to stay surface-identical; see db/mixins.js for the pattern and
// tests/integration/db/contract/import-export.test.js for the shared contract.
import { randomUUID } from 'node:crypto';
import { normalizeAgentJobDefinition } from '../../lib/agent/job-spec.js';
import { nowIso } from './mappers.js';

export const withPortability = (Base) => class extends Base {
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
};
