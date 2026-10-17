// tests/unit/db/vec-fallback.test.js
//
// sqlite-vec publishes prebuilt loadable extensions for a fixed platform list
// (darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64). On anything
// else — win32-arm64 today — sqliteVec.load() throws. That call used to sit
// uncaught in SqliteStore.init(), so Aperio did not degrade on those machines:
// it crashed the first time anything opened the database, and the nightly
// Windows-ARM suite failed 290 tests behind that one throw.
//
// What is locked in here is the degraded mode: the schema still applies, with
// every vec0 sidecar replaced by an ordinary table of the same name and width,
// so triggers, LEFT JOIN recall queries and embedding writes all keep working
// and only KNN search is off — which lib/helpers/vecMeta.js then gates.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { runSqliteMigrations } from "../../../db/migrate-sqlite.js";
import {
  fallbackVecTableSql,
  hasUnrewritableVec0,
  loadVectorExtension,
  reconcileVecSidecars,
  rewriteVec0Tables,
} from "../../../db/sqlite/vecSupport.js";
import { isVectorSearchable } from "../../../lib/helpers/vecMeta.js";

// Every vec0 sidecar the migrations declare. Kept explicit rather than derived
// so adding a sixth store to the schema without teaching this test about it
// shows up as a failure here.
const VEC_TABLES = [
  "vec_memories",
  "vec_wiki",
  "vec_self_memories",
  "vec_cg_symbols",
  "vec_docgraph_chunks",
];

