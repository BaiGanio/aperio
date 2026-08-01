// tests/unit/db/migration-lockstep.test.js
// AGENTS.md hard rule: every migration in db/migrations/ needs a mirror in
// db/migrations-sqlite/. Schema drift here is silent and catastrophic, so guard
// the lockstep in CI. (issue #283 added 010; this keeps the pair honest.)
//
// Two levels of guard:
//   1. Filename lockstep — every migration has a mirror on the other side.
//   2. Column parity for 010_codegraph_intelligence — same columns, in the same
//      order, with equivalent type families, nullability, defaults, CHECKs,
//      foreign keys, and indexes. Filenames alone would happily pass while one
//      side is missing a column, which is exactly the silent drift the rule
//      exists to prevent.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pgDir = path.join(root, "db/migrations");
const liteDir = path.join(root, "db/migrations-sqlite");
const sqlNames = (dir) => new Set(readdirSync(dir).filter(f => f.endsWith(".sql")));

// ── Minimal SQL shape parser ────────────────────────────────────────────────
// Deliberately narrow: it understands only the statement forms the 010 pair
// uses (ALTER TABLE … ADD COLUMN, CREATE TABLE, CREATE INDEX, UPDATE). It is a
// drift detector, not a SQL engine — anything it cannot classify is surfaced as
// an "other" statement and compared verbatim, so a new statement form fails
// loudly rather than being silently ignored.

// SQLite and Postgres deliberately spell the same intent with different type
// names. Parity means "same type family", not "same token". Timestamps map to
// text because the SQLite mirror stores them as ISO-8601 strings by design.
const TYPE_FAMILY = new Map(Object.entries({
  "int": "int", "integer": "int", "bigint": "int", "int4": "int", "int8": "int",
  "real": "float", "double precision": "float", "float8": "float", "numeric": "float",
  "text": "text", "timestamptz": "text", "timestamp": "text",
}));

const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const squash = (s) => s.replace(/\s+/g, " ").trim();

// Split on `sep` at paren depth 0, ignoring separators inside single quotes.
function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0, quoted = false, cur = "";
  for (const ch of s) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && ch === sep) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(squash).filter(Boolean);
}

// "confidence TEXT NOT NULL DEFAULT 'EXTRACTED' CHECK (…)" → structured shape.
function parseColumn(spec) {
  const s = squash(spec);
  const name = s.split(/\s+/)[0];
  let rest = s.slice(name.length).trim();

  // Longest-first type match so "DOUBLE PRECISION" beats a bare word.
  let type = null;
  for (const token of [...TYPE_FAMILY.keys()].sort((a, b) => b.length - a.length)) {
    if (rest.toLowerCase().startsWith(token)) { type = token; rest = rest.slice(token.length).trim(); break; }
  }

  const check = rest.match(/CHECK\s*(\(.*\))/i);
  const dflt = rest.match(/DEFAULT\s+('[^']*'|\S+)/i);
  const refs = rest.match(/REFERENCES\s+(\w+\s*\([^)]*\)(?:\s+ON DELETE \w+)?)/i);

  return {
    name,
    family: type ? TYPE_FAMILY.get(type) : `UNKNOWN(${rest.split(/\s+/)[0]})`,
    notNull: /\bNOT NULL\b/i.test(rest),
    primaryKey: /\bPRIMARY KEY\b/i.test(rest),
    default: dflt ? dflt[1] : null,
    check: check ? squash(check[1]) : null,
    references: refs ? squash(refs[1]).toUpperCase() : null,
  };
}

function parseMigration(file) {
  const statements = splitTopLevel(stripComments(readFileSync(file, "utf8")), ";");
  const shape = { columnsAdded: {}, tables: {}, indexes: [], other: [] };

  for (const stmt of statements) {
    const alter = stmt.match(/^ALTER TABLE (\w+)\s+(.*)$/i);
    const create = stmt.match(/^CREATE TABLE (\w+)\s*\((.*)\)$/i);
    const index = stmt.match(/^CREATE INDEX (\w+) ON (\w+)\s*\((.*)\)$/i);

    if (alter) {
      const table = alter[1];
      // Postgres batches ADD COLUMNs in one statement; SQLite needs one each.
      for (const part of splitTopLevel(alter[2], ",")) {
        const col = part.match(/^ADD COLUMN\s+(.*)$/i);
        if (!col) { shape.other.push(stmt); continue; }
        (shape.columnsAdded[table] ??= []).push(parseColumn(col[1]));
      }
    } else if (create) {
      const [, table, body] = create;
      const columns = [], constraints = [];
      for (const part of splitTopLevel(body, ",")) {
        if (/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK)\b/i.test(part)) constraints.push(squash(part).toUpperCase());
        else columns.push(parseColumn(part));
      }
      shape.tables[table] = { columns, constraints };
    } else if (index) {
      shape.indexes.push({ name: index[1], table: index[2], columns: squash(index[3]) });
    } else {
      shape.other.push(squash(stmt).toUpperCase());
    }
  }
  return shape;
}

