// db/postgres/portability.js
// Export / import of the whole store as one JSON document (Postgres half).
//
// Split out of db/postgres/store.js by S3.2 (aperio-reset) — the method bodies
// moved verbatim. The SQLite twin is db/sqlite/portability.js and the two are
// expected to stay surface-identical; see db/mixins.js for the pattern and
// tests/integration/db/contract/import-export.test.js for the shared contract.
import { normalizeAgentJobDefinition } from '../../lib/agent/job-spec.js';

export const withPortability = (Base) => class extends Base {
  // ── Data portability (export / import) ─────────────────────────────────────

  async exportAll() {
    const { rows: memories } = await this.pool.query(`
      SELECT id, type, title, content, tags, importance,
             expires_at, source, pinned, lang, confidence
        FROM memories
       WHERE valid_until IS NULL
       ORDER BY pinned DESC, importance DESC
    `);

    const { rows: articles } = await this.pool.query(`
      SELECT a.slug, a.title, a.summary, a.body_md, a.tags,
             a.generated_by, a.revision,
             COALESCE(json_agg(s.memory_id) FILTER (WHERE s.memory_id IS NOT NULL), '[]'::json) AS source_memory_ids
        FROM wiki_articles a
        LEFT JOIN wiki_article_sources s ON s.article_id = a.id
       WHERE a.status != 'archived'
       GROUP BY a.id, a.slug, a.title, a.summary, a.body_md, a.tags, a.generated_by, a.revision, a.generated_at
       ORDER BY a.generated_at DESC
    `);

    // ── Agent jobs + recent runs ─────────────────────────────────
    const { rows: agentRows } = await this.pool.query(
      `SELECT * FROM agent_jobs ORDER BY updated_at DESC`
    );
    const agent_jobs = agentRows.map(r => {
      const def = r.definition ? (typeof r.definition === 'string' ? JSON.parse(r.definition) : r.definition) : {};
      return { id: r.id, enabled: !!r.enabled, ...def, created_at: r.created_at, updated_at: r.updated_at };
    });

    const getRuns = await this.pool.query(
      `SELECT job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, model, error, tools, answer
         FROM agent_runs
        WHERE job_id = ANY($1)
        ORDER BY job_id, started_at DESC`, [agentRows.map(r => r.id)]
    );
    // Limit to 10 most recent per job
    const runsByJob = {};
    for (const r of getRuns.rows) {
      if (!runsByJob[r.job_id]) runsByJob[r.job_id] = [];
      if (runsByJob[r.job_id].length < 10) runsByJob[r.job_id].push(r);
    }
    const agent_runs = Object.values(runsByJob).flat();

    const { rows: selfRows } = await this.pool.query(`
      SELECT id, title, content, tags, importance, source, lang, confidence
        FROM self_memories
       ORDER BY importance DESC, created_at DESC
    `);
    const self_memories = selfRows.map(sm => ({
      id:         sm.id,
      title:      sm.title,
      content:    sm.content,
      tags:       sm.tags || [],
      importance: Number(sm.importance),
      source:     sm.source,
      lang:       sm.lang ?? 'english',
      confidence: sm.confidence !== null ? Number(sm.confidence) : 1.0,
    }));

    return {
      memories: memories.map(m => ({
        id:         m.id,
        type:       m.type,
        title:      m.title,
        content:    m.content,
        tags:       m.tags || [],
        importance: Number(m.importance),
        expires_at: m.expires_at,
        source:     m.source,
        pinned:     m.pinned,
        lang:       m.lang ?? 'english',
        confidence: m.confidence !== null ? Number(m.confidence) : 1.0,
      })),
      wiki_articles: articles.map(a => ({
        slug:              a.slug,
        title:             a.title,
        summary:           a.summary,
        body_md:           a.body_md,
        tags:              a.tags || [],
        generated_by:      a.generated_by,
        revision:          a.revision,
        source_memory_ids: a.source_memory_ids || [],
      })),
      agent_jobs,
      agent_runs,
      self_memories,
    };
  }

  async importAll({ memories = [], wiki_articles = [], agent_jobs = [], agent_runs = [], self_memories = [] }) {
    const result = {
      imported: { memories: 0, wiki: 0, jobs: 0, runs: 0, self_memories: 0 },
      skipped:  { memories: 0, wiki: 0, jobs: 0, runs: 0, self_memories: 0 },
    };

    for (const m of memories) {
      const { rowCount } = await this.pool.query(`
        INSERT INTO memories (id, type, title, content, tags, importance, expires_at, source, pinned, lang, confidence, valid_from)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
        ON CONFLICT (id) DO NOTHING
      `, [m.id, m.type, m.title, m.content, m.tags ?? [],
          m.importance ?? 3, m.expires_at ?? null, m.source ?? 'import',
          m.pinned ?? false, m.lang ?? 'english', m.confidence ?? 1.0]);
      rowCount > 0 ? result.imported.memories++ : result.skipped.memories++;
    }

    for (const a of wiki_articles) {
      const { rowCount } = await this.pool.query(`
        INSERT INTO wiki_articles (slug, title, summary, body_md, tags, generated_by, revision)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (slug) DO NOTHING
        RETURNING id
      `, [a.slug, a.title, a.summary ?? null, a.body_md,
          a.tags ?? [], a.generated_by ?? 'import', a.revision ?? 1]);

      if (rowCount > 0) {
        result.imported.wiki++;
        if (a.source_memory_ids?.length) {
          const wikiId = (await this.pool.query(`SELECT id FROM wiki_articles WHERE slug = $1`, [a.slug])).rows[0]?.id;
          if (wikiId) {
            for (const memId of a.source_memory_ids) {
              try {
                await this.pool.query(
                  `INSERT INTO wiki_article_sources (article_id, memory_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                  [wikiId, memId]
                );
              } catch { /* memory may not exist */ }
            }
          }
        }
      } else {
        result.skipped.wiki++;
      }
    }

    // ── Agent jobs ───────────────────────────────────────────────
    for (const j of agent_jobs) {
      const def = normalizeAgentJobDefinition(j);
      delete def.id; delete def.enabled; delete def.created_at; delete def.updated_at;
      const { rowCount } = await this.pool.query(`
        INSERT INTO agent_jobs (id, enabled, definition, updated_at)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (id) DO NOTHING
      `, [j.id, j.enabled ? true : false, JSON.stringify(def), j.updated_at ?? new Date().toISOString()]);
      rowCount > 0 ? result.imported.jobs++ : result.skipped.jobs++;
    }

    // ── Agent runs (dedup by job_id + started_at) ────────────────
    for (const r of agent_runs) {
      const { rowCount } = await this.pool.query(`
        INSERT INTO agent_runs
          (job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, model,
           error, tools, answer, artifact_count, artifact_bytes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT DO NOTHING
      `, [r.job_id, r.started_at, r.finished_at ?? null, r.duration_ms ?? null,
          r.verdict ?? null, r.mode ?? null, r.trigger ?? null, r.model ?? null,
          r.error ?? null, r.tools ?? null, r.answer ?? null,
          r.artifact_count ?? 0, r.artifact_bytes ?? 0]);
      rowCount > 0 ? result.imported.runs++ : result.skipped.runs++;
    }

    // ── Self-memories (dedup by id, like memories) ────────────────
    for (const sm of self_memories) {
      const { rowCount } = await this.pool.query(`
        INSERT INTO self_memories (id, title, content, tags, importance, source, lang, confidence, generated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id) DO NOTHING
      `, [sm.id, sm.title, sm.content, sm.tags ?? [],
          sm.importance ?? 3, sm.source ?? 'import', sm.lang ?? 'english', sm.confidence ?? 1.0,
          sm.generated_by ?? null]);
      rowCount > 0 ? result.imported.self_memories++ : result.skipped.self_memories++;
    }

    return result;
  }
};
