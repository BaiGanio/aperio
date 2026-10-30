// db/postgres/agentInterrupts.js
// Durable agent interrupts: the persisted half of an in-flight action waiting
// on a human decision, so a confirm survives a server restart (Postgres half).
//
// Split out of db/postgres/store.js by S3.2 (aperio-reset) — the method bodies
// moved verbatim. The SQLite twin is db/sqlite/agentInterrupts.js; the shared
// contract is tests/integration/db/contract/agent-interrupts.test.js.
import { randomUUID } from 'node:crypto';
import { assertJsonPersistable, toIso } from './mappers.js';

export const withAgentInterrupts = (Base) => class extends Base {
  // ── Durable agent interrupts ──────────────────────────────────────────────
  _rowToAgentInterrupt(row) {
    if (!row) return null;
    return {
      id: row.id,
      session_id: row.session_id ?? null,
      run_id: row.run_id ?? null,
      tool_name: row.tool_name,
      canonical_arguments: row.canonical_arguments ?? null,
      protected_payload_ref: row.protected_payload_ref ?? null,
      digest: row.digest,
      allowed_decisions: row.allowed_decisions,
      decision: row.decision ?? null,
      decision_payload: row.decision_payload ?? null,
      claim_id: row.claim_id ?? null,
      status: row.status,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
      decided_at: toIso(row.decided_at) ?? null,
      claimed_at: toIso(row.claimed_at) ?? null,
      completed_at: toIso(row.completed_at) ?? null,
      expires_at: toIso(row.expires_at) ?? null,
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
    const { rows } = await this.pool.query(
      `INSERT INTO agent_interrupts
         (id, session_id, run_id, tool_name, canonical_arguments, protected_payload_ref,
          digest, allowed_decisions, status, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12)
       RETURNING *`,
      [
        id,
        input.sessionId ?? null,
        input.runId ?? null,
        input.toolName,
        canonicalArguments,
        protectedPayloadRef,
        input.digest,
        allowedDecisions,
        input.status ?? "pending",
        input.createdAt ?? new Date().toISOString(),
        input.updatedAt ?? input.createdAt ?? new Date().toISOString(),
        input.expiresAt ?? null,
      ]
    );
    return this._rowToAgentInterrupt(rows[0]);
  }

  async getAgentInterrupt(id) {
    const { rows } = await this.pool.query(`SELECT * FROM agent_interrupts WHERE id = $1`, [id]);
    return this._rowToAgentInterrupt(rows[0]);
  }

  async listAgentInterrupts({ sessionId, runId, status = "pending", includeExpired = false, limit = 50 } = {}) {
    const where = [];
    const values = [];
    const push = value => {
      values.push(value);
      return `$${values.length}`;
    };
    if (sessionId) where.push(`session_id = ${push(sessionId)}`);
    if (runId) where.push(`run_id = ${push(runId)}`);
    if (status) where.push(`status = ${push(status)}`);
    if (!includeExpired) where.push(`(expires_at IS NULL OR expires_at > ${push(new Date().toISOString())})`);
    values.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
    const sql = `
      SELECT * FROM agent_interrupts
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}
    `;
    const { rows } = await this.pool.query(sql, values);
    return rows.map(r => this._rowToAgentInterrupt(r));
  }

  async updateAgentInterruptStatus(id, status) {
    const { rows } = await this.pool.query(
      `UPDATE agent_interrupts
          SET status = $2, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, status]
    );
    return this._rowToAgentInterrupt(rows[0]);
  }

  async expireAgentInterrupts(now = new Date().toISOString()) {
    const { rowCount } = await this.pool.query(
      `UPDATE agent_interrupts
          SET status = 'expired', updated_at = $1
        WHERE status = 'pending'
          AND expires_at IS NOT NULL
          AND expires_at <= $1`,
      [now]
    );
    return rowCount;
  }

  async decideAgentInterrupt(id, { decision, status, decisionPayload = null, now = new Date().toISOString() }) {
    const payload = assertJsonPersistable(decisionPayload, "decisionPayload");
    const { rows } = await this.pool.query(
      `UPDATE agent_interrupts
          SET decision = $2, decision_payload = $3::jsonb, status = $4, decided_at = $5, updated_at = $5
        WHERE id = $1
          AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > $5)
        RETURNING *`,
      [id, decision, payload, status, now]
    );
    return this._rowToAgentInterrupt(rows[0]);
  }

  async claimAgentInterrupt(id, { claimId, now = new Date().toISOString() }) {
    const { rows } = await this.pool.query(
      `UPDATE agent_interrupts
          SET status = 'claimed', claim_id = $2, claimed_at = $3, updated_at = $3
        WHERE id = $1
          AND status IN ('approved', 'edited')
          AND (expires_at IS NULL OR expires_at > $3)
        RETURNING *`,
      [id, claimId, now]
    );
    return this._rowToAgentInterrupt(rows[0]);
  }

  async completeAgentInterrupt(id, { status = "executed", now = new Date().toISOString() } = {}) {
    const { rows } = await this.pool.query(
      `UPDATE agent_interrupts
          SET status = $2, completed_at = $3, updated_at = $3
        WHERE id = $1
          AND status = 'claimed'
        RETURNING *`,
      [id, status, now]
    );
    return this._rowToAgentInterrupt(rows[0]);
  }
};
