// tests/db-connect/classify.test.js
// Exhaustive tests for the SQL statement classifier (issue #170).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  classify, splitStatements, isAllowedForQuery, isAllowedForExecute,
  countPlaceholders, describeSqlitePlaceholders,
} from "../../../lib/db-connect/classify.js";

const cls = (sql) => classify(sql).class;

describe("classify — reads", () => {
  for (const sql of [
    "SELECT * FROM users",
    "  select 1",
    "SELECT * FROM t WHERE name = 'a;b'",        // ';' inside a string literal
    "WITH t AS (SELECT 1) SELECT * FROM t",      // plain CTE
    "EXPLAIN SELECT * FROM users",
    "EXPLAIN QUERY PLAN SELECT 1",
    "PRAGMA table_info(users)",
    "SHOW TABLES",
    "DESCRIBE users",
    "VALUES (1), (2)",
    "(SELECT 1)",                                // leading paren
  ]) {
    test(`read: ${sql}`, () => assert.equal(cls(sql), "read"));
  }
});

describe("classify — writes", () => {
  for (const sql of [
    "INSERT INTO t (a) VALUES (1)",
    "update t set a = 1 where id = 2",
    "DELETE FROM t WHERE id = 1",
    "REPLACE INTO t (a) VALUES (1)",
    "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET a = 1",
  ]) {
    test(`write: ${sql}`, () => assert.equal(cls(sql), "write"));
  }

  test("data-modifying CTE escalates to write", () => {
    assert.equal(cls("WITH d AS (DELETE FROM t RETURNING id) SELECT * FROM d"), "write");
  });
  test("EXPLAIN ANALYZE of a DML escalates to write", () => {
    assert.equal(cls("EXPLAIN ANALYZE INSERT INTO t (a) VALUES (1)"), "write");
  });
});

describe("classify — DDL", () => {
  for (const sql of [
    "CREATE TABLE t (id INT)",
    "ALTER TABLE t ADD COLUMN b INT",
    "DROP TABLE t",
    "TRUNCATE TABLE t",
    "CREATE INDEX idx ON t (a)",
  ]) {
    test(`ddl: ${sql}`, () => assert.equal(cls(sql), "ddl"));
  }
});

describe("classify — multi-statement", () => {
  for (const sql of [
    "SELECT 1; SELECT 2",
    "INSERT INTO t (a) VALUES (1); DELETE FROM t",
    "DROP TABLE a; DROP TABLE b",
  ]) {
    test(`multi: ${sql}`, () => assert.equal(cls(sql), "multi"));
  }

  test("trailing semicolon is NOT multi", () => {
    assert.equal(cls("SELECT 1;"), "read");
    assert.equal(cls("DELETE FROM t;  "), "write");
  });
  test("semicolon inside a string literal is NOT a boundary", () => {
    assert.equal(cls("SELECT * FROM t WHERE s = 'a; b; c'"), "read");
    assert.equal(cls("INSERT INTO t (a) VALUES ('x;y')"), "write");
  });
  test("semicolon inside a comment is NOT a boundary", () => {
    assert.equal(cls("SELECT 1 -- a; b\n"), "read");
    assert.equal(cls("SELECT 1 /* a; b */"), "read");
  });
});

describe("classify — unknown / empty", () => {
  for (const sql of ["", "   ", "-- just a comment", "/* x */", "BANANA foo", "BEGIN"]) {
    test(`unknown: ${JSON.stringify(sql)}`, () => assert.equal(cls(sql), "unknown"));
  }
  test("null/undefined are unknown", () => {
    assert.equal(cls(null), "unknown");
    assert.equal(cls(undefined), "unknown");
  });
});

describe("comment stripping", () => {
  test("line comment is removed, keyword still found", () => {
    assert.equal(cls("-- header\nSELECT 1"), "read");
  });
  test("# comment (MySQL) is removed", () => {
    assert.equal(cls("# note\nUPDATE t SET a = 1"), "write");
  });
  test("block comment before the keyword", () => {
    assert.equal(cls("/* lead */ DROP TABLE t"), "ddl");
  });
  test("comment markers inside a string survive", () => {
    const stmts = splitStatements("SELECT '-- not a comment', '/* nor this */'");
    assert.equal(stmts.length, 1);
    assert.match(stmts[0], /not a comment/);
  });
});

