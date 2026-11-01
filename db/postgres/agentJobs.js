// db/postgres/agentJobs.js
// Background-agent job definitions and their run history (Postgres half).
//
// Split out of db/postgres/store.js by S3.2 (aperio-reset) — the method bodies
// moved verbatim. The SQLite twin is db/sqlite/agentJobs.js; the shared
// contract is tests/integration/db/contract/agent-jobs.test.js.
import { normalizeAgentJobDefinition } from '../../lib/agent/job-spec.js';
import { toIso } from './mappers.js';

export const withAgentJobs = (Base) => class extends Base {
  // ── Background-agent jobs + run history (Phase 4) ─────────────────────────
  // definition is JSONB; pg parses it back to a JS object on read. _rowToJob
  // re-merges id/enabled into the flat object the scheduler and API expect.
  _rowToJob(row) {
    if (!row) return null;
    return normalizeAgentJobDefinition({
      id: row.id,
      enabled: row.enabled,
      ...row.definition,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    });
  }

  async listAgentJobs() {
    const { rows } = await this.pool.query(`SELECT * FROM agent_jobs ORDER BY id`);
    return rows.map(r => this._rowToJob(r));
  }

  async getAgentJob(id) {
    const { rows } = await this.pool.query(`SELECT * FROM agent_jobs WHERE id = $1`, [id]);
    return this._rowToJob(rows[0]);
  }

  async upsertAgentJob(job) {
    const normalized = normalizeAgentJobDefinition(job);
    const { id, enabled = true, created_at, updated_at, ...definition } = normalized;
    if (!id) throw new Error("agent job requires an id");
    await this.pool.query(
      `INSERT INTO agent_jobs (id, enabled, definition, updated_at)
         VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (id) DO UPDATE
         SET enabled = EXCLUDED.enabled, definition = EXCLUDED.definition, updated_at = now()`,
      [id, !!enabled, JSON.stringify(definition)]
    );
    return this.getAgentJob(id);
  }

  async deleteAgentJob(id) {
    const { rows } = await this.pool.query(`DELETE FROM agent_jobs WHERE id = $1 RETURNING id`, [id]);
    return rows.length > 0;
  }

  async recordAgentRun(run) {
    const { rows } = await this.pool.query(
      `INSERT INTO agent_runs
         (job_id, started_at, finished_at, duration_ms, verdict, mode, trigger, model,
          error, tools, answer, artifact_count, artifact_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
         RETURNING id`,
      [
        run.jobId, run.startedAt, run.finishedAt ?? null, run.durationMs ?? null,
        run.verdict, run.mode ?? null, run.trigger ?? null, run.model ?? null, run.error ?? null,
        run.tools != null ? JSON.stringify(run.tools) : null, run.answer ?? null,
        run.artifactCount ?? 0, run.artifactBytes ?? 0,
      ]
    );
    return rows[0].id;
  }

  async listAgentRuns(jobId, limit = 20) {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_runs WHERE job_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2`,
      [jobId, limit]
    );
    return rows.map(r => ({ ...r, started_at: toIso(r.started_at), finished_at: toIso(r.finished_at) }));
  }

  // Delete one run by id (manual cleanup from the History view). Returns true
  // when a row was removed.
  async deleteAgentRun(runId) {
    const { rowCount } = await this.pool.query(`DELETE FROM agent_runs WHERE id = $1`, [runId]);
    return rowCount > 0;
  }

  // Garbage-collect runs older than `retentionDays` (the run-history sibling of
  // pruneOldSessions). started_at is an ISO-8601 string. Returns the count removed.
  async pruneAgentRuns(retentionDays) {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const { rowCount } = await this.pool.query(`DELETE FROM agent_runs WHERE started_at < $1`, [cutoff]);
    return rowCount;
  }
};
