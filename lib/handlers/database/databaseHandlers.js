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
import { countPlaceholders, describeSqlitePlaceholders } from "../../db-connect/placeholders.js";
import {
  listConnections, getDriver, BUILTIN_NAME,
} from "../../db-connect/registry.js";
import { EXTRACTION_CONNECTION, extractionDbPath, provisionExtractionConnection, isManagedExtractionFile } from "../../db-connect/extraction.js";
import { createInterruptService } from "../../security/interruptService.js";
import { normalizeAmount } from "./amounts.js";

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

// Restricted to genuine records (`{}` / `Object.create(null)`), not every
// non-array object — better-sqlite3 accepts Buffer/Uint8Array as ordinary
// scalar BLOB bind values (confirmed live) alongside a real named-parameter
// object in the same call: `stmt.run({name: "x"}, Buffer.from(data))` for
// `VALUES (:name, ?)`. The looser `typeof === "object"` check classified
// that Buffer as a SECOND named-parameter object, so a genuinely valid
// mixed named+BLOB write hit `objectEntries.length !== 1` below and was
// rejected before ever being proposed (P2 review finding).
const isPlainObject = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function mismatchError(expected, actual) {
  return Object.assign(new Error(
    `this statement expects ${expected} bound parameter${expected === 1 ? "" : "s"} but ` +
    `${actual} ${actual === 1 ? "was" : "were"} provided in \`params\`. ` +
    "Count the placeholders in the SQL and match `params` to them exactly."
  ), { userFacing: true });
}

// Validates `params` against what the statement's placeholders actually
// need to bind successfully — not just a raw count, since SQLite's named
// parameters bind from a single object argument rather than one array slot
// per name (see describeSqlitePlaceholders for the empirically-verified
// better-sqlite3 rules this mirrors).
function validateBoundParams(engine, sql, normalizedParams) {
  if (engine !== "sqlite") {
    const expected = countPlaceholders(sql, engine);
    // mssql's driver binds the whole `params` array positionally regardless
    // of how many @pN the SQL text references, so extra/unused entries are
    // harmless there — only a shortfall is a real mismatch.
    const mismatch = engine === "mssql" ? normalizedParams.length < expected : normalizedParams.length !== expected;
    if (mismatch) throw mismatchError(expected, normalizedParams.length);
    return;
  }

  const desc = describeSqlitePlaceholders(sql);
  if (desc.outOfRangeNumber !== null) {
    // Both ends of SQLite's range produce the same prepare-time failure
    // ("variable number must be between ?1 and ?32766"), so `?0` gets the
    // same rejection as `?32767` — only the wording differs.
    const bound = desc.outOfRangeNumber < 1 ? "below SQLite's minimum" : "above SQLite's maximum";
    throw Object.assign(new Error(
      `this statement uses \`?${desc.outOfRangeNumber}\`, which is ${bound} bound-parameter ` +
      "number (numbering runs ?1 to ?32766) — SQLite would refuse to prepare this statement. Use " +
      "anonymous `?` or a named placeholder (`:name`) instead."
    ), { userFacing: true });
  }
  if (desc.named.size === 0) {
    if (normalizedParams.length !== desc.anonymous) throw mismatchError(desc.anonymous, normalizedParams.length);
    return;
  }

  // Named (:name/@name/$name) and numbered (?N) placeholders share one
  // binding mechanism in better-sqlite3 — both need a key in a single
  // object argument, keyed by the identifier or digit string respectively.
  const names = [...desc.named];
  const objectEntries = normalizedParams.filter(isPlainObject);
  if (objectEntries.length !== 1) {
    const example = JSON.stringify(Object.fromEntries(names.map((n) => [n, "value"])));
    throw Object.assign(new Error(
      `this statement uses named/numbered placeholder(s) (${names.join(", ")}) — pass exactly one ` +
      `object in \`params\` whose keys are those names, e.g. params: [${example}].`
    ), { userFacing: true });
  }
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so a statement
  // naming a placeholder that collides with an inherited Object.prototype
  // member (:toString, :constructor, :__proto__, :hasOwnProperty, …) would
  // read as "present" even in an empty {} — confirmed live that better-
  // sqlite3 still throws `Missing named parameter "toString"` in that exact
  // case, since it only binds the object's own supplied properties. Passing
  // validation here on an inherited-only match would recreate the very
  // confirm-time failure this check exists to prevent before proposing.
  const missing = names.filter((n) => !Object.hasOwn(objectEntries[0], n));
  if (missing.length) {
    throw Object.assign(new Error(
      `the named-parameter object in \`params\` is missing key${missing.length === 1 ? "" : "s"} ` +
      `${missing.join(", ")} required by this statement's placeholders.`
    ), { userFacing: true });
  }
  const scalarCount = normalizedParams.length - objectEntries.length;
  if (scalarCount !== desc.anonymous) {
    throw Object.assign(new Error(
      `this statement also has ${desc.anonymous} anonymous \`?\` placeholder(s) but ${scalarCount} ` +
      `non-object value${scalarCount === 1 ? " was" : "s were"} provided alongside the named-parameter object.`
    ), { userFacing: true });
  }
}

