// lib/handlers/database/databaseHandlers.js
//
// HTTP / MCP handlers for the database tool (issue #170). Four surfaces:
//   db_connections — list available connections (no secrets)
//   db_schema      — introspect tables / columns / indexes / foreign keys
//   db_query       — read path; runs freely, rejects anything not a single read
//   db_execute     — write/DDL path through the two-phase confirm-before-write
//                    flow (mirrors create_github_issue / delete_file)
//
// Reads run freely; mutating statements route through confirm. The classifier
// decides KIND; the driver enforces read-only at the connection level.

import { logError } from "../../helpers/logger.js";
import { classify } from "../../db-connect/classify.js";
import {
  listConnections, getDriver, BUILTIN_NAME,
} from "../../db-connect/registry.js";
import { createInterruptService } from "../../security/interruptService.js";

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

function asText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
function errText(msg) {
  return { content: [{ type: "text", text: `❌ ${msg}` }], isError: true };
}

function safeHandler(name, fn) {
  return async (ctx, args = {}) => {
    try { return await fn(ctx, args); }
    catch (err) {
      if (err.userFacing) return errText(err.message);
      logError(`[database] ${name} failed`, err, { args: redactArgs(args) });
      return errText(`db_${name} failed: ${err.message}`);
    }
  };
}

// Never log a raw SQL string or params at error time without bounding them.
function redactArgs(args) {
  const { sql, params, ...rest } = args;
  return { ...rest, ...(sql ? { sql: String(sql).slice(0, 200) } : {}), paramCount: Array.isArray(params) ? params.length : 0 };
}

const clampLimit = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(v), MAX_LIMIT);
};

// Weaker models pass the statement under a near-miss key (`query`, `statement`,
// `sql_query`) instead of `sql`. With the schema's sql made optional and
// .passthrough() preserving the extra key, recover the first string we find so
// the handler runs (and surfaces its own friendly "sql is required" otherwise)
// instead of bouncing the call with a raw zod -32602.
function pickSql(args) {
  for (const k of ["sql", "query", "statement", "sql_query", "stmt"]) {
    if (typeof args[k] === "string" && args[k].trim()) return args[k];
  }
  return args.sql;
}

// ─── db_connections ──────────────────────────────────────────────────────────
async function _connections(ctx) {
  return asText({ connections: await listConnections(ctx.store) });
}

// ─── db_schema ───────────────────────────────────────────────────────────────
async function _schema(ctx, { connection, table }) {
  const { driver, engine, name } = await getDriver(ctx.store, connection);
  try {
    if (table) {
      const info = await driver.describeTable(table);
      if (!info) return errText(`table "${table}" not found in connection "${name}".`);
      return asText({ connection: name, engine, ...info });
    }
    return asText({ connection: name, engine, tables: await driver.listTables() });
  } finally {
    await driver.close();
  }
}

// ─── db_query (read only) ────────────────────────────────────────────────────
async function _query(ctx, args) {
  const { connection, params = [], limit } = args;
  const sql = pickSql(args);
  if (!sql || !String(sql).trim()) return errText("`sql` is required.");
  const c = classify(sql);
  if (c.class !== "read") {
    return errText(
      c.class === "multi"
        ? "db_query runs ONE read statement at a time — remove the extra statement(s)."
        : `db_query only runs read statements (SELECT/WITH/EXPLAIN/PRAGMA/SHOW…). This is "${c.keyword || c.class}". ` +
          `Use db_execute for writes and DDL.`
    );
  }
  const { driver, engine, name } = await getDriver(ctx.store, connection);
  try {
    // Run the normalized single statement (comments stripped, no trailing ';').
    const result = await driver.runRead(c.statements[0], Array.isArray(params) ? params : [], clampLimit(limit));
    return asText({ connection: name, engine, ...result });
  } finally {
    await driver.close();
  }
}

// ─── db_execute (write / DDL, durable confirm-before-write) ──────────────────
const CONFIRM_TTL_MS = 5 * 60 * 1000;
const DB_INTERRUPT_SESSION_ID = "mcp-database-actions";
const fallbackInterruptStore = makeMemoryInterruptStore();