describe("countPlaceholders (mysql/postgres/mssql)", () => {
  test("mysql: counts single '?' as one slot", () => {
    assert.equal(countPlaceholders("INSERT INTO t (a) VALUES (?)", "mysql"), 1);
    assert.equal(countPlaceholders("UPDATE t SET a = ? WHERE b = ?", "mysql"), 2);
  });
  test("mysql: '??' identifier placeholder is one slot, not two", () => {
    assert.equal(countPlaceholders("UPDATE ?? SET ?? = ?", "mysql"), 3);
    assert.equal(countPlaceholders("SELECT * FROM ??", "mysql"), 1);
  });
  test("mysql: a block comment between two placeholder runs does not merge their counts (P2 regression)", () => {
    // Confirmed live: mysql2.format('UPDATE ??/* alias */?? SET value = ?',
    // ['t', 'a', 5]) => "UPDATE `t`/* alias */`a` SET value = 5" — the
    // formatter treats the two '??' as two independent identifier slots
    // despite the comment between them, so 3 params are genuinely required.
    // An earlier version of maskLiteralsAndComments masked the comment to
    // nothing rather than a separating space, so '??' + '' + '??' merged
    // into one run of 4 — which the run-length rule below (3+ is not a
    // placeholder) counted as ZERO instead of two, rejecting a valid call.
    assert.equal(countPlaceholders("UPDATE ??/* alias */?? SET value = ?", "mysql"), 3);
    // Same merge risk for a bare '?' run, one comment character shorter of
    // becoming an accidental '???' (3+, i.e. "not a placeholder").
    assert.equal(countPlaceholders("SELECT ?/* x */? FROM t", "mysql"), 2);
  });
  test("mysql: a run of 3+ '?' is not a placeholder at all (matches sql-escaper)", () => {
    assert.equal(countPlaceholders("SELECT '???'", "mysql"), 0); // inside a string anyway
    assert.equal(countPlaceholders("UPDATE t SET a = ???", "mysql"), 0);
  });
  test("mysql: backslash is a real string escape (default sql_mode)", () => {
    // 'it\\'s' is ONE string (escaped quote), so the '?' after WHERE is the only placeholder.
    assert.equal(countPlaceholders("UPDATE t SET name = 'it\\'s' WHERE id = ?", "mysql"), 1);
  });
  test("postgres: uses the highest $N referenced, not the occurrence count", () => {
    assert.equal(countPlaceholders("INSERT INTO t (a, b) VALUES ($1, $2)", "postgres"), 2);
    assert.equal(countPlaceholders("SELECT * FROM t WHERE a = $1 OR b = $1", "postgres"), 1);
    assert.equal(countPlaceholders("SELECT 1", "postgres"), 0);
  });
  test("postgres: backslash has no special meaning in a standard-conforming string", () => {
    // '\' is the one-character string `\`; the '?'-equivalent ($1) after WHERE is real.
    assert.equal(countPlaceholders("UPDATE t SET path = '\\' WHERE id = $1", "postgres"), 1);
  });
  test("postgres: '#' is a jsonb operator, not a comment — placeholders after it still count", () => {
    assert.equal(countPlaceholders("UPDATE t SET data = data #- $1 WHERE id = $2", "postgres"), 2);
    assert.equal(countPlaceholders("SELECT data #> $1, data #>> $2 FROM t", "postgres"), 2);
  });
  test("mysql: '#' is NOT masked — the bundled sql-escaper formatter doesn't skip it either (P2 regression)", () => {
    // Confirmed live against mysql2.format(): a '?' after '#' still consumes
    // a real params slot ('UPDATE t SET a = 1 # trailing comment with a 2 in
    // it' when called with [1, 2]) — so this validator must count it too,
    // or a genuine mismatch would slip past validation into a bad bind.
    assert.equal(countPlaceholders("UPDATE t SET a = ? # trailing comment with a ? in it\n", "mysql"), 2);
  });
  test("mysql: a '?' inside a double-quoted string is NOT masked — the formatter consumes it as a real slot (P2 regression)", () => {
    // Confirmed live: mysql2.format('UPDATE t SET a=\"?\" WHERE id=?', ['x', 5])
    // binds 'x' into the quoted \"?\" and 5 into the real id=? — two slots,
    // not one. Masking \"...\" for MySQL (as Postgres/mssql identifier-quoting
    // correctly does) would under-count against that real consumption.
    assert.equal(countPlaceholders('UPDATE t SET a="?" WHERE id=?', "mysql"), 2);
  });
  test("postgres/mssql still mask double-quoted identifiers (unaffected by the MySQL '\"' change)", () => {
    assert.equal(countPlaceholders('SELECT "col$1" FROM t WHERE id = $1', "postgres"), 1);
    assert.equal(countPlaceholders('SELECT "col@p0" FROM t WHERE id = @p0', "mssql"), 1);
  });
  test("postgres: E'...' extended string DOES interpret backslash escapes", () => {
    // E'it\'s' is ONE string (escaped quote); the real placeholder after it still counts.
    assert.equal(countPlaceholders("UPDATE t SET name = E'it\\'s' WHERE id = $1", "postgres"), 1);
    assert.equal(countPlaceholders("UPDATE t SET name = e'it\\'s' WHERE id = $1", "postgres"), 1);
  });
  test("postgres: a standalone 'E' immediately before a quote is required — not any identifier ending in E/e", () => {
    // 'E' must be its own token (preceded by non-identifier char), not the tail of a longer word.
    assert.equal(countPlaceholders("SELECT TABLE'x', $1", "postgres"), 1);
  });
  test("postgres: '$N' embedded in an unquoted identifier is not a placeholder", () => {
    // Postgres identifiers may contain '$' after the first character, so
    // foo$1 is one column name, not "foo" followed by a real $1 placeholder.
    assert.equal(countPlaceholders("UPDATE t SET foo$1 = 5", "postgres"), 0);
    assert.equal(countPlaceholders("UPDATE t SET foo$1 = $2", "postgres"), 2); // only $2 is real, but it's the 2nd slot
    assert.equal(countPlaceholders("UPDATE t SET a = $1 WHERE id = 5", "postgres"), 1);
  });
  test("mysql: '--' opens a comment only when followed by whitespace (P2 regression)", () => {
    // Confirmed live against the bundled sql-escaper formatter:
    //   format('UPDATE t SET a=?--x + ? WHERE id=?', [1,2,3])
    //     => 'UPDATE t SET a=1--x + 2 WHERE id=3'   (three slots consumed)
    //   format('UPDATE t SET a=? -- x + ?\nWHERE id=?', [1,2])
    //     => the commented '?' is skipped              (two slots consumed)
    // Masking the first form as a comment under-counted it to 1, so a valid
    // 3-param call was rejected before ever being proposed.
    assert.equal(countPlaceholders("UPDATE t SET a=?--x + ? WHERE id=?", "mysql"), 3);
    assert.equal(countPlaceholders("UPDATE t SET a=? -- x + ?\nWHERE id=?", "mysql"), 2);
    // Every other dialect starts a line comment at any '--'.
    assert.equal(countPlaceholders("UPDATE t SET a=$1--x + $9\n", "postgres"), 1);
  });
  test("mysql: '/*! */' and '/*+ */' are not comments to the formatter — placeholders inside them count (P2 regression)", () => {
    // Confirmed live: format('SELECT /*! ? */ , ?', [1,2]) => 'SELECT /*! 1
    // */ , 2', and format('SELECT /*+ hint(?) */ a FROM t WHERE b=?', [1,2])
    // fills both. MySQL executes the contents of a version-gated comment, so
    // those placeholders are real slots.
    assert.equal(countPlaceholders("SELECT /*! ? */ , ?", "mysql"), 2);
    assert.equal(countPlaceholders("SELECT /*+ hint(?) */ a FROM t WHERE b=?", "mysql"), 2);
    // A plain block comment is still masked.
    assert.equal(countPlaceholders("SELECT /* c ? */ ?", "mysql"), 1);
  });
  test("postgres/mssql nest block comments; mysql/sqlite stop at the first '*/' (P2 regression)", () => {
    // Postgres and SQL Server both nest '/* ... */'. Stopping at the first
    // '*/' exposed the outer comment's tail to placeholder matching, so this
    // statement counted 99 parameters instead of 2 and a valid write was
    // rejected.
    assert.equal(countPlaceholders("UPDATE t SET a=$1 /* outer /* inner */ $99 */ WHERE id=$2", "postgres"), 2);
    assert.equal(countPlaceholders("UPDATE t SET a=@p0 /* outer /* inner */ @p98 */ WHERE id=@p1", "mssql"), 2);
    // MySQL does NOT nest: the first '*/' really does end the comment, so
    // the trailing '?' after it is a genuine slot (plus the real one).
    assert.equal(countPlaceholders("UPDATE t SET a=? /* outer /* inner */ WHERE id=?", "mysql"), 2);
  });
  test("mssql: highest @pN referenced + 1", () => {
    assert.equal(countPlaceholders("INSERT INTO t (a, b) VALUES (@p0, @p1)", "mssql"), 2);
    assert.equal(countPlaceholders("SELECT 1", "mssql"), 0);
  });
  test("mssql: '@pN' embedded in an unquoted identifier is not a placeholder", () => {
    // SQL Server regular identifiers may contain '@' after the first character.
    assert.equal(countPlaceholders("UPDATE t SET foo@p0 = 5", "mssql"), 0);
    assert.equal(countPlaceholders("UPDATE t SET a = @p0", "mssql"), 1);
  });
  test("mssql: '@' and '#' are themselves valid identifier-continuation characters before '@pN' (P2 regression)", () => {
    // SQL Server docs: "subsequent characters can be letters, decimal
    // digits, @, $, or #" — so foo@@p0/foo#@p0 are each ONE identifier, not
    // an identifier followed by a real @p0 placeholder.
    assert.equal(countPlaceholders("UPDATE t SET foo@@p0 = 1", "mssql"), 0);
    assert.equal(countPlaceholders("UPDATE t SET foo#@p0 = 1", "mssql"), 0);
    // A real placeholder after a normal identifier still counts.
    assert.equal(countPlaceholders("UPDATE t SET foo = @p0", "mssql"), 1);
  });
  test("placeholder-shaped text inside a string/comment literal does not count", () => {
    assert.equal(countPlaceholders("SELECT * FROM t WHERE s = '?'", "postgres"), 0);
  });
  test("postgres: a $N inside a dollar-quoted string is not a real placeholder", () => {
    assert.equal(countPlaceholders("UPDATE t SET value = $$literal $1$$", "postgres"), 0);
    assert.equal(countPlaceholders("UPDATE t SET value = $tag$literal $1$tag$ WHERE id = $1", "postgres"), 1);
  });
  test("postgres: a '$tag$'-shaped run immediately after an identifier is not a dollar-quote opener (P2 regression)", () => {
    // Postgres identifiers may contain '$' (not as the first character), so
    // `foo$tag$bar` is ONE identifier, not "foo" followed by a dollar-quote
    // open — the real $1 later in the statement must still be seen.
    assert.equal(countPlaceholders("SELECT foo$tag$bar, $1 FROM t", "postgres"), 1);
    // An actual dollar-quote opener (not preceded by an identifier char)
    // still masks its contents as before.
    assert.equal(countPlaceholders("SELECT $tag$literal $1$tag$, $2 FROM t", "postgres"), 2);
  });
  test("postgres: a real placeholder inside an array literal still counts", () => {
    assert.equal(countPlaceholders("UPDATE t SET a = ARRAY[$1, $2]", "postgres"), 2);
  });
  test("mssql: a bracket-quoted identifier is not a placeholder", () => {
    assert.equal(countPlaceholders("UPDATE t SET [@p0] = 1", "mssql"), 0);
  });
  test("mssql: a doubled ']]' escape inside a bracket-quoted identifier is not the terminator (P2 regression)", () => {
    // T-SQL escapes a literal ']' by doubling it: [foo]]@p0] names column
    // "foo]@p0" — no real placeholder. Confirmed the naive first-']' scan
    // stops early and exposes the trailing @p0 to placeholder matching.
    assert.equal(countPlaceholders("UPDATE t SET [foo]]@p0] = 1", "mssql"), 0);
    // A real placeholder after a bracket identifier containing the escape
    // still counts once the identifier is correctly closed.
    assert.equal(countPlaceholders("UPDATE t SET [foo]]bar] = @p0", "mssql"), 1);
  });
});

