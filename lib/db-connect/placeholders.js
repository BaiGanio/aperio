// lib/db-connect/placeholders.js
//
// Dialect-aware bind-parameter analysis for the database tool (issue #170).
// Split out of classify.js (A2D 2026-08-04): the statement classifier decides
// READ/WRITE/DDL routing, this module decides how many bind parameters a
// statement needs and what their names are, so db_execute can validate
// `params` before ever touching a driver.

// MySQL's `--` line-comment rule: the two dashes must be followed by a
// whitespace/control character or end-of-input. Mirrors the exact test in
// sql-escaper's `skipSqlContext` (`Number.isNaN(after) || after <=
// charCode.space`), which is what decides whether the formatter skips the
// rest of the line when consuming `params`.
function opensMysqlLineComment(sql, dashIndex) {
  const after = sql.charCodeAt(dashIndex + 2);
  return Number.isNaN(after) || after <= 32;
}

/**
 * Same quoting/comment rules as splitStatements(), but literal and comment
 * spans are collapsed to a single space rather than kept verbatim, so a
 * placeholder-shaped token inside a string ('?', '$1', ':name', …) can never
 * be counted as a real bind parameter. Also masks dialect-specific forms
 * splitStatements doesn't need to know about but placeholder counting does,
 * each gated to the dialect that actually has the construct:
 *   - `#` is NEVER masked as a comment here, even for MySQL, despite MySQL
 *     itself treating `# ...` as a line comment — because the placeholder
 *     COUNT this function feeds must match what actually consumes `params`
 *     at execution time, and that's mysql2's bundled `sql-escaper` formatter
 *     (`this.pool.query(sql, params)` in lib/db-connect/drivers/mysql.js — a
 *     client-side text substitution, not a server-side prepared statement),
 *     which scans for bare `?` with NO knowledge of `#` comments at all
 *     (confirmed live: `mysql2.format('… a=1 # comment ?\n WHERE id=?', [5])`
 *     consumes the FIRST `5` inside the "comment", leaving the real `id=?`
 *     unfilled in the emitted SQL). Masking `#` here would make this
 *     function under-count relative to what the formatter actually consumes,
 *     which is worse than not masking it: a statement with a real `?`
 *     hiding after a `#` would pass validation with too few `params`, then
 *     either misbind (as above) or leave a literal `?` in the executed SQL.
 *     Postgres uses `#` for jsonb operators (`#-`, `#>`, `#>>`) regardless,
 *     so a real placeholder after it (`data #- $1`) must count there too.
 *   - Comment spans are dialect-gated too: MySQL's `--` needs a following
 *     whitespace to open a comment and its `/*!`/`/*+` forms are not
 *     comments at all, while Postgres and SQL Server NEST `/* … *​/`. See
 *     the comment on the two comment branches in the loop below.
 *   - Postgres dollar-quoted strings (`$$literal $1$$` / `$tag$…$tag$`) —
 *     Postgres only. SQLite's own named-parameter grammar allows `$` inside
 *     the name itself (`$value$` is ONE parameter named "value$", verified
 *     against better-sqlite3 — see describeSqlitePlaceholders), which this
 *     scanner would otherwise misread as an (unterminated, since no real
 *     closing `$value$` exists elsewhere) dollar-quote open, masking the
 *     rest of the statement. Only recognized when NOT preceded by an
 *     identifier character: Postgres identifiers may contain `$` (just not
 *     as the first character), so in `foo$tag$bar` the `$tag$` is the
 *     middle of the single identifier `foo$tag$bar`, not a quote opener —
 *     Postgres's own lexer never revisits that `$` separately because the
 *     identifier token already consumed it via maximal munch. Without this
 *     boundary check that `$tag$` reads as an unterminated dollar-quote and
 *     masks everything after it, including a real `$1` later in the
 *     statement (confirmed: `countPlaceholders('SELECT foo$tag$bar, $1
 *     FROM t', 'postgres')` returned 0 before this check).
 *   - `[...]` bracket-quoted identifiers — sqlite/mssql only. Postgres uses
 *     `[...]` for array literals/subscripts, where a placeholder inside
 *     genuinely is one, e.g. `ARRAY[$1,$2]`, so it must NOT be masked there.
 *   - Postgres `E'...'`/`e'...'` extended string literals DO interpret
 *     backslash escapes (always, regardless of `standard_conforming_strings`)
 *     — detected here as a standalone `E`/`e` token immediately before the
 *     opening quote (not part of a longer identifier).
 *   - `"..."` double-quoted spans are NOT masked for MySQL, even though
 *     `"..."` is a valid MySQL string literal there (same reasoning as `#`
 *     above): the bundled `sql-escaper` formatter's placeholder scanner only
 *     recognizes `'`, `` ` ``, `--`, and `/* *​/` as context-opening — `"`
 *     isn't in its trigger table at all — so a `?` inside a MySQL
 *     double-quoted string is NOT skipped by the formatter and DOES consume
 *     a real slot from `params` (confirmed live: `mysql2.format('… a="?"
 *     WHERE id=?', ['x', 5])` binds `'x'` into the quoted `"?"` and `5` into
 *     the real `id=?` — two slots consumed, not one). Masking it here would
 *     under-count against that real consumption the same way masking `#`
 *     would. Every other dialect still masks `"..."` normally (Postgres/
 *     mssql identifier quoting, SQLite string-or-identifier).
 *
 * Everywhere else, backslash is only a string escape for `engine ===
 * "mysql"` (its default `sql_mode`, absent `NO_BACKSLASH_ESCAPES`). Standard
 * SQL — SQLite always, and Postgres by default (`standard_conforming_strings
 * = on`) outside an E-string — gives backslash no special meaning inside a
 * '...' string: `'\'` is the one-character string `\`, and the following `'`
 * closes it. Treating backslash as an escape there swallows the real
 * closing quote and masks everything after it, including any real
 * placeholder later in the statement.
 *
 * KNOWN LIMITATION: this is a per-ENGINE default, not a per-CONNECTION
 * setting — a connection actually running MySQL's `NO_BACKSLASH_ESCAPES` or
 * Postgres's legacy `standard_conforming_strings = off` sees the opposite
 * real behavior, which this function has no way to detect without a live
 * round-trip query per connection. See `id/reference/tech-debt.md` (Db-
 * connect — placeholder validation) for why that isn't done here.
 */
