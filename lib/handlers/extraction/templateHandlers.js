// lib/handlers/extraction/templateHandlers.js
// CRUD over extraction_templates (Document Intelligence WS3, issue #250) plus
// the confirmed cold-start learning flow (T-G4.3): a document of an unseen
// shape only ever gets a persisted template through propose → user confirm →
// create. `create` itself is never exposed as a direct, unconfirmed MCP tool.
//
// Direct store.db (SQLite) / store.pool (Postgres) SQL — no dedicated
// sub-store class, mirroring selfWikiHandlers.js's inline store.pool block
// (the plan's explicit precedent; extraction_templates/extraction_log are
// small enough that a sub-store class would just be indirection).

import { AMOUNT_LABEL_ROLES, DATE_LABEL_ROLES } from "../../docgraph/extract-facts.js";
import { createInterruptService } from "../../security/interruptService.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const PROPOSAL_TTL_MS = 5 * 60 * 1000;
// Must equal the PUBLIC MCP tool name (mcp/tools/extraction.js's
// extraction_template_propose), not an internal-only label. The agent's
// tool-hook (lib/agent/tool-hooks.js) and CONFIRMABLE_TOOLS both key their
// self-confirmation guard off the tool name the MODEL actually calls — a
// mismatch here means the hook never recognizes this as a pending
// confirmation, never intercepts the raw token, and a model could silently
// approve its own template save by calling this tool a second time with the
// token it was never supposed to be trusted to see (review finding, P1).
const INTERRUPT_TOOL_NAME = "extraction_template_propose";

function userError(message) {
  return Object.assign(new Error(message), { userFacing: true });
}

function validateName(name) {
  if (!name || typeof name !== "string" || !SLUG_RE.test(name)) {
    throw userError(`template name must be lowercase kebab-case (e.g. "bg-utility-bill"), got "${name}"`);
  }
}

function validateKeywords(keywords) {
  if (!Array.isArray(keywords)) throw userError("match_keywords must be an array of strings");
  for (const k of keywords) {
    if (typeof k !== "string" || !k.trim()) throw userError("match_keywords entries must be non-empty strings");
  }
}

function validateFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) throw userError("fields must be a non-empty array");
  for (const [i, f] of fields.entries()) {
    if (!f || typeof f !== "object" || !f.name || typeof f.name !== "string") {
      throw userError(`fields[${i}] must have a "name"`);
    }
    if (!f.amount_label && !f.date_role) {
      throw userError(`fields[${i}] ("${f.name}") needs at least one of amount_label/date_role`);
    }
    if (f.amount_label && !AMOUNT_LABEL_ROLES.includes(f.amount_label)) {
      throw userError(`fields[${i}] ("${f.name}") amount_label "${f.amount_label}" is not a known extract-facts.js role (${AMOUNT_LABEL_ROLES.join(", ")})`);
    }
    if (f.date_role && !DATE_LABEL_ROLES.includes(f.date_role)) {
      throw userError(`fields[${i}] ("${f.name}") date_role "${f.date_role}" is not a known extract-facts.js role (${DATE_LABEL_ROLES.join(", ")})`);
    }
  }
}

function validateConfidence(confidence) {
  if (confidence !== undefined && (typeof confidence !== "number" || confidence < 0 || confidence > 1)) {
    throw userError("confidence must be a number between 0 and 1");
  }
}

function validateProposal({ name, match_keywords = [], fields }) {
  validateName(name);
  validateKeywords(match_keywords);
  validateFields(fields);
}

function rowFromSqlite(row) {
  if (!row) return null;
  return { ...row, match_keywords: JSON.parse(row.match_keywords), fields: JSON.parse(row.fields) };
}