async function validateExecutionArgs(ctx, args) {
  const { connection, sql, params = [] } = args ?? {};
  if (!sql || !String(sql).trim()) throw Object.assign(new Error("`sql` is required."), { userFacing: true });
  // `connection` and `sql` are both .optional() in the tool schema on purpose —
  // the confirm step re-invokes db_execute with only `confirmation_token`, so
  // neither can be schema-required there. checkArgs() now covers the propose
  // path via a CONDITIONAL_REQUIRED overlay keyed on the same "no
  // confirmation_token yet" signal (lib/tools/schemaCheck.js), so this message
  // and the schema-check hint agree. This message is still what a human sees.
  // Without it a missing `connection` fell through to the lookup below and came
  // back as `no connection named "undefined"`, which asserts the model named a
  // connection "undefined" when it named none; two local models (gemma-4-12B,
  // gemma4-E4B) each burned a turn retrying the identical malformed call.
  if (!connection || !String(connection).trim()) {
    throw Object.assign(new Error(
      "`connection` is required — name the connection to write to. For data extracted from documents " +
      `use \`${EXTRACTION_CONNECTION}\`; it does not need to exist yet and is created automatically on the ` +
      "first confirmed write. Call db_connections to list the connections that already exist."
    ), { userFacing: true });
  }

  const c = classify(sql);
  if (c.class === "read")
    throw Object.assign(new Error("db_execute is for writes/DDL — use db_query for read statements."), { userFacing: true });
  if (c.class === "multi")
    throw Object.assign(new Error("db_execute runs ONE statement at a time — remove the extra statement(s)."), { userFacing: true });
  if (c.class === "unknown")
    throw Object.assign(new Error(`could not classify this statement (leading keyword "${c.keyword || "?"}"). Refusing to run it.`), { userFacing: true });

  const wanted = String(connection || "").trim();
  const conns = await listConnections(ctx.store);
  const meta = conns.find((x) => x.name.toLowerCase() === wanted.toLowerCase());

  // "extraction" is a reserved, self-provisioning connection name (#250 WS1):
  // a clean profile has no writable connection configured yet, and the model
  // must be able to get one without the user hand-editing Settings. It does
  // not exist as a `meta` row until the write is actually confirmed — see
  // provisionExtractionConnection() in executeTool below — so an unresolved
  // reserved name is not the same failure as an unknown one.
  //
  // A `meta` row that DOES already carry this name but isn't the row this
  // module provisioned is a genuine collision, not a match: reusing it would
  // redirect document writes into an unrelated (possibly attacker-specified,
  // e.g. a different engine/host entirely) database, and if it happens to be
  // read-only it would otherwise fall through to the generic read-only error
  // below, which misleadingly implies toggling that flag would enable
  // self-provisioning. The `provisioned` marker alone is stored, user-
  // reachable data (a raw `PUT /api/settings/db.connections` or a headless
  // `DB_CONNECTIONS` seed can both set it on an arbitrary row), so it is
  // never trusted alone here either — the row must also have the exact
  // shape (sqlite engine, this profile's real managed file path) the
  // self-provisioned connection would actually have.
  const isReservedExtractionName = wanted.toLowerCase() === EXTRACTION_CONNECTION;
  if (isReservedExtractionName && meta && !(meta.provisioned && isManagedExtractionFile(meta, ctx.store))) {
    throw Object.assign(new Error(
      `"${EXTRACTION_CONNECTION}" is reserved for Aperio's self-provisioned document-extraction database, ` +
      `but an existing connection named "${meta.name}" already uses it and is not the managed one. Rename that ` +
      `connection in Settings → Database connections to free the reserved name.`
    ), { userFacing: true });
  }
  const provisioning = isReservedExtractionName && !meta;
  if (!meta && !provisioning) {
    // `wanted`, not the raw arg: the raw value is what the model literally sent
    // (including surrounding whitespace), while `wanted` is the name actually
    // looked up. Reporting the raw one made a whitespace-only or absent value
    // read as a real connection name.
    throw Object.assign(new Error(`no connection named "${wanted}". Available: ${conns.map((x) => x.name).join(", ")}.`), { userFacing: true });
  }
  if (meta?.readOnly) {
    const extra = meta.name === BUILTIN_NAME
      ? "The built-in `aperio` connection is always read-only."
      : "Turn off its read-only flag in Settings → Database connections to allow writes.";
    throw Object.assign(new Error(`connection "${meta.name}" is read-only, so it cannot run a ${c.class} statement. ${extra}`), { userFacing: true });
  }

  const engine = provisioning ? "sqlite" : meta.engine;
  const normalizedParams = Array.isArray(params) ? params : [];
  validateBoundParams(engine, c.statements[0], normalizedParams);

  return {
    connection: provisioning ? EXTRACTION_CONNECTION : meta.name,
    engine,
    sql: c.statements[0],
    params: normalizedParams,
    statementClass: c.class,
    keyword: c.keyword,
    provision: provisioning,
  };
}

