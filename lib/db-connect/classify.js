// lib/db-connect/classify.js
//
// Pure SQL statement classifier for the database tool (issue #170). No I/O —
// it never touches a database, it only decides what KIND of statement a string
// is so the tool layer can route it: reads run freely via db_query, writes/DDL
// route through the confirm-before-write flow via db_execute.
//
// The classifier is deliberately conservative. It is a routing gate, NOT a
// security boundary — the driver layer still opens read-only connections
// read-only at the connection level (defense in depth). When in doubt it
// returns the MORE restrictive class (e.g. a data-modifying CTE is "write",
// not "read"), so an ambiguous statement can never sneak a mutation through the
// free read path.
//
// Classes:
//   read    SELECT / WITH(no DML) / EXPLAIN(no DML) / PRAGMA / SHOW / DESCRIBE …
//   write   INSERT / UPDATE / DELETE / REPLACE / MERGE / UPSERT …
//   ddl     CREATE / ALTER / DROP / TRUNCATE / RENAME / GRANT / VACUUM …
//   multi   more than one statement in the batch
//   unknown empty, or a leading keyword we don't recognise

// Leading-keyword → class. Anything not listed is "unknown".
const READ_KEYWORDS = new Set([
  "SELECT", "WITH", "EXPLAIN", "PRAGMA", "SHOW", "DESCRIBE", "DESC", "VALUES", "TABLE",
]);
const WRITE_KEYWORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "UPSERT",
]);
const DDL_KEYWORDS = new Set([
  "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "COMMENT",
  "GRANT", "REVOKE", "VACUUM", "ANALYZE", "REINDEX", "ATTACH", "DETACH", "SET",
]);

// Word-boundary DML scan. WITH/EXPLAIN are "read" leading keywords, but Postgres
// allows data-modifying CTEs (`WITH x AS (DELETE …) …`) and `EXPLAIN ANALYZE`
// actually executes the wrapped statement — both would mutate data on the free
// read path. If a read-led statement contains a DML keyword anywhere, escalate
// it to "write" so it requires db_execute + confirmation.
const DML_RE = /\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT)\b/i;

/**
 * Strip comments and split a SQL string into its top-level statements,
 * respecting string/identifier quoting so a ';' or comment marker inside a
 * literal is not treated as a boundary. Returns an array of trimmed,
 * non-empty statement strings (comments removed).
 *
 * Quoting handled: '...' (with '' and backslash escapes — covers MySQL),
 * "..." identifiers, `...` MySQL identifiers. Comments handled: -- to EOL,
 * # to EOL (MySQL), and /* ... *​/ blocks.
 */
export function splitStatements(sql) {
  const statements = [];
  let cur = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // ── Comments ──────────────────────────────────────────────────────────
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      cur += " ";
      continue;
    }
    if (c === "#") {
      while (i < n && sql[i] !== "\n") i++;
      cur += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      cur += " ";
      continue;
    }

    // ── String / identifier literals — copied verbatim, scanned for the
    //    matching close so their contents can't trip comment/';' logic. ─────
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      cur += c;
      i++;
      while (i < n) {
        const ch = sql[i];
        // MySQL backslash escapes (only inside '...'/"..." string literals).
        if (ch === "\\" && quote !== "`") {
          cur += ch + (sql[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (ch === quote) {
          // Doubled quote ('') is an escaped quote, not a close.
          if (sql[i + 1] === quote) {
            cur += ch + ch;
            i += 2;
            continue;
          }
          cur += ch;
          i++;
          break;
        }
        cur += ch;
        i++;
      }
      continue;
    }

    // ── Statement boundary ────────────────────────────────────────────────
    if (c === ";") {
      if (cur.trim()) statements.push(cur.trim());
      cur = "";
      i++;
      continue;
    }

    cur += c;
    i++;
  }

  if (cur.trim()) statements.push(cur.trim());
  return statements;
}

/** Uppercased leading keyword of a single (already comment-stripped) statement. */
function leadingKeyword(stmt) {
  const m = stmt.match(/^[(\s]*([A-Za-z_]+)/);
  return m ? m[1].toUpperCase() : "";
}

/**
 * Classify a SQL string.
 * @param {string} sql
 * @returns {{ class: "read"|"write"|"ddl"|"multi"|"unknown", keyword: string, statements: string[] }}
 */
export function classify(sql) {
  const statements = splitStatements(String(sql ?? ""));

  if (statements.length === 0) return { class: "unknown", keyword: "", statements };
  if (statements.length > 1)   return { class: "multi", keyword: "", statements };

  const stmt = statements[0];
  const keyword = leadingKeyword(stmt);

  if (READ_KEYWORDS.has(keyword)) {
    // Escalate data-modifying CTEs / EXPLAIN-of-DML to "write" (see DML_RE).
    if ((keyword === "WITH" || keyword === "EXPLAIN") && DML_RE.test(stmt)) {
      return { class: "write", keyword, statements };
    }
    return { class: "read", keyword, statements };
  }
  if (WRITE_KEYWORDS.has(keyword)) return { class: "write", keyword, statements };
  if (DDL_KEYWORDS.has(keyword))   return { class: "ddl", keyword, statements };

  return { class: "unknown", keyword, statements };
}

/** db_query gate: only single read statements are allowed. */
export function isAllowedForQuery(sql) {
  return classify(sql).class === "read";
}

/** db_execute gate: single write or DDL statements; rejects read/multi/unknown. */
export function isAllowedForExecute(sql) {
  const c = classify(sql).class;
  return c === "write" || c === "ddl";
}
