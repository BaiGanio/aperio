// db/sqlite/agentJobs.js
// Background-agent job definitions and their run history (SQLite half).
//
// Split out of db/sqlite/store.js by S3.2 (aperio-reset) — the method bodies
// moved verbatim. The Postgres twin is db/postgres/agentJobs.js; the shared
// contract is tests/integration/db/contract/agent-jobs.test.js.
import { normalizeAgentJobDefinition } from '../../lib/agent/job-spec.js';
import { nowIso } from './mappers.js';

export const withAgentJobs = (Base) => class extends Base {
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
};