const actionToken = () => "db_" + Math.random().toString(36).slice(2, 8);
const readToken = (args) => args.confirmation_token ?? args.token ?? args.confirmationToken ?? null;

function nowIso() { return new Date().toISOString(); }
function expiresAtFromNow() { return new Date(Date.now() + CONFIRM_TTL_MS).toISOString(); }

function makeMemoryInterruptStore() {
  const rows = new Map();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const get = id => clone(rows.get(id) ?? null);
  return {
    async createAgentInterrupt(input) {
      const row = {
        id: input.id,
        session_id: input.sessionId ?? null,
        run_id: input.runId ?? null,
        tool_name: input.toolName,
        canonical_arguments: clone(input.canonicalArguments ?? null),
        protected_payload_ref: clone(input.protectedPayloadRef ?? null),
        digest: input.digest,
        allowed_decisions: clone(input.allowedDecisions),
        decision: null,
        decision_payload: null,
        claim_id: null,
        status: "pending",
        created_at: nowIso(),
        updated_at: nowIso(),
        decided_at: null,
        claimed_at: null,
        completed_at: null,
        expires_at: input.expiresAt ?? null,
      };
      rows.set(row.id, row);
      return get(row.id);
    },
    async getAgentInterrupt(id) { return get(id); },
    async listAgentInterrupts({ sessionId, status = "pending" } = {}) {
      return [...rows.values()]
        .filter(row => !sessionId || row.session_id === sessionId)
        .filter(row => !status || row.status === status)
        .map(row => clone(row));
    },
    async updateAgentInterruptStatus(id, status) {
      const row = rows.get(id);
      if (!row) return null;
      row.status = status;
      row.updated_at = nowIso();
      return get(id);
    },
    async expireAgentInterrupts(now = nowIso()) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.status === "pending" && row.expires_at && row.expires_at <= now) {
          row.status = "expired";
          row.updated_at = now;
          count++;
        }
      }
      return count;
    },
    async decideAgentInterrupt(id, { decision, status, decisionPayload = null, now = nowIso() }) {
      const row = rows.get(id);
      if (!row || row.status !== "pending" || (row.expires_at && row.expires_at <= now)) return null;
      row.decision = decision;
      row.decision_payload = clone(decisionPayload);
      row.status = status;
      row.decided_at = now;
      row.updated_at = now;
      return get(id);
    },
    async claimAgentInterrupt(id, { claimId, now = nowIso() }) {
      const row = rows.get(id);
      if (!row || !["approved", "edited"].includes(row.status) || (row.expires_at && row.expires_at <= now)) return null;
      row.status = "claimed";
      row.claim_id = claimId;
      row.claimed_at = now;
      row.updated_at = now;
      return get(id);
    },
    async completeAgentInterrupt(id, { status = "executed", now = nowIso() } = {}) {
      const row = rows.get(id);
      if (!row || row.status !== "claimed") return null;
      row.status = status;
      row.completed_at = now;
      row.updated_at = now;
      return get(id);
    },
  };
}

function interruptStore(ctx) {
  const store = ctx?.store;
  return store?.createAgentInterrupt && store?.decideAgentInterrupt && store?.claimAgentInterrupt
    ? store
    : fallbackInterruptStore;
}

async function validateExecutionArgs(ctx, args) {
  const { connection, sql, params = [] } = args ?? {};
  if (!sql || !String(sql).trim()) throw Object.assign(new Error("`sql` is required."), { userFacing: true });

  const c = classify(sql);
  if (c.class === "read")
    throw Object.assign(new Error("db_execute is for writes/DDL — use db_query for read statements."), { userFacing: true });
  if (c.class === "multi")
    throw Object.assign(new Error("db_execute runs ONE statement at a time — remove the extra statement(s)."), { userFacing: true });
  if (c.class === "unknown")
    throw Object.assign(new Error(`could not classify this statement (leading keyword "${c.keyword || "?"}"). Refusing to run it.`), { userFacing: true });

  const conns = await listConnections(ctx.store);
  const meta = conns.find((x) => x.name.toLowerCase() === String(connection || "").toLowerCase());
  if (!meta) {
    throw Object.assign(new Error(`no connection named "${connection}". Available: ${conns.map((x) => x.name).join(", ")}.`), { userFacing: true });
  }
  if (meta.readOnly) {
    const extra = meta.name === BUILTIN_NAME
      ? "The built-in `aperio` connection is always read-only."
      : "Turn off its read-only flag in Settings → Database connections to allow writes.";
    throw Object.assign(new Error(`connection "${meta.name}" is read-only, so it cannot run a ${c.class} statement. ${extra}`), { userFacing: true });
  }

  return {
    connection: meta.name,
    engine: meta.engine,
    sql: c.statements[0],
    params: Array.isArray(params) ? params : [],
    statementClass: c.class,
    keyword: c.keyword,
  };
}

