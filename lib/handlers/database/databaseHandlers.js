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
async function _query(ctx, { connection, sql, params = [], limit }) {
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

// ─── db_execute (write / DDL, confirm-before-write) ──────────────────────────
const CONFIRM_TTL_MS = 5 * 60 * 1000;
const pendingActions = new Map(); // token → { execute, label, expiresAt }

function pruneActions() {
  const now = Date.now();
  for (const [t, e] of pendingActions) if (now >= e.expiresAt) pendingActions.delete(t);
}
const actionToken = () => "db_" + Math.random().toString(36).slice(2, 8);
const readToken = (args) => args.confirmation_token ?? args.token ?? args.confirmationToken ?? null;

function proposeAction({ summaryLines, label, execute }) {
  const token = actionToken();
  pendingActions.set(token, { execute, label, expiresAt: Date.now() + CONFIRM_TTL_MS });
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

async function commitAction(token) {
  pruneActions();
  const entry = pendingActions.get(token);
  if (!entry || Date.now() >= entry.expiresAt) {
    pendingActions.delete(token);
    return errText("Confirmation token invalid or expired. Nothing was written.");
  }
  pendingActions.delete(token);
  try { return await entry.execute(); }
  catch (err) { return errText(`Execution failed: ${err.message}`); }
}

async function _execute(ctx, args) {
  pruneActions();
  const token = readToken(args);
  if (token) return commitAction(token);

  const { connection, sql, params = [] } = args;
  if (!sql || !String(sql).trim()) return errText("`sql` is required.");

  const c = classify(sql);
  if (c.class === "read")
    return errText("db_execute is for writes/DDL — use db_query for read statements.");
  if (c.class === "multi")
    return errText("db_execute runs ONE statement at a time — remove the extra statement(s).");
  if (c.class === "unknown")
    return errText(`could not classify this statement (leading keyword "${c.keyword || "?"}"). Refusing to run it.`);

  // Verify the connection exists and is writable BEFORE opening it.
  const conns = await listConnections(ctx.store);
  const meta = conns.find((x) => x.name.toLowerCase() === String(connection || "").toLowerCase());
  if (!meta)
    return errText(`no connection named "${connection}". Available: ${conns.map((x) => x.name).join(", ")}.`);
  if (meta.readOnly) {
    const extra = meta.name === BUILTIN_NAME
      ? "The built-in `aperio` connection is always read-only."
      : "Turn off its read-only flag in Settings → Database connections to allow writes.";
    return errText(`connection "${meta.name}" is read-only, so it cannot run a ${c.class} statement. ${extra}`);
  }

  const boundParams = Array.isArray(params) ? params : [];
  const stmt = c.statements[0]; // normalized: comments stripped, no trailing ';'
  const summaryLines = [
    `**Connection:** ${meta.name} (${meta.engine}, writable)`,
    `**Statement type:** ${c.class.toUpperCase()} (${c.keyword})`,
    "",
    "**SQL:**",
    "```sql",
    stmt,
    "```",
  ];
  if (boundParams.length) summaryLines.push(`**Params:** ${JSON.stringify(boundParams)}`);

  return proposeAction({
    summaryLines,
    label: `Run ${c.class.toUpperCase()} on ${meta.name}`,
    execute: async () => {
      const { driver, name, engine } = await getDriver(ctx.store, meta.name);
      try {
        const result = await driver.runWrite(stmt, boundParams);
        return { content: [{ type: "text", text:
          `✅ Executed on ${name} (${engine}). ${JSON.stringify(result)}` }] };
      } finally {
        await driver.close();
      }
    },
  });
}

export const connectionsHandler = safeHandler("connections", _connections);
export const schemaHandler      = safeHandler("schema", _schema);
export const queryHandler       = safeHandler("query", _query);
export const executeHandler     = safeHandler("execute", _execute);