export function databaseInterruptService(ctx) {
  return createInterruptService({
    store: interruptStore(ctx),
    revalidate: ({ canonicalArguments }) => validateExecutionArgs(ctx, canonicalArguments),
    executeTool: async (toolName, args) => {
      if (toolName !== "db_execute") throw new Error(`Unsupported database interrupt tool: ${toolName}`);
      // Provisioning happens only here, at the moment the user's confirmation
      // actually executes — never at propose time, so a declined or expired
      // token creates nothing. Idempotent: a second confirmed write against
      // "extraction" reuses the same file and connection row.
      if (args.provision) await provisionExtractionConnection(ctx.store);
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

export async function decideDatabaseInterrupt(ctx, token, decisionInput = {}) {
  const service = databaseInterruptService(ctx);
  const decision = decisionInput.decision;
  if (decision === "approve" || decision === "edit") {
    const row = await service.decide(token, {
      decision,
      editedArguments: decisionInput.editedArguments,
    });
    if (!row || row.status === "expired") return { row, result: errText("Confirmation token invalid or expired. Nothing was written.") };
    const executed = await service.claimAndExecute(token);
    return { row: executed.interrupt, result: executed.result };
  }
  const row = await service.decide(token, {
    decision,
    response: decisionInput.response,
  });
  return { row, result: null };
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
    canonicalArguments.provision
      ? `**Connection:** ${canonicalArguments.connection} (sqlite, writable) — new, will be created now at ${extractionDbPath(ctx.store)} as your personal document-extraction database.`
      : `**Connection:** ${canonicalArguments.connection} (${canonicalArguments.engine}, writable)`,
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
export { normalizeAmount };