function databaseInterruptService(ctx) {
  return createInterruptService({
    store: interruptStore(ctx),
    revalidate: ({ canonicalArguments }) => validateExecutionArgs(ctx, canonicalArguments),
    executeTool: async (toolName, args) => {
      if (toolName !== "db_execute") throw new Error(`Unsupported database interrupt tool: ${toolName}`);
      const { driver, name, engine } = await getDriver(ctx.store, args.connection);
      try {
        const result = await driver.runWrite(args.sql, args.params);
        return { content: [{ type: "text", text:
          `✅ Executed on ${name} (${engine}). ${JSON.stringify(result)}` }] };
      } finally {
        await driver.close();
      }
    },
  });
}

async function proposeAction(ctx, { summaryLines, label, canonicalArguments }) {
  const token = actionToken();
  await databaseInterruptService(ctx).create({
    id: token,
    sessionId: ctx?.sessionId ?? process.env.APERIO_SESSION_ID ?? DB_INTERRUPT_SESSION_ID,
    runId: ctx?.runId ?? process.env.APERIO_RUN_ID ?? null,
    toolName: "db_execute",
    canonicalArguments,
    allowedDecisions: ["approve", "edit", "reject", "respond"],
    expiresAt: expiresAtFromNow(),
  });
  return {
    content: [{ type: "text", text: [
      "📋 **Pending your confirmation — nothing has been written to the database yet.**",
      "",
      ...summaryLines,
      "",
      `Action: ${label}`,
      `Token: ${token}`,
    ].join("\n") }],
  };
}

async function commitAction(ctx, token) {
  const service = databaseInterruptService(ctx);
  try {
    const row = await service.decide(token, { decision: "approve" });
    if (!row || row.status === "expired") return errText("Confirmation token invalid or expired. Nothing was written.");
    const { result } = await service.claimAndExecute(token);
    return result;
  } catch (err) {
    if (/not found|already been decided|not executable|already claimed|could not be decided/i.test(err.message)) {
      return errText("Confirmation token invalid or expired. Nothing was written.");
    }
    return errText(`Execution failed: ${err.message}`);
  }
}

async function _execute(ctx, args) {
  const token = readToken(args);
  if (token) return commitAction(ctx, token);

  const { connection, params = [] } = args;
  const sql = pickSql(args);
  if (!sql || !String(sql).trim()) return errText("`sql` is required.");

  let canonicalArguments;
  try {
    canonicalArguments = await validateExecutionArgs(ctx, { connection, sql, params });
  } catch (err) {
    return errText(err.message);
  }
  const summaryLines = [
    `**Connection:** ${canonicalArguments.connection} (${canonicalArguments.engine}, writable)`,
    `**Statement type:** ${canonicalArguments.statementClass.toUpperCase()} (${canonicalArguments.keyword})`,
    "",
    "**SQL:**",
    "```sql",
    canonicalArguments.sql,
    "```",
  ];
  if (canonicalArguments.params.length) summaryLines.push(`**Params:** ${JSON.stringify(canonicalArguments.params)}`);

  return proposeAction(ctx, {
    summaryLines,
    label: `Run ${canonicalArguments.statementClass.toUpperCase()} on ${canonicalArguments.connection}`,
    canonicalArguments,
  });
}

export const connectionsHandler = safeHandler("connections", _connections);
export const schemaHandler      = safeHandler("schema", _schema);
export const queryHandler       = safeHandler("query", _query);
export const executeHandler     = safeHandler("execute", _execute);
