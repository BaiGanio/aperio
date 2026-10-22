// Phantom-read detection for the T-G2.3 provenance gate.
//
// tech-debt.md ("Document-intelligence harness — grader") named this as a
// deliberately-not-attempted check: a model querying `FROM <table>` it never
// created — gemma-4-12B's side of the family, distinct from the
// fabricated-write-claim case `phantomWriteClaims` already covers.
//
// The evidence here is different from the write case on purpose. A phantom
// WRITE claim is a mismatch between prose ("these are saved") and the INSERTs
// that actually landed. A phantom READ needs no prose at all: `db_query`'s own
// SQL either names a table this run can account for, or it doesn't. A table is
// accounted for when either is true:
//
//   1. This run itself CREATEd it (a confirmed, non-pending `db_execute`
//      whose statement is `CREATE TABLE <name>`), or
//   2. A `db_schema` call against the SAME connection actually named it —
//      legitimate discovery of a table that pre-existed the run.
//
// System/pre-existing connections are excluded outright, never scanned: the
// built-in `aperio` connection (memories, wiki, sessions) always pre-exists
// and was never meant to be "created" by anything the model does — see
// db_connections' own description in mcp/tools/database.js. The check only
// ever applies to connections the model is expected to provision itself
// (typically `extraction`).
//
// Deliberately conservative, same reasoning as write-claims.mjs's own
// constraints: a SQL parse this module cannot resolve confidently (a CTE, a
// derived subquery, a table name it cannot isolate) is skipped rather than
// guessed at. Silence, not a false positive, is the safe failure mode for a
// grader that has already produced four run-invalidating false failures on
// this gate (see tech-debt.md).

const CREATE_TABLE = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?([A-Za-z_]\w*)/i;

// A single, unqualified identifier right after FROM/JOIN — never matches a
// derived subquery (`FROM (SELECT ...)`, starting with `(`) or a bare `FROM`
// with nothing recognizable following it.
const TABLE_REF = /\b(?:FROM|JOIN)\s+["'`\[]?([A-Za-z_]\w*)/gi;

// `WITH cte AS (...)`, `WITH RECURSIVE cte AS (...)`, and comma-separated
// multi-CTE lists. A CTE name is a query-local alias, never a real table, so
// it must never be judged against `CREATE TABLE`/`db_schema` evidence.
const CTE_NAME = /\bWITH\s+(?:RECURSIVE\s+)?["'`\[]?([A-Za-z_]\w*)["'`\]]?\s+AS\s*\(/gi;

function tableNameFromCreate(sql) {
  const m = CREATE_TABLE.exec(String(sql ?? ""));
  return m ? m[1] : null;
}

function cteNamesIn(sql) {
  const names = new Set();
  for (const m of String(sql ?? "").matchAll(CTE_NAME)) names.add(m[1].toLowerCase());
  return names;
}

/** Unqualified table names a `db_query`/`db_execute` SELECT-shaped statement references. */
function queriedTableNames(sql) {
  const text = String(sql ?? "");
  const ctes = cteNamesIn(text);
  const names = [];
  for (const m of text.matchAll(TABLE_REF)) {
    const name = m[1];
    if (ctes.has(name.toLowerCase())) continue; // query-local alias, not a table
    names.push(name);
  }
  return names;
}

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value.toLowerCase());
}

/**
 * Table names a `db_schema` call's own result actually named, for the
 * connection it was called against. Loose substring match rather than a JSON
 * parse — `detail` is capped (see toolActivity.js's DETAIL_CAP) and a table
 * near the cap boundary must still count as discovered; a false positive here
 * would require an unrelated word in the schema dump to coincide with a real
 * table name AND that same name to later appear in an unrelated `db_query`,
 * which is not a realistic collision for the identifiers this corpus uses.
 */
function schemaNamedTable(call, table) {
  const evidence = `${call.summary ?? ""} ${call.detail ?? ""}`;
  if (!evidence.trim()) return false;
  return new RegExp(`\\b${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(evidence);
}

/**
 * Find `db_query` calls that read from a table this run cannot account for.
 *
 * @param {object} args
 * @param {Array}  args.toolCalls        Combined tool calls across the run's turns.
 * @param {string[]} [args.systemConnections] Connection names to exclude outright (default: ["aperio"]).
 * @returns {Array<{connection: string, table: string, sql: string}>}
 */
export function phantomReadClaims({ toolCalls = [], systemConnections = ["aperio"] } = {}) {
  const created = new Map(); // connection -> Set(table, lowercased)
  const schemaCalls = []; // {connection, call}

  for (const call of toolCalls) {
    if (call?.ok !== true) continue;
    const connection = call.arguments?.connection;
    if (typeof connection !== "string" || !connection) continue;

    if (call.name === "db_execute" && call.pending !== true) {
      const table = tableNameFromCreate(call.arguments?.sql);
      if (table) addTo(created, connection, table);
    }

    if (call.name === "db_schema") schemaCalls.push({ connection, call });
  }

  const violations = [];
  for (const call of toolCalls) {
    if (call?.name !== "db_query" || call.ok !== true) continue;
    const connection = call.arguments?.connection;
    if (typeof connection !== "string" || !connection) continue;
    if (systemConnections.includes(connection)) continue;

    for (const table of queriedTableNames(call.arguments?.sql)) {
      if (created.get(connection)?.has(table.toLowerCase())) continue;
      const discovered = schemaCalls.some(
        (s) => s.connection === connection && schemaNamedTable(s.call, table),
      );
      if (discovered) continue;
      violations.push({ connection, table, sql: String(call.arguments?.sql ?? "") });
    }
  }
  return violations;
}