export async function create(store, { name, match_keywords = [], fields, confidence = 0 }) {
  validateName(name);
  validateKeywords(match_keywords);
  validateFields(fields);
  validateConfidence(confidence);

  if (store.db) {
    try {
      const info = store.db.prepare(`
        INSERT INTO extraction_templates (name, match_keywords, fields, confidence)
        VALUES (?, ?, ?, ?)
      `).run(name, JSON.stringify(match_keywords), JSON.stringify(fields), confidence);
      return get(store, { id: info.lastInsertRowid });
    } catch (err) {
      if (/UNIQUE constraint failed/.test(err.message)) throw userError(`a template named "${name}" already exists`);
      throw err;
    }
  }

  try {
    const { rows } = await store.pool.query(
      `INSERT INTO extraction_templates (name, match_keywords, fields, confidence)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, JSON.stringify(match_keywords), JSON.stringify(fields), confidence]
    );
    return rows[0];
  } catch (err) {
    if (err.code === "23505") throw userError(`a template named "${name}" already exists`);
    throw err;
  }
}

export async function get(store, { id, name } = {}) {
  if (id == null && !name) throw userError("get requires an id or a name");
  if (store.db) {
    const row = id != null
      ? store.db.prepare(`SELECT * FROM extraction_templates WHERE id = ?`).get(id)
      : store.db.prepare(`SELECT * FROM extraction_templates WHERE name = ?`).get(name);
    return rowFromSqlite(row);
  }
  const { rows } = id != null
    ? await store.pool.query(`SELECT * FROM extraction_templates WHERE id = $1`, [id])
    : await store.pool.query(`SELECT * FROM extraction_templates WHERE name = $1`, [name]);
  return rows[0] ?? null;
}

export async function list(store) {
  if (store.db) {
    return store.db.prepare(`SELECT * FROM extraction_templates ORDER BY name`).all().map(rowFromSqlite);
  }
  const { rows } = await store.pool.query(`SELECT * FROM extraction_templates ORDER BY name`);
  return rows;
}

export async function update(store, { id, name, match_keywords, fields, confidence }) {
  if (id == null) throw userError("update requires an id");
  const existing = await get(store, { id });
  if (!existing) return null;

  if (name !== undefined) validateName(name);
  if (match_keywords !== undefined) validateKeywords(match_keywords);
  if (fields !== undefined) validateFields(fields);
  validateConfidence(confidence);

  const next = {
    name: name ?? existing.name,
    match_keywords: match_keywords ?? existing.match_keywords,
    fields: fields ?? existing.fields,
    confidence: confidence ?? existing.confidence,
  };

  if (store.db) {
    try {
      store.db.prepare(`
        UPDATE extraction_templates
           SET name = ?, match_keywords = ?, fields = ?, confidence = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?
      `).run(next.name, JSON.stringify(next.match_keywords), JSON.stringify(next.fields), next.confidence, id);
    } catch (err) {
      if (/UNIQUE constraint failed/.test(err.message)) throw userError(`a template named "${next.name}" already exists`);
      throw err;
    }
    return get(store, { id });
  }

  try {
    const { rows } = await store.pool.query(
      `UPDATE extraction_templates SET name=$1, match_keywords=$2, fields=$3, confidence=$4, updated_at=now()
       WHERE id=$5 RETURNING *`,
      [next.name, JSON.stringify(next.match_keywords), JSON.stringify(next.fields), next.confidence, id]
    );
    return rows[0] ?? null;
  } catch (err) {
    if (err.code === "23505") throw userError(`a template named "${next.name}" already exists`);
    throw err;
  }
}

export async function remove(store, { id, name } = {}) {
  if (id == null && !name) throw userError("remove requires an id or a name");
  if (store.db) {
    const info = id != null
      ? store.db.prepare(`DELETE FROM extraction_templates WHERE id = ?`).run(id)
      : store.db.prepare(`DELETE FROM extraction_templates WHERE name = ?`).run(name);
    return info.changes > 0;
  }
  const result = id != null
    ? await store.pool.query(`DELETE FROM extraction_templates WHERE id = $1`, [id])
    : await store.pool.query(`DELETE FROM extraction_templates WHERE name = $1`, [name]);
  return result.rowCount > 0;
}

// ─── Confirmed cold-start learning (T-G4.3) ──────────────────────────────────
// Reuses the generic createInterruptService (agent_interrupts table, already
// proven by db_execute) with its own toolName so a proposed template can
// never be confused with a pending database write. `create` above is the
// executeTool — only a confirmed decision ever calls it.

export function templateInterruptService(ctx) {
  return createInterruptService({
    store: ctx.store,
    revalidate: ({ canonicalArguments }) => { validateProposal(canonicalArguments); return canonicalArguments; },
    executeTool: async (toolName, args) => {
      if (toolName !== INTERRUPT_TOOL_NAME) throw new Error(`Unsupported extraction interrupt tool: ${toolName}`);
      return create(ctx.store, args);
    },
  });
}

const proposalToken = () => "tpl_" + Math.random().toString(36).slice(2, 10);

export async function proposeTemplate(ctx, { name, match_keywords = [], fields, confidence = 0 }) {
  validateProposal({ name, match_keywords, fields });
  const token = proposalToken();
  await templateInterruptService(ctx).create({
    id: token,
    sessionId: ctx?.sessionId ?? process.env.APERIO_SESSION_ID ?? "mcp-extraction-actions",
    runId: ctx?.runId ?? process.env.APERIO_RUN_ID ?? null,
    toolName: INTERRUPT_TOOL_NAME,
    canonicalArguments: { name, match_keywords, fields, confidence },
    allowedDecisions: ["approve", "edit", "reject", "respond"],
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
  });
  return { token, proposal: { name, match_keywords, fields, confidence } };
}

export async function decideTemplateProposal(ctx, token, decisionInput = {}) {
  const service = templateInterruptService(ctx);
  const decision = decisionInput.decision;
  if (decision === "approve" || decision === "edit") {
    const row = await service.decide(token, { decision, editedArguments: decisionInput.editedArguments });
    if (!row || row.status === "expired") {
      return { row, template: null, error: "Confirmation token invalid or expired. Nothing was saved." };
    }
    const executed = await service.claimAndExecute(token);
    return { row: executed.interrupt, template: executed.result };
  }
  const row = await service.decide(token, { decision, response: decisionInput.response });
  return { row, template: null };
}