describe("describeSqlitePlaceholders", () => {
  test("anonymous '?' only", () => {
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b) VALUES (?, ?)");
    assert.equal(d.anonymous, 2);
    assert.equal(d.named.size, 0);
  });
  test("named :name / @name / $name are collected, not counted as array slots", () => {
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b, c) VALUES (:a, @b, $c)");
    assert.deepEqual([...d.named].sort(), ["a", "b", "c"]);
    assert.equal(d.anonymous, 0);
  });
  test("a name repeated in the SQL is still one distinct name", () => {
    const d = describeSqlitePlaceholders("SELECT * FROM t WHERE a = :x OR b = :x");
    assert.deepEqual([...d.named], ["x"]);
  });
  test("numbered '?N' is collected as a named (digit-string) placeholder, distinct from anonymous '?'", () => {
    const d = describeSqlitePlaceholders("SELECT * FROM t WHERE a = ?1 AND b = ?2");
    assert.deepEqual([...d.named].sort(), ["1", "2"]);
    assert.equal(d.anonymous, 0);
    assert.equal(describeSqlitePlaceholders("SELECT * FROM t WHERE a = ?").anonymous, 1);
  });
  test("numeric named parameters (:1, $2) are recognized, not just letter/underscore-led names", () => {
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b) VALUES (:1, $2)");
    assert.deepEqual([...d.named].sort(), ["1", "2"]);
  });
  test("$value$ is ONE named parameter whose name includes the trailing '$', not a dollar-quoted string", () => {
    const d = describeSqlitePlaceholders("INSERT INTO t (a) VALUES ($value$)");
    assert.deepEqual([...d.named], ["value$"]);
    assert.equal(d.anonymous, 0);
  });
  test("a numbered ?N aliases an index an earlier named placeholder already claimed — no extra key needed (P2 regression)", () => {
    // Confirmed live against better-sqlite3: VALUES (:x, ?1) runs with only
    // {x: value} — ?1 refers to the same slot :x already owns.
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b) VALUES (:x, ?1)");
    assert.deepEqual([...d.named], ["x"]);
    assert.equal(d.anonymous, 0);
  });
  test("a numbered ?N aliasing a BARE '?' converts that slot to named, not anonymous (P2 regression)", () => {
    // Confirmed live against better-sqlite3: VALUES (?, ?1) rejects
    // params: [v] with "Too many parameter values were provided" but runs
    // on params: [{"1": v}] — the earlier alias case above only covers the
    // slot already being named; when it was claimed by a bare `?` instead,
    // the retroactive conversion must also happen, or a caller trusting
    // desc.anonymous would propose the exact positional shape that fails.
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b) VALUES (?, ?1)");
    assert.deepEqual([...d.named], ["1"]);
    assert.equal(d.anonymous, 0);
  });
  test("every bare '?' aliased by a later ?N converts, needing zero positional args (P2 regression)", () => {
    // Confirmed live: VALUES (?, ?, ?1, ?2) runs on {"1": v1, "2": v2} alone
    // — both bare slots are aliased, so neither needs a positional filler.
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b, c, d) VALUES (?, ?, ?1, ?2)");
    assert.deepEqual([...d.named].sort(), ["1", "2"]);
    assert.equal(d.anonymous, 0);
  });
  test("order matters: ?1 BEFORE :x claims the index first, so both keys are independently required", () => {
    // Confirmed live: VALUES (?1, :x) throws "Missing named parameter \"1\""
    // unless both '1' and 'x' keys are provided — ?1 grabs index 1 before
    // :x is assigned, pushing :x to index 2 instead of aliasing it.
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b) VALUES (?1, :x)");
    assert.deepEqual([...d.named].sort(), ["1", "x"]);
    assert.equal(d.anonymous, 0);
  });
  test("non-ASCII named parameters (:é, $é, @é) are recognized, not treated as zero placeholders (P2 regression)", () => {
    // SQLite's IdChar rule accepts any byte >= 0x80 as a name character —
    // confirmed live against {"é": value} for all three sigils.
    assert.deepEqual([...describeSqlitePlaceholders("INSERT INTO t (a) VALUES (:é)").named], ["é"]);
    assert.deepEqual([...describeSqlitePlaceholders("SELECT $é").named], ["é"]);
    assert.deepEqual([...describeSqlitePlaceholders("SELECT @é").named], ["é"]);
  });
  test("a '$' preceded by a non-ASCII identifier character is not mistaken for a placeholder sigil (P2 regression)", () => {
    // SQLite accepts an unquoted column named é$bar as ONE identifier
    // (confirmed live) — the '$' here is a continuation character, not a
    // placeholder start, even though the preceding char is non-ASCII.
    const d = describeSqlitePlaceholders("UPDATE t2 SET é$bar=1");
    assert.equal(d.anonymous, 0);
    assert.equal(d.named.size, 0);
  });
  test("':x', '@x', and '$x' are three distinct slots sharing one object key (P2 regression)", () => {
    // Confirmed live against better-sqlite3: UPDATE t SET a=:x, b=@x, c=?2
    // runs on {x: value} alone — ?2 aliases @x's slot (the 2nd distinct
    // one), even though :x and @x both bind from the same "x" key.
    const d = describeSqlitePlaceholders("UPDATE t SET a=:x, b=@x, c=?2");
    assert.deepEqual([...d.named], ["x"]);
    assert.equal(d.anonymous, 0);
  });
  test("a fourth sigil variant of the same bare name needs its own key once nothing aliases it", () => {
    // Confirmed live: UPDATE t SET a=:x, b=@x, c=$x, d=?4 throws "Missing
    // named parameter \"4\"" unless both 'x' and '4' keys are supplied —
    // :x/@x/$x claim 3 distinct slots, so ?4 can't alias any of them.
    const d = describeSqlitePlaceholders("UPDATE t SET a=:x, b=@x, c=$x, d=?4");
    assert.deepEqual([...d.named].sort(), ["4", "x"]);
    assert.equal(d.anonymous, 0);
    // ?3 instead DOES alias $x's slot (the 3rd one) — no extra key needed.
    const d3 = describeSqlitePlaceholders("UPDATE t SET a=:x, b=@x, c=$x, d=?3");
    assert.deepEqual([...d3.named], ["x"]);
    assert.equal(d3.anonymous, 0);
  });
  test("?N used alone leaves a nameless gap that needs an extra anonymous value (confirmed live against better-sqlite3)", () => {
    // ?2 alone: SQLite still reserves index 1 (nothing in the text claims it),
    // so one anonymous filler is needed on top of the {"2": …} object.
    const d = describeSqlitePlaceholders("INSERT INTO t (a) VALUES (?2)");
    assert.equal(d.anonymous, 1);
    assert.deepEqual([...d.named], ["2"]);
  });
  test("?N followed by a bare '?' needs a gap filler AND the bare value (two anonymous slots)", () => {
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b) VALUES (?2, ?)");
    assert.equal(d.anonymous, 2);
    assert.deepEqual([...d.named], ["2"]);
  });
  test("a bare '?' before ?N claims the low index first, leaving no gap", () => {
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b) VALUES (?, ?2)");
    assert.equal(d.anonymous, 1);
    assert.deepEqual([...d.named], ["2"]);
  });
  test("contiguous ?1, ?2 (no gap) needs zero anonymous fillers", () => {
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b) VALUES (?1, ?2)");
    assert.equal(d.anonymous, 0);
    assert.deepEqual([...d.named].sort(), ["1", "2"]);
  });
  test("a named parameter followed by a large jump (?5) leaves gaps for every unclaimed index in between", () => {
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b) VALUES (:a, ?5)");
    // :a claims index 1; ?5 jumps the high-water mark to 5, leaving 2,3,4 unclaimed.
    assert.equal(d.anonymous, 3);
    assert.deepEqual([...d.named].sort(), ["5", "a"]);
  });
  test("'$' embedded in an unquoted identifier is not a placeholder", () => {
    // $ is a valid, non-leading SQLite unquoted-identifier character
    // (CREATE TABLE t (foo$bar INT) is one real column, confirmed live).
    const d = describeSqlitePlaceholders("UPDATE t SET foo$bar = 1");
    assert.equal(d.anonymous, 0);
    assert.equal(d.named.size, 0);
  });
  test("a real named placeholder after an identifier containing '$' is still recognized", () => {
    const d = describeSqlitePlaceholders("UPDATE t SET foo$bar = 1 WHERE id = $x");
    assert.equal(d.anonymous, 0);
    assert.deepEqual([...d.named], ["x"]);
  });
  test("':' and '@' are unconditional sigils — never valid SQLite identifier characters", () => {
    const d = describeSqlitePlaceholders("UPDATE t SET a = :x, b = @y");
    assert.deepEqual([...d.named].sort(), ["x", "y"]);
  });
  test("a numbered placeholder above SQLite's max (32766) is flagged, not silently accepted", () => {
    assert.equal(describeSqlitePlaceholders("SELECT ?32766").outOfRangeNumber, null);
    assert.equal(describeSqlitePlaceholders("SELECT ?32767").outOfRangeNumber, 32767);
  });
  test("'?0' is rejected as out of range, not reported as a named '0' with -1 anonymous slots (P2 regression)", () => {
    // Confirmed live against the bundled better-sqlite3: db.prepare('SELECT
    // ?0') throws the SAME "variable number must be between ?1 and ?32766"
    // as ?32767. Left to fall through the range check, ?0 claimed index 0
    // without advancing nVar, so `gaps = nVar - claimed.size` went to -1 and
    // the caller reported an impossible shape error instead of the real
    // invalid-number one.
    const d = describeSqlitePlaceholders("SELECT ?0");
    assert.equal(d.outOfRangeNumber, 0);
    assert.equal(d.anonymous, 0);
    assert.equal(d.named.size, 0);
  });
  test("an absurdly large numbered placeholder resolves instantly, without a per-index loop (perf regression)", () => {
    const start = Date.now();
    const d = describeSqlitePlaceholders("SELECT ?1000000000");
    const elapsedMs = Date.now() - start;
    assert.equal(d.outOfRangeNumber, 1000000000);
    assert.ok(elapsedMs < 50, `expected near-instant resolution, took ${elapsedMs}ms`);
  });
  test("mixed anonymous + named", () => {
    const d = describeSqlitePlaceholders("INSERT INTO t (a, b) VALUES (?, :b)");
    assert.equal(d.anonymous, 1);
    assert.deepEqual([...d.named], ["b"]);
  });
  test("a bracket-quoted identifier is not a placeholder", () => {
    const d = describeSqlitePlaceholders("UPDATE t SET [?] = 1");
    assert.equal(d.anonymous, 0);
  });
  test("a backslash has no special meaning in a SQLite string literal", () => {
    // '\' is the one-character string `\`; the '?' after WHERE is the only real placeholder.
    const d = describeSqlitePlaceholders("UPDATE t SET path = '\\' WHERE id = ?");
    assert.equal(d.anonymous, 1);
  });
  test("placeholder-shaped text inside a string/comment literal does not count", () => {
    const d = describeSqlitePlaceholders("SELECT * FROM t WHERE s = '?' -- $1 @p0 :name\n");
    assert.equal(d.anonymous, 0);
    assert.equal(d.named.size, 0);
  });
});

describe("gate helpers", () => {
  test("isAllowedForQuery only passes reads", () => {
    assert.equal(isAllowedForQuery("SELECT 1"), true);
    assert.equal(isAllowedForQuery("DELETE FROM t"), false);
    assert.equal(isAllowedForQuery("SELECT 1; SELECT 2"), false);
  });
  test("isAllowedForExecute passes write + ddl, rejects read/multi/unknown", () => {
    assert.equal(isAllowedForExecute("INSERT INTO t (a) VALUES (1)"), true);
    assert.equal(isAllowedForExecute("DROP TABLE t"), true);
    assert.equal(isAllowedForExecute("SELECT 1"), false);
    assert.equal(isAllowedForExecute("DELETE FROM a; DELETE FROM b"), false);
    assert.equal(isAllowedForExecute("BANANA"), false);
  });
});