function maskLiteralsAndComments(sql, engine) {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // `--` needs no explicit separator: it always runs to end-of-line (or
    // end-of-input), and the trailing '\n' itself is left in place and
    // copied through by the loop's default branch below, already acting as
    // whitespace. A `/* ... */` block comment has no such guaranteed
    // boundary — it can sit directly between two tokens on the same line
    // (`??/* alias */??`) — so masking it to nothing, as an earlier version
    // of this function did, merges the placeholder run on either side into
    // one longer run and changes mysql's run-length-based count (P2 review
    // finding: `UPDATE ??/* alias */?? SET value = ?` masked to `UPDATE
    // ???? SET value = ?` — a run of 4 counts as zero placeholders per the
    // mysql branch below instead of the two real `??` identifier slots,
    // rejecting a valid 3-param call before ever proposing it). A single
    // space keeps the two runs separate, matching this function's own
    // "collapsed to a single space" contract (see the docstring above).
    //
    // MySQL is the exception on BOTH comment forms, for the same reason `#`
    // and `"..."` are left unmasked above: the count must match what
    // mysql2's bundled `sql-escaper` formatter actually consumes.
    //   - `--` opens a comment there only when followed by whitespace or
    //     end-of-input (`skipSqlContext`: `Number.isNaN(after) || after <=
    //     charCode.space`), matching MySQL's own grammar. Confirmed live:
    //     `format('UPDATE t SET a=?--x + ? WHERE id=?', [1,2,3])` fills all
    //     THREE `?` — masking `--x + ?` as a comment here would under-count.
    //   - `/*! … */` (version-gated executable comment) and `/*+ … */`
    //     (optimizer hint) are explicitly NOT skipped by that formatter
    //     (`markerChar === exclamation || plus → return -1`), and MySQL
    //     itself executes their contents, so a `?` inside them is a real
    //     slot. Confirmed live: `format('SELECT /*! ? */ , ?', [1,2])` →
    //     `SELECT /*! 1 */ , 2`.
    if (c === "-" && next === "-" && (engine !== "mysql" || opensMysqlLineComment(sql, i))) {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      if (engine === "mysql" && (sql[i + 2] === "!" || sql[i + 2] === "+")) {
        out += c;
        i++;
        continue;
      }
      // Postgres and SQL Server nest block comments (`/* outer /* inner */
      // still comment */`); MySQL and SQLite stop at the first `*/`. Closing
      // a nesting dialect's comment early exposes the tail of the comment
      // text to placeholder matching — e.g. `UPDATE t SET a=$1 /* x /* y */
      // $99 */ WHERE id=$2` counted 99 params instead of 2, rejecting a
      // valid write (P2 review finding).
      const nests = engine === "postgres" || engine === "mssql";
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; continue; }
        if (nests && sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; continue; }
        i++;
      }
      out += " ";
      continue;
    }
    if (c === "'" || c === "`" || (c === '"' && engine !== "mysql")) {
      const quote = c;
      const isPostgresEString = engine === "postgres" && quote === "'" &&
        (sql[i - 1] === "E" || sql[i - 1] === "e") &&
        (i - 2 < 0 || !/[A-Za-z0-9_]/.test(sql[i - 2]));
      const backslashEscapes = engine === "mysql" || isPostgresEString;
      i++;
      while (i < n) {
        const ch = sql[i];
        if (backslashEscapes && ch === "\\" && quote !== "`") { i += 2; continue; }
        if (ch === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (c === "$" && engine === "postgres" && !precededByIdentifierChar(sql, i)) {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const delim = tagMatch[0];
        const closeIdx = sql.indexOf(delim, i + delim.length);
        i = closeIdx === -1 ? n : closeIdx + delim.length;
        out += " ";
        continue;
      }
    }
    if (c === "[" && (engine === "sqlite" || engine === "mssql")) {
      // T-SQL escapes a literal ']' inside a bracket-quoted identifier by
      // doubling it (`[foo]]bar]` names the column `foo]bar`) — a bare
      // indexOf(']') stops at the FIRST half of that escape and exposes the
      // rest of the identifier (e.g. a trailing `@p0`) to placeholder
      // matching. Walk past doubled `]]` the same way the quote loop above
      // walks past doubled `''`/`""`, so only an unescaped `]` terminates.
      i++;
      while (i < n) {
        if (sql[i] === "]") {
          if (sql[i + 1] === "]") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

// Both Postgres and SQL Server allow '$'/'@' respectively as an ordinary,
// non-leading identifier character (Postgres: "subsequent characters can be
// letters, digits, underscores, or dollar signs"; SQL Server regular
// identifiers: "subsequent characters can be letters, decimal digits, @, $,
// or #"). So `foo$1` (Postgres) or `foo@p0` (SQL Server) can each be ONE
// unquoted column name, not an identifier followed by a real placeholder —
// only treat the sigil as a placeholder start when NOT immediately preceded
// by another identifier character.
//
// "Letters" here isn't ASCII-only in ANY of the three dialects this check
// gates: Postgres identifiers explicitly allow "letters with diacritical
// marks and non-Latin letters"; SQL Server identifiers allow "Unicode
// Standard 3.2" letters; and SQLite's own unquoted-identifier rule (used by
// describeSqlitePlaceholders' `$` boundary check, which shares this same
// regex) accepts any byte >= 0x80 with no category check at all — confirmed
// live that SQLite accepts an unquoted column named `é$bar` as ONE
// identifier, no placeholder. The U+0080-U+FFFF range below covers every
// dialect's real behavior closely enough without a full per-dialect
// Unicode-category table, and — tested as a single preceding code UNIT, not
// a full code point — still correctly flags a preceding low/high surrogate
// half of an astral character as "identifier-like" (surrogates are
// U+D800-U+DFFF, itself inside this range), so it degrades safely even for
// 4-byte UTF-8 names.
const IDENT_CONTINUATION_RE = /[A-Za-z0-9_$\u0080-\uFFFF]/;
// SQL Server's own continuation rule additionally allows '@' and '#' (its
// docs: "subsequent characters can be letters, decimal digits, @, $, or #")
// — but neither belongs in the SHARED regex above: '@' is one of SQLite's
// own unconditional placeholder sigils (never a legal identifier character
// there — see describeSqlitePlaceholders), and Postgres has no unquoted use
// for either character at all, so widening the shared class would make
// THOSE dialects wrongly skip a real `$N` placeholder that happens to follow
// a stray '@'/'#' in the SQL text (an under-count, the same failure class
// this whole boundary check exists to prevent). Confirmed live that a
// column named `foo@@p0` or `foo#@p0` is one valid mssql identifier — the
// mssql-only `@pN` check below must widen its OWN boundary test to match.
const MSSQL_IDENT_CONTINUATION_RE = /[A-Za-z0-9_$@#\u0080-\uFFFF]/;
function precededByIdentifierChar(text, matchIndex, re = IDENT_CONTINUATION_RE) {
  return matchIndex > 0 && re.test(text[matchIndex - 1]);
}

/**
 * Count the bind parameters mysql/postgres/mssql's positional placeholder
 * syntax requires. `params` sent to db_execute is always a flat positional
 * array (see mcp/tools/database.js):
 *   - mysql:    each `?` counts as one slot, EXCEPT mysql2's `??` identifier
 *               placeholder (escapes a table/column name via `escapeId`
 *               instead of a value), which also consumes exactly one slot,
 *               not two — confirmed against the `sql-escaper` formatter
 *               mysql2 uses internally. A run of 3+ consecutive `?` isn't a
 *               placeholder at all in that formatter and consumes none.
 *   - postgres: the highest `$N` referenced is the slot count (a repeated
 *               `$1` still needs only one array entry). A `$N` immediately
 *               preceded by an identifier character (`foo$1`) is part of
 *               that identifier, not a placeholder.
 *   - mssql:    the highest `@pN` referenced + 1 (bindInputs binds the whole
 *               array positionally as @p0, @p1, … regardless of how many the
 *               SQL text actually references). Same identifier-boundary
 *               exclusion as Postgres applies to `@pN`.
 * SQLite has its own, richer binding rules — see describeSqlitePlaceholders.
 */
export function countPlaceholders(sql, engine) {
  const masked = maskLiteralsAndComments(String(sql ?? ""), engine);

  if (engine === "postgres") {
    let max = 0;
    for (const m of masked.matchAll(/\$(\d+)/g)) {
      if (precededByIdentifierChar(masked, m.index)) continue;
      max = Math.max(max, Number(m[1]));
    }
    return max;
  }
  if (engine === "mssql") {
    let max = -1;
    for (const m of masked.matchAll(/@p(\d+)/gi)) {
      if (precededByIdentifierChar(masked, m.index, MSSQL_IDENT_CONTINUATION_RE)) continue;
      max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  // mysql: walk runs of consecutive '?' — a run of 1 or 2 is one slot
  // (anonymous value, or '??' identifier), a run of 3+ is not a placeholder.
  let count = 0;
  let j = 0;
  while (j < masked.length) {
    if (masked[j] !== "?") { j++; continue; }
    let runEnd = j;
    while (runEnd < masked.length && masked[runEnd] === "?") runEnd++;
    if (runEnd - j <= 2) count++;
    j = runEnd;
  }
  return count;
}

// SQLite's compiled-in default for SQLITE_LIMIT_VARIABLE_NUMBER — confirmed
// against the bundled better-sqlite3: ?32766 prepares, ?32767 throws
// "variable number must be between ?1 and ?32766". A number above this can
// never be valid, so it's rejected outright rather than fed into the
// high-water-mark math below (see the P1 note on that math for why: an
// absurdly large N, e.g. ?1000000000, must never reach it in the first
// place, not merely be computed from cheaply).
const SQLITE_MAX_VARIABLE_NUMBER = 32766;
// The same error names a LOWER bound, and `?0` hits it: confirmed live that
// `db.prepare('SELECT ?0')` throws the identical "variable number must be
// between ?1 and ?32766". Zero must therefore be rejected on the same path
// as an over-large number — left to fall through, it claims index 0 without
// ever advancing `nVar`, so `gaps = nVar - claimed.size` goes NEGATIVE and
// the caller reports an impossible "-1 anonymous placeholders" shape error
// instead of the real invalid-number one (P2 review finding).
const SQLITE_MIN_VARIABLE_NUMBER = 1;

/**
 * Describe a SQLite statement's placeholders precisely enough to validate
 * better-sqlite3's actual binding rules — verified directly against its
 * native binder (src/util/binder.cpp + src/objects/statement.cpp) and
 * SQLite's own parameter-numbering algorithm (sqlite3ExprAssignVarNumber),
 * not assumed from grammar docs:
 *   - anonymous `?` — always gets the NEXT sequential index (a running
 *     high-water mark, "nVar" below), one positional array slot each.
 *   - `?N` (numbered) and `:name` / `@name` / `$name` (named) are the SAME
 *     binding mechanism in better-sqlite3: `sqlite3_bind_parameter_name`
 *     returns a name for BOTH — "N" (the digit string, sigil-less) for
 *     `?N`, or the identifier after the sigil for the other three — and
 *     both are populated from a single plain-object argument anywhere in
 *     the params array. A name repeated in the SQL still needs only one
 *     key in that object. SQLite's name grammar allows a leading OR
 *     trailing digit/`$` (`:1`, `$2`, and even `$value$` as one parameter
 *     named "value$"), so the character class below isn't letter/
 *     underscore-first, and includes `$` as an ordinary name character.
 *   - `?N` also moves the high-water mark straight to N if N is bigger
 *     than anything seen so far (`if (x > nVar) nVar = x`, mirroring
 *     SQLite's own C code) — but does NOT consume the indices it jumps
 *     over. A statement using only `?2` therefore still has TWO slots:
 *     the named one at index 2, and a nameless "gap" at index 1 that
 *     nothing in the SQL text ever references, yet still needs an extra
 *     anonymous value at runtime to satisfy `sqlite3_bind_parameter_count`
 *     — confirmed live: `params: [{"2": 5}]` alone throws "Too few
 *     parameter values were provided"; `params: [5, {"2": 5}]` (padding
 *     the gap with a throwaway value) is what actually executes. Every
 *     such gap is counted into `anonymous` alongside true bare `?`s, since
 *     both are filled the same way (the next unclaimed positional value).
 *     Gap count is `nVar - claimed.size` — a closed-form subtraction, NOT
 *     a loop over 1..nVar — so an out-of-range `?N` can never make this
 *     function iterate proportionally to N (see SQLITE_MAX_VARIABLE_NUMBER
 *     above for why out-of-range values are rejected before they'd matter).
 *   - `$` is also a valid, non-leading, UNQUOTED SQLite identifier
 *     character (`CREATE TABLE t (foo$bar INT)` is one real column, not
 *     "foo" followed by a `$bar` placeholder — confirmed live). So a `$`
 *     immediately preceded by an identifier character never starts a named
 *     placeholder — only `:` and `@` are unconditional sigils in SQLite
 *     (neither is ever a legal unquoted-identifier character there).
 *   - An explicit `?N` whose index was already claimed by an EARLIER
 *     placeholder (named or numbered) is an alias of that same slot, not a
 *     second binding — confirmed live: `VALUES (:x, ?1)` runs with only
 *     `{x: value}`, no `"1"` key required. Order matters: `nVar` is a
 *     running counter assigned in parse order, so `?1` BEFORE `:x` instead
 *     claims index 1 for itself first, pushing `:x` to index 2 — now two
 *     independent keys (`"1"` and `x`) are required. `claimed.has(num)` is
 *     what detects the alias case below.
 *   - SQLite's name grammar has no ASCII restriction: any byte >= 0x80 is a
 *     valid identifier/name character (`sqlite3IsIdChar`, byte-level, no
 *     Unicode category check) — so `:é`, `$é`, `@é` are each ONE named
 *     placeholder, confirmed live against `{"é": value}`. The capture
 *     group's character class below includes `\u{80}-\u{10FFFF}` (with the
 *     `u` flag, so astral code points stay single matches) to mirror that.
 *   - `:x`, `@x`, and `$x` are THREE distinct binder slots in SQLite despite
 *     sharing the bare name "x" — confirmed live: `UPDATE t SET a=:x, b=@x,
 *     c=$x, d=?4 WHERE …` needs a fourth key `"4"` (the 4th distinct slot,
 *     since `?4` can't alias any of the first three), while `UPDATE t SET
 *     a=:x, b=@x, c=?2 …` runs on `{x: value}` alone (here `?2` DOES alias
 *     `@x`'s slot). So slot assignment (`nVar`/`claimed`, via `tokenClaimed`
 *     below) must key on sigil+name, while the returned `named` set — which
 *     says which object KEYS the caller must supply — dedups on the bare
 *     name only, since one key fills every sigil that spells it.
 */
export function describeSqlitePlaceholders(sql) {
  const masked = maskLiteralsAndComments(String(sql ?? ""), "sqlite");
  const named = new Set();
  const claimed = new Set();
  const tokenClaimed = new Set();
  // Indices claimed by a bare `?` that have NOT since been aliased by a
  // later `?N` — see the conversion branch below for why this needs its own
  // set rather than just checking `claimed`.
  const anonymousClaimed = new Set();
  let bareAnonymous = 0;
  let nVar = 0;
  let outOfRangeNumber = null;

  for (const m of masked.matchAll(/\?(\d+)|(\?)|([:@$])([A-Za-z0-9_$\u{80}-\u{10FFFF}]+)/gu)) {
    if (m[1] !== undefined) {
      const num = Number(m[1]);
      if (num < SQLITE_MIN_VARIABLE_NUMBER || num > SQLITE_MAX_VARIABLE_NUMBER) {
        if (outOfRangeNumber === null) outOfRangeNumber = num;
        continue;
      }
      // An explicit ?N that names an index an earlier named/numbered
      // placeholder already claimed is an ALIAS of that same binding, not a
      // new one — SQLite assigns indices in parse order via one running
      // counter shared by both mechanisms, so a repeat reference never
      // needs its own key (verified live: `VALUES (:x, ?1)` runs with only
      // `{x: value}` — see the P2 note this fixes in tech-debt history).
      //
      // But when the EARLIER claim was a bare anonymous `?` rather than a
      // named one, aliasing it with `?N` retroactively turns that slot into
      // a named binding — better-sqlite3 requires the digit-string key for
      // it, not a positional array value, confirmed live: `VALUES (?, ?1)`
      // rejects `params: [v]` ("Too many parameter values were provided")
      // but runs on `params: [{"1": v}]`. `VALUES (?, ?, ?1, ?2)` needs
      // `{"1": v1, "2": v2}` alone — zero positional args — because BOTH
      // bare slots get converted. Without this, the earlier alias-and-skip
      // above silently kept counting the slot as anonymous, so a caller
      // that followed this function's own advice (a plain positional array)
      // reproduced the exact confirm-time "Too many parameter values were
      // provided" failure this whole validator exists to catch before
      // proposing (P2 review finding).
      if (claimed.has(num)) {
        if (anonymousClaimed.has(num)) {
          anonymousClaimed.delete(num);
          bareAnonymous -= 1;
          named.add(m[1]);
        }
        continue;
      }
      if (num > nVar) nVar = num;
      named.add(m[1]);
      claimed.add(num);
    } else if (m[2] !== undefined) {
      nVar += 1;
      bareAnonymous += 1;
      claimed.add(nVar);
      anonymousClaimed.add(nVar);
    } else {
      if (m[3] === "$" && precededByIdentifierChar(masked, m.index)) continue;
      const sigil = m[3];
      const name = m[4];
      // A slot is keyed by SIGIL+name, not bare name: `:x` and `@x` are two
      // distinct binder slots (each needs its own index claimed below) even
      // though better-sqlite3 fills both from the SAME object key "x" — so
      // slot assignment must dedup on `tokenClaimed` (sigil+name) while the
      // returned `named` set (what the caller must supply keys for) dedups
      // on the bare name alone, independent of how many sigils used it.
      if (!tokenClaimed.has(sigil + name)) {
        nVar += 1;
        tokenClaimed.add(sigil + name);
        claimed.add(nVar);
      }
      named.add(name);
    }
  }

  const gaps = nVar - claimed.size;
  return { anonymous: bareAnonymous + gaps, named, outOfRangeNumber };
}