describe("sqlite-vec unavailable — plain-table fallback", () => {
  test("rewrites a vec0 declaration into an ordinary table of the same shape", () => {
    const sql = rewriteVec0Tables(
      "CREATE VIRTUAL TABLE vec_memories USING vec0(\n  rowid INTEGER PRIMARY KEY,\n  embedding FLOAT[1024]\n);"
    );
    assert.equal(sql, `${fallbackVecTableSql("vec_memories", 1024)};`);
    assert.equal(hasUnrewritableVec0(sql), false);
  });

  test("leaves SQL without a vec0 declaration untouched", () => {
    const sql = "CREATE TABLE memories (id TEXT PRIMARY KEY);";
    assert.equal(rewriteVec0Tables(sql), sql);
  });

  test("flags a vec0 shape the rewriter does not recognise", () => {
    // A column list this repository does not use must not be silently mangled
    // into something that merely parses.
    const sql = rewriteVec0Tables(
      "CREATE VIRTUAL TABLE vec_odd USING vec0(rowid INTEGER PRIMARY KEY, tag TEXT, embedding FLOAT[64]);"
    );
    assert.equal(hasUnrewritableVec0(sql), true);
  });

  test("the whole schema applies, and every sidecar is a plain table of the declared width", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    await runSqliteMigrations(db, { vectorSupported: false });

    for (const table of VEC_TABLES) {
      const row = db.prepare(
        `SELECT type, sql FROM sqlite_master WHERE name = ?`
      ).get(table);
      assert.ok(row, `${table} should exist`);
      assert.equal(row.type, "table", `${table} should not be a virtual table`);
      // getVectorDims() reads the width straight out of this CREATE text, so
      // the declared type has to survive the rewrite verbatim.
      assert.match(row.sql, /FLOAT\[1024\]/, `${table} should keep its declared width`);
    }
    db.close();
  });

  test("triggers, LEFT JOIN reads and embedding writes all still work", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    await runSqliteMigrations(db, { vectorSupported: false });

    db.prepare(
      `INSERT INTO memories (id, title, content, type) VALUES ('m1', 'T', 'C', 'fact')`
    ).run();
    const { rowid } = db.prepare(`SELECT rowid FROM memories WHERE id = 'm1'`).get();

    // The write path stores an opaque BLOB nothing reads back — it must not throw.
    db.prepare(`INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)`)
      .run(BigInt(rowid), Buffer.alloc(1024 * 4));

    const joined = db.prepare(`
      SELECT m.id, (v.embedding IS NOT NULL) AS has_vec
        FROM memories m LEFT JOIN vec_memories v ON v.rowid = m.rowid
    `).all();
    assert.deepEqual(joined, [{ id: "m1", has_vec: 1 }]);

    // trg_memories_vec_cleanup references the sidecar by name; it resolves
    // against the plain table exactly as it did against vec0.
    db.prepare(`DELETE FROM memories WHERE id = 'm1'`).run();
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM vec_memories`).get().c, 0);
    db.close();
  });

  test("a store reporting no vector support is served full-text only", async () => {
    // vectorSupported wins outright: no vec_meta lookup can make a store whose
    // vectors cannot be MATCH-ed searchable again.
    const unsupported = {
      vectorSupported: false,
      listVecMeta: async () => [],
      seedVecMeta: async () => true,
      updateVecMeta: async () => {},
      getVecMeta: async () => { throw new Error("must not be consulted"); },
    };
    assert.equal(await isVectorSearchable(unsupported, "memories"), false);

    // A backend that never sets the flag (PostgresStore, test doubles) keeps
    // the behavior it had before the flag existed.
    assert.equal(await isVectorSearchable({}, "memories"), true);
  });
});

// ── Reconciling a database built on the other kind of machine ───────────────
//
// The migration rewrite only covers migrations that have not run yet. A
// database carried between a machine with the extension and one without it has
// every migration recorded already, so its sidecars survive in the wrong
// physical form — and a surviving vec0 table fails *every* read with
// "no such module: vec0", not just KNN.
//
// Building the "wrong" state needs a real sqlite-vec, so these skip on a
// platform that has none — which is exactly the platform the repair is for.

const workdir = mkdtempSync(join(tmpdir(), "aperio-vecreconcile-"));
after(() => rmSync(workdir, { recursive: true, force: true }));

function vecAvailable() {
  const probe = new Database(":memory:");
  try {
    return loadVectorExtension(probe);
  } finally {
    probe.close();
  }
}

// A migrated database with real vec0 sidecars holding one embedding each.
async function seedVec0Database(name) {
  const dbPath = join(workdir, name);
  const db = new Database(dbPath);
  loadVectorExtension(db);
  await runSqliteMigrations(db, { vectorSupported: true });
  db.prepare(`INSERT INTO memories (id, title, content, type) VALUES ('m1','T','C','fact')`).run();
  const { rowid } = db.prepare(`SELECT rowid FROM memories WHERE id = 'm1'`).get();
  db.prepare(`INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)`)
    .run(BigInt(rowid), Buffer.alloc(1024 * 4));
  db.close();
  return dbPath;
}

// Physical width of every sidecar, read the same way getVectorDims() does.
function sidecarDims(dbPath) {
  const db = new Database(dbPath);
  try {
    return Object.fromEntries(
      db.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec\\_%' ESCAPE '\\'`
      ).all().map(r => [r.name, parseInt(r.sql.match(/FLOAT\[(\d+)\]/)?.[1] ?? "0", 10) || null])
    );
  } finally {
    db.close();
  }
}

function sidecarKinds(dbPath) {
  const db = new Database(dbPath);
  try {
    return Object.fromEntries(
      db.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec\\_%' ESCAPE '\\'`
      ).all().map(r => [r.name, /USING\s+vec0/i.test(r.sql) ? "vec0" : "plain"])
    );
  } finally {
    db.close();
  }
}

