// db/sqlite/agentInterrupts.js
// Durable agent interrupts: the persisted half of an in-flight action waiting
// on a human decision, so a confirm survives a server restart (SQLite half).
//
// Split out of db/sqlite/store.js by S3.2 (aperio-reset) — the method bodies
// moved verbatim. The Postgres twin is db/postgres/agentInterrupts.js; the
// shared contract is tests/integration/db/contract/agent-interrupts.test.js.
import { randomUUID } from 'node:crypto';
import { assertJsonPersistable, nowIso, parseJsonColumn } from './mappers.js';

export const withAgentInterrupts = (Base) => class extends Base {
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
};