describe("migration lockstep", () => {
  test("every Postgres migration has a SQLite mirror and vice versa", () => {
    const pg = sqlNames(pgDir);
    const lite = sqlNames(liteDir);
    const onlyPg = [...pg].filter(f => !lite.has(f));
    const onlyLite = [...lite].filter(f => !pg.has(f));
    assert.deepEqual(onlyPg, [], `migrations missing a SQLite mirror: ${onlyPg.join(", ")}`);
    assert.deepEqual(onlyLite, [], `migrations missing a Postgres mirror: ${onlyLite.join(", ")}`);
  });

  test("010_codegraph_intelligence exists in both backends", () => {
    assert.ok(sqlNames(pgDir).has("010_codegraph_intelligence.sql"));
    assert.ok(sqlNames(liteDir).has("010_codegraph_intelligence.sql"));
  });

  test("011_model_facts exists in both backends", () => {
    assert.ok(sqlNames(pgDir).has("011_model_facts.sql"));
    assert.ok(sqlNames(liteDir).has("011_model_facts.sql"));
  });

  test("013_vec_meta exists in both backends", () => {
    assert.ok(sqlNames(pgDir).has("013_vec_meta.sql"));
    assert.ok(sqlNames(liteDir).has("013_vec_meta.sql"));
  });

  test("012_gemma4_e2b_model_fact exists in both backends", () => {
    assert.ok(sqlNames(pgDir).has("012_gemma4_e2b_model_fact.sql"));
    assert.ok(sqlNames(liteDir).has("012_gemma4_e2b_model_fact.sql"));
  });
});

describe("011_model_facts seed parity", () => {
  const MIGRATION = "011_model_facts.sql";
  const normalizedSeedRows = (dir) => {
    const sql = stripComments(readFileSync(path.join(dir, MIGRATION), "utf8"));
    const values = sql.match(/INSERT INTO model_facts[\s\S]*?VALUES\s*([\s\S]*?);/i)?.[1];
    assert.ok(values, `${dir} is missing the model_facts seed INSERT`);
    return squash(values).replaceAll("::jsonb", "");
  };

  test("both backends create the same table and indexes", () => {
    const pg = parseMigration(path.join(pgDir, MIGRATION));
    const lite = parseMigration(path.join(liteDir, MIGRATION));
    assert.deepEqual(pg.tables.model_facts, lite.tables.model_facts);
    assert.deepEqual(pg.indexes, lite.indexes);
  });

  test("both backends seed identical curated rows", () => {
    assert.equal(normalizedSeedRows(pgDir), normalizedSeedRows(liteDir));
  });
});

describe("012_gemma4_e2b_model_fact parity", () => {
  const MIGRATION = "012_gemma4_e2b_model_fact.sql";

  test("both backends install the same E2B model identity and sizing facts", () => {
    const normalize = dir => squash(stripComments(readFileSync(path.join(dir, MIGRATION), "utf8")))
      .replaceAll("EXCLUDED", "excluded");
    assert.equal(normalize(pgDir), normalize(liteDir));
    assert.match(normalize(pgDir), /gemma4:e2b-qat/);
    assert.match(normalize(pgDir), /unsloth\/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL/);
  });
});