describe("sqlite-vec sidecar reconciliation", { skip: vecAvailable() ? false : "sqlite-vec unavailable on this platform" }, () => {
  test("an already-migrated vec0 database becomes readable where the extension cannot load", async () => {
    const dbPath = await seedVec0Database("from-supported.db");
    assert.equal(sidecarKinds(dbPath).vec_memories, "vec0");

    const { rebuilt } = reconcileVecSidecars(dbPath, { vectorSupported: false });
    assert.deepEqual(rebuilt.sort(), ["codegraph", "docgraph", "memories", "self_memories", "wiki"]);

    const kinds = sidecarKinds(dbPath);
    for (const table of VEC_TABLES) assert.equal(kinds[table], "plain", `${table} should be plain now`);
    // vec0's shadow tables must be gone, not left behind as orphans.
    assert.equal(Object.keys(kinds).some(n => n.startsWith("vec_memories_")), false);

    // The whole point: ordinary reads work again without the module.
    const db = new Database(dbPath);
    assert.deepEqual(
      db.prepare(`SELECT m.id FROM memories m LEFT JOIN vec_memories v ON v.rowid = m.rowid`).all(),
      [{ id: "m1" }]
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM vec_memories`).get().c, 0);
    assert.equal(db.pragma("integrity_check")[0].integrity_check, "ok");
    db.close();
  });

  test("a degraded database returning to a supported machine gets its vec0 tables back", async () => {
    const dbPath = await seedVec0Database("round-trip.db");
    reconcileVecSidecars(dbPath, { vectorSupported: false });
    assert.equal(sidecarKinds(dbPath).vec_memories, "plain");

    const { rebuilt } = reconcileVecSidecars(dbPath, { vectorSupported: true });
    assert.deepEqual(rebuilt.sort(), ["codegraph", "docgraph", "memories", "self_memories", "wiki"]);

    const kinds = sidecarKinds(dbPath);
    for (const table of VEC_TABLES) assert.equal(kinds[table], "vec0", `${table} should be vec0 again`);

    // KNN works again, which is what "supported" has to mean.
    const db = new Database(dbPath);
    loadVectorExtension(db);
    db.prepare(`INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)`)
      .run(1n, Buffer.alloc(1024 * 4));
    assert.equal(
      db.prepare(`SELECT rowid FROM vec_memories WHERE embedding MATCH ? AND k = 1`)
        .all(Buffer.alloc(1024 * 4)).length,
      1
    );
    db.close();
  });

  test("a sidecar dropped by an interrupted rebuild is recreated", async () => {
    // Every statement in a rebuild autocommits, so a crash between the DROP and
    // the CREATE leaves a sidecar absent. The migration that declares it is
    // already recorded, so nothing else would ever put it back and every write
    // or join against it would fail with "no such table".
    const dbPath = await seedVec0Database("interrupted-vec0.db");
    let db = new Database(dbPath);
    loadVectorExtension(db);
    db.exec("DROP TABLE vec_wiki");
    db.close();
    assert.equal(sidecarKinds(dbPath).vec_wiki, undefined, "precondition: the sidecar is gone");

    const { rebuilt } = reconcileVecSidecars(dbPath, { vectorSupported: true });
    assert.deepEqual(rebuilt, ["wiki"], "only the interrupted store is rebuilt");
    assert.equal(sidecarKinds(dbPath).vec_wiki, "vec0");

    db = new Database(dbPath);
    loadVectorExtension(db);
    db.prepare(`INSERT INTO vec_wiki (rowid, embedding) VALUES (?, ?)`).run(1n, Buffer.alloc(1024 * 4));
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM vec_wiki`).get().c, 1);
    db.close();
  });

  test("the same recovery works in degraded mode", async () => {
    const dbPath = await seedVec0Database("interrupted-plain.db");
    reconcileVecSidecars(dbPath, { vectorSupported: false });

    let db = new Database(dbPath);
    db.exec("DROP TABLE vec_cg_symbols");
    db.close();

    const { rebuilt } = reconcileVecSidecars(dbPath, { vectorSupported: false });
    assert.deepEqual(rebuilt, ["codegraph"]);
    assert.equal(sidecarKinds(dbPath).vec_cg_symbols, "plain");
  });

  test("a rebuilt sidecar keeps the width its siblings use", async () => {
    const dbPath = await seedVec0Database("width.db");
    let db = new Database(dbPath);
    loadVectorExtension(db);
    // Put every sidecar at a non-default width, then lose one.
    for (const table of VEC_TABLES) {
      db.exec(`DROP TABLE ${table}`);
      db.exec(`CREATE VIRTUAL TABLE ${table} USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[384])`);
    }
    db.exec("DROP TABLE vec_memories");
    db.close();

    reconcileVecSidecars(dbPath, { vectorSupported: false });
    db = new Database(dbPath);
    const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'vec_memories'`).get().sql;
    db.close();
    assert.match(sql, /FLOAT\[384\]/, "should match its siblings, not the 1024 default");
  });

  test("a sidecar whose migration has not run yet is left to the migration runner", async () => {
    const dbPath = await seedVec0Database("not-yet-migrated.db");
    let db = new Database(dbPath);
    loadVectorExtension(db);
    // Roll docgraph back to "never applied": no table, no migration record.
    db.exec("DROP TABLE vec_docgraph_chunks");
    db.prepare(`DELETE FROM schema_migrations WHERE version = '004_docgraph.sql'`).run();
    db.close();

    const { rebuilt } = reconcileVecSidecars(dbPath, { vectorSupported: true });
    assert.deepEqual(rebuilt, [], "nothing is missing — the migration simply has not run");
    assert.equal(sidecarKinds(dbPath).vec_docgraph_chunks, undefined);
  });

  test("a database already in the right shape is left alone", async () => {
    const dbPath = await seedVec0Database("already-right.db");
    const { vectorSupported, rebuilt } = reconcileVecSidecars(dbPath);
    assert.equal(vectorSupported, true);
    assert.deepEqual(rebuilt, [], "no sidecar should be rebuilt on an ordinary boot");
    // The seeded embedding survives, because nothing was touched.
    const db = new Database(dbPath);
    loadVectorExtension(db);
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM vec_memories`).get().c, 1);
    db.close();
  });

  // resizeVectorStorage() replaces the five sidecars one at a time and cannot
  // be made atomic (vec0 commits its shadow-table setup outside any enclosing
  // transaction), so a throw or a kill part-way through leaves the database
  // split across two widths. Every sidecar is still the right *kind*, and
  // getVectorDims() only ever reads vec_memories, so nothing downstream can see
  // the split — reindexing the stores left behind then fails on every row and
  // they never leave `reindexing`.
  test("an interrupted dimension change is finished, not left split across two widths", async () => {
    const dbPath = await seedVec0Database("half-resized.db");

    // Exactly what dying after the first two tables looks like.
    const db = new Database(dbPath);
    loadVectorExtension(db);
    for (const table of ["vec_memories", "vec_wiki"]) {
      db.exec(`DROP TABLE ${table}`);
      db.exec(`CREATE VIRTUAL TABLE ${table} USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[384])`);
    }
    db.close();

    const before = sidecarDims(dbPath);
    assert.equal(before.vec_memories, 384);
    assert.equal(before.vec_cg_symbols, 1024, "the fixture must actually be split");

    const { rebuilt } = reconcileVecSidecars(dbPath, { vectorSupported: true });

    // Only the three left behind needed rebuilding — the two already at the
    // target width keep whatever the interrupted resize had written into them.
    assert.deepEqual(rebuilt.sort(), ["codegraph", "docgraph", "self_memories"]);

    const after = sidecarDims(dbPath);
    // 384, not 1024: vec_memories carries the resize's target and is the width
    // getVectorDims() reports, so the rest have to follow it.
    for (const table of VEC_TABLES) assert.equal(after[table], 384, `${table} should be 384 dims`);
    assert.equal(sidecarKinds(dbPath).vec_cg_symbols, "vec0", "the rebuild must stay vec0");
  });

  test("the same split is repaired on a platform without the extension", async () => {
    const dbPath = await seedVec0Database("half-resized-plain.db");
    reconcileVecSidecars(dbPath, { vectorSupported: false });

    // Half of the plain sidecars re-created at another width, the way an
    // interrupted resize leaves them in degraded mode.
    const db = new Database(dbPath);
    for (const table of ["vec_memories", "vec_wiki"]) {
      db.exec(`DROP TABLE ${table}`);
      db.exec(`CREATE TABLE ${table} (rowid INTEGER PRIMARY KEY, embedding FLOAT[384])`);
    }
    db.close();

    const { rebuilt } = reconcileVecSidecars(dbPath, { vectorSupported: false });
    assert.deepEqual(rebuilt.sort(), ["codegraph", "docgraph", "self_memories"]);

    const after = sidecarDims(dbPath);
    for (const table of VEC_TABLES) assert.equal(after[table], 384, `${table} should be 384 dims`);
    for (const table of VEC_TABLES) assert.equal(sidecarKinds(dbPath)[table], "plain");
  });
});