describe("010_codegraph_intelligence column parity", () => {
  const MIGRATION = "010_codegraph_intelligence.sql";
  const pg = parseMigration(path.join(pgDir, MIGRATION));
  const lite = parseMigration(path.join(liteDir, MIGRATION));

  test("both sides add the same columns to the same existing tables", () => {
    assert.deepEqual(
      Object.keys(pg.columnsAdded).sort(),
      Object.keys(lite.columnsAdded).sort(),
      "ALTER TABLE targets differ between backends"
    );
    for (const table of Object.keys(pg.columnsAdded)) {
      assert.deepEqual(
        pg.columnsAdded[table], lite.columnsAdded[table],
        `columns added to ${table} drifted between backends`
      );
    }
  });

  test("cg_edges gains the confidence quad with identical constraints", () => {
    const added = pg.columnsAdded.cg_edges.map(c => c.name);
    assert.deepEqual(added, ["confidence", "confidence_score", "provenance", "relation_context"]);

    const confidence = pg.columnsAdded.cg_edges[0];
    assert.equal(confidence.family, "text");
    assert.ok(confidence.notNull, "confidence must be NOT NULL");
    assert.equal(confidence.default, "'EXTRACTED'");
    assert.match(confidence.check, /EXTRACTED.*INFERRED.*AMBIGUOUS/);

    // 0..1 bound is the contract the analysis layer relies on.
    assert.match(pg.columnsAdded.cg_edges[1].check, />= 0 AND .* <= 1/);
  });

  test("cg_repos gains the revision/analysis pointer quad", () => {
    const added = pg.columnsAdded.cg_repos.map(c => c.name);
    assert.deepEqual(added, ["index_schema_version", "graph_revision", "analyzed_revision", "analyzed_at"]);
    // Both counters must default to 0 and be NOT NULL, or an upgraded v9 repo
    // would read NULL and skip the forced rebuild / revision bump entirely.
    for (const name of ["index_schema_version", "graph_revision"]) {
      const col = pg.columnsAdded.cg_repos.find(c => c.name === name);
      assert.ok(col.notNull, `${name} must be NOT NULL`);
      assert.equal(col.default, "0", `${name} must default to 0`);
    }
  });

  test("both sides create the same analysis tables with the same shape", () => {
    assert.deepEqual(Object.keys(pg.tables).sort(), Object.keys(lite.tables).sort());
    assert.deepEqual(Object.keys(pg.tables).sort(), ["cg_communities", "cg_symbol_metrics"]);
    for (const table of Object.keys(pg.tables)) {
      assert.deepEqual(pg.tables[table], lite.tables[table], `${table} drifted between backends`);
    }
  });

  test("analysis tables cascade from their parents on both sides", () => {
    for (const shape of [pg, lite]) {
      const communities = shape.tables.cg_communities.columns.find(c => c.name === "repo_id");
      assert.match(communities.references, /CG_REPOS\s*\(ID\) ON DELETE CASCADE/);
      const metrics = shape.tables.cg_symbol_metrics.columns;
      assert.match(metrics.find(c => c.name === "symbol_id").references, /CG_SYMBOLS\s*\(ID\) ON DELETE CASCADE/);
      assert.match(metrics.find(c => c.name === "repo_id").references, /CG_REPOS\s*\(ID\) ON DELETE CASCADE/);
    }
  });

  test("both sides create the same indexes", () => {
    const byName = (a, b) => a.name.localeCompare(b.name);
    assert.deepEqual([...pg.indexes].sort(byName), [...lite.indexes].sort(byName));
  });

  test("the v10 upgrade backfill is identical on both sides", () => {
    assert.deepEqual(pg.other, lite.other, "non-DDL statements (the backfill UPDATE) drifted");
    const backfill = pg.other.find(s => s.startsWith("UPDATE CG_EDGES"));
    assert.ok(backfill, "the conservative INFERRED backfill is missing");
    // Only already-resolved edges may be reclassified — unresolved extractor
    // rows must keep the EXTRACTED default, or we would fabricate confidence.
    assert.match(backfill, /DST_SYMBOL_ID IS NOT NULL/);
    assert.match(backfill, /CONFIDENCE = 'INFERRED'/);
    assert.match(backfill, /CONFIDENCE_SCORE = 0\.8/);
  });
});

// ── 013_vec_meta parity ─────────────────────────────────────────────────────
// vec_meta drives which stores are allowed to serve vector search. A column or
// CHECK constraint present on one backend but not the other means one backend
// silently accepts a status the other rejects — the exact class of drift the
// lockstep rule exists to catch.
describe("013_vec_meta parity", () => {
  const MIGRATION = "013_vec_meta.sql";
  const pg = squash(stripComments(readFileSync(path.join(pgDir, MIGRATION), "utf8")));
  const lite = squash(stripComments(readFileSync(path.join(liteDir, MIGRATION), "utf8")));

  test("both sides create vec_meta with the same columns", () => {
    for (const col of ["store_name", "signature", "dims", "status", "vectors_cleared",
                       "reindex_owner", "reindex_expires_at", "updated_at"]) {
      assert.ok(pg.includes(col), `postgres missing ${col}`);
      assert.ok(lite.includes(col), `sqlite missing ${col}`);
    }
  });

  test("store_name is the primary key on both sides", () => {
    assert.match(pg, /store_name\s+TEXT PRIMARY KEY/i);
    assert.match(lite, /store_name\s+TEXT PRIMARY KEY/i);
  });

  test("both sides constrain status to the same three values", () => {
    for (const [name, sql] of [["postgres", pg], ["sqlite", lite]]) {
      assert.match(sql, /CHECK \(status IN \('current', 'stale', 'reindexing'\)\)/i, `${name} status CHECK`);
      assert.match(sql, /DEFAULT 'current'/i, `${name} status default`);
    }
  });

  test("both sides index status", () => {
    assert.match(pg, /CREATE INDEX idx_vec_meta_status ON vec_meta \(status\)/i);
    assert.match(lite, /CREATE INDEX idx_vec_meta_status ON vec_meta \(status\)/i);
  });

  test("the reindex lease exists on both sides", () => {
    // The lease is what stops two runners from clearing and re-embedding the
    // same store; a backend missing it silently loses that guarantee.
    assert.match(pg, /reindex_owner\s+TEXT/i);
    assert.match(pg, /reindex_expires_at\s+TIMESTAMPTZ/i);
    assert.match(lite, /reindex_owner\s+TEXT/i);
    assert.match(lite, /reindex_expires_at\s+TEXT/i);
  });

  test("the clear checkpoint exists on both sides and defaults to false", () => {
    // Without it, a crash between "status = reindexing" and the actual clear
    // resumes into a store that skips the clear and is then declared current
    // with its entire old embedding space still in place.
    assert.match(pg, /vectors_cleared\s+BOOLEAN NOT NULL DEFAULT false/i);
    assert.match(lite, /vectors_cleared\s+INTEGER NOT NULL DEFAULT 0/i);
  });

  test("dims is an integer family on both sides", () => {
    assert.match(pg, /dims\s+INT\b/i);
    assert.match(lite, /dims\s+INTEGER\b/i);
  });
});
