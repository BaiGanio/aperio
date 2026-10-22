// tests/unit/db-connect/extraction.test.js
// Tests for the self-provisioning "extraction" connection (#250, WS1).
//
// ZERO real filesystem access — same technique as sample-db.test.js: fs
// (existsSync/mkdirSync) is patched via mock.method, and better-sqlite3's
// Database constructor is replaced by patching require.cache before the
// module under test is dynamically imported.

import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock } from "node:test";
import path from "node:path";

const require = createRequire(import.meta.url);
const fsMod = require("fs");

class MockDatabase {
  constructor(file) { this.file = file; }
  pragma() {}
  close() {}
}

const bsqlitePath = require.resolve("better-sqlite3");
require.cache[bsqlitePath] = { exports: MockDatabase };

const fsCalls = { existsSync: [], mkdirSync: [] };
let existsSyncReturns = false;
let fakeFd = 1;
const realOpenSync = fsMod.openSync;

mock.method(fsMod, "existsSync", (p) => { fsCalls.existsSync.push(p); return existsSyncReturns; });
mock.method(fsMod, "mkdirSync", (p, opts) => { fsCalls.mkdirSync.push({ p, opts }); });
// The atomic create/replace + cross-process-lock machinery managed-sqlite.js
// and lib/db-connect/file-lock.js use for provisioning (P2: interrupted-
// provisioning recovery; P1: cross-process locking) touches real fs beyond
// existsSync/mkdirSync — renameSync (the atomic rename) and the lock file's
// openSync/closeSync/writeSync/statSync. Mocked as harmless no-ops so this
// file's "zero real filesystem access" property still holds; managed-
// sqlite.js's OWN file mechanics (the rename, the lock itself) are exercised
// against a REAL filesystem in
// tests/integration/db-connect/extraction-encryption.test.js instead.
mock.method(fsMod, "renameSync", () => {});
mock.method(fsMod, "unlinkSync", () => {});
mock.method(fsMod, "closeSync", () => {});
mock.method(fsMod, "writeSync", () => {});
mock.method(fsMod, "statSync", () => { throw Object.assign(new Error("ENOENT (mocked)"), { code: "ENOENT" }); });
// openSync only fakes OUR lock files (the one real caller in this module's
// dependency graph, lib/db-connect/file-lock.js, always targets a `*.lock`
// path) and delegates everything else to the real implementation. Node's
// own ESM loader also goes through fs.openSync/readSync internally to read
// module source; globally replacing it — even to a harmless-looking no-op —
// starves concurrent dynamic import() calls (this file's own "simulate two
// processes" tests below) and manifests as an unrelated EAGAIN deep inside
// the loader. Scoping the fake to only the path shape we actually own avoids
// that entirely.
mock.method(fsMod, "openSync", (p, flags) => (String(p).endsWith(".lock") ? fakeFd++ : realOpenSync(p, flags)));

let extractionMod;

before(async () => {
  extractionMod = await import("../../../lib/db-connect/extraction.js");
});

beforeEach(() => {
  fsCalls.existsSync = [];
  fsCalls.mkdirSync = [];
  existsSyncReturns = false;
});

after(() => {
  mock.reset();
  delete require.cache[bsqlitePath];
});

const SETTINGS_KEY = "db.connections";

function makeStore(initialConns = []) {
  const data = { [SETTINGS_KEY]: initialConns };
  return {
    async getSetting(k) { return data[k] ?? null; },
    async setSetting(k, v) { if (k === SETTINGS_KEY) data[k] = v; },
  };
}

// Fake live-handle stores, exactly the shape lib/db-connect/drivers/aperio.js
// already duck-types on (store.db for sqlite, store.pool for postgres).
const sqliteStore = (name, conns = []) => ({ ...makeStore(conns), db: { name } });
const postgresStore = (connectionString, conns = []) => ({ ...makeStore(conns), pool: { options: { connectionString } } });

describe("extractionDbPath", () => {
  test("resolves under the app's persisted var/extraction/ directory, independent of SQLITE_PATH", () => {
    const prev = process.env.SQLITE_PATH;
    // The postgres-backend production deployment leaves SQLITE_PATH unset —
    // the path must not depend on it (P1: it used to, and lost data on
    // container recreation because only var/ is a persisted volume there).
    delete process.env.SQLITE_PATH;
    try {
      const p = extractionMod.extractionDbPath(sqliteStore("/data/profile-a/aperio.db"));
      assert.ok(p.includes(`${path.sep}var${path.sep}extraction${path.sep}`));
      assert.ok(p.endsWith(".db"));
    } finally {
      if (prev !== undefined) process.env.SQLITE_PATH = prev;
    }
  });

  test("is stable for the same store identity and does not change when SQLITE_PATH changes", () => {
    const store = sqliteStore("/data/profile-a/aperio.db");
    const before_ = extractionMod.extractionDbPath(store);
    process.env.SQLITE_PATH = "/somewhere/else/aperio.db";
    try {
      assert.equal(extractionMod.extractionDbPath(store), before_);
    } finally {
      delete process.env.SQLITE_PATH;
    }
  });

  test("P1: two sqlite profiles with different SQLITE_PATH never resolve to the same file", () => {
    const a = extractionMod.extractionDbPath(sqliteStore("/data/profile-a/aperio.db"));
    const b = extractionMod.extractionDbPath(sqliteStore("/data/profile-b/aperio.db"));
    assert.notEqual(a, b);
  });

  test("P1: two postgres profiles with different DATABASE_URL never resolve to the same file", () => {
    const a = extractionMod.extractionDbPath(postgresStore("postgresql://u:p@host/alice_db"));
    const b = extractionMod.extractionDbPath(postgresStore("postgresql://u:p@host/bob_db"));
    assert.notEqual(a, b);
  });

  test("the same profile resolves to the same file across separate calls (stable, not random)", () => {
    const store = postgresStore("postgresql://u:p@host/aperio");
    assert.equal(extractionMod.extractionDbPath(store), extractionMod.extractionDbPath(store));
  });

  test("never embeds a raw connection string (which may carry a password) in the path", () => {
    const p = extractionMod.extractionDbPath(postgresStore("postgresql://alice:hunter2@host/aperio"));
    assert.ok(!p.includes("hunter2"));
    assert.ok(!p.includes("alice"));
  });

  // P1 review finding: hashing the FULL connection string made the identity
  // (and thus the managed row's stored `file`) change on an ordinary,
  // expected credential edit — after which isManagedExtractionFile would
  // stop matching and every extraction operation would report a bogus
  // reserved-name collision, with the old database inaccessible through
  // Aperio until someone manually deleted the row.
  test("P1: rotating only the password (same host/port/database) resolves to the SAME file", () => {
    const before_ = extractionMod.extractionDbPath(postgresStore("postgresql://alice:oldpass@db.example.com:5432/aperio"));
    const after = extractionMod.extractionDbPath(postgresStore("postgresql://alice:newpass@db.example.com:5432/aperio"));
    assert.equal(before_, after);
  });

  // P1 review finding (corrects the previous round's assumption above): the
  // username is a ROLE, not merely a credential like the password — two
  // roles on the same host/port/database can have different default
  // search_path settings and see entirely different tables. Collapsing them
  // onto one identity would route their extraction writes into the SAME
  // local file, exposing or overwriting each other's data.
  test("P1: changing only the username (role) resolves to a DIFFERENT file — role is part of the logical namespace, not a credential", () => {
    const before_ = extractionMod.extractionDbPath(postgresStore("postgresql://alice:pw@db.example.com:5432/aperio"));
    const after = extractionMod.extractionDbPath(postgresStore("postgresql://bob:pw@db.example.com:5432/aperio"));
    assert.notEqual(before_, after);
  });

  // P1 review finding: two profiles can share host/port/database/role and
  // still see different tables via an explicit search_path — e.g. one
  // Postgres user configured with `options=-c search_path=tenant_a` and
  // another with `tenant_b`. That must resolve to different files too.
  test("P1: two profiles sharing host/port/database/role but different search_path resolve to DIFFERENT files", () => {
    const a = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20search_path%3Dtenant_a"));
    const b = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20search_path%3Dtenant_b"));
    assert.notEqual(a, b);
  });

  test("P1: an explicit search_path query param (same host/port/database/role) resolves to a DIFFERENT file", () => {
    const a = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?search_path=tenant_a"));
    const b = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?search_path=tenant_b"));
    assert.notEqual(a, b);
  });

  // P1 review finding: for a valid URL such as postgresql://host/aperio,
  // node-postgres resolves the role from PGUSER / the OS user — the URL's
  // username field stays empty. Resolving the same way here means two
  // processes sharing one checkout and URL but different implicit roles can
  // no longer collapse onto the same extraction file.
  test("P1: a URL with no username resolves the role from PGUSER — different implicit roles get DIFFERENT files", () => {
    const url = "postgresql://db.example.com:5432/aperio";
    const prev = process.env.PGUSER;
    try {
      process.env.PGUSER = "alice";
      const a = extractionMod.extractionDbPath(postgresStore(url));
      process.env.PGUSER = "bob";
      const b = extractionMod.extractionDbPath(postgresStore(url));
      assert.notEqual(a, b);
    } finally {
      if (prev === undefined) delete process.env.PGUSER; else process.env.PGUSER = prev;
    }
  });

  // The identity must reflect the role the pool actually connects as, not the
  // URL's spelling: an explicit `alice` and an implicit role resolved to the
  // same user are the SAME Postgres role and belong on the SAME file.
  test("P1: an explicit username and the same role resolved implicitly resolve to the SAME file", () => {
    const prev = process.env.PGUSER;
    try {
      process.env.PGUSER = "alice";
      const explicit = extractionMod.extractionDbPath(postgresStore("postgresql://alice:pw@db.example.com:5432/aperio"));
      const implicit = extractionMod.extractionDbPath(postgresStore("postgresql://db.example.com:5432/aperio"));
      assert.equal(explicit, implicit);
    } finally {
      if (prev === undefined) delete process.env.PGUSER; else process.env.PGUSER = prev;
    }
  });

  // P2 review finding: the FULL `options` value previously joined the
  // identity, so editing or merely reordering behavior-only settings
  // (statement_timeout, application_name, ...) changed the extraction path and
  // made an already-saved row fail isManagedExtractionFile — inaccessible
  // despite connecting to the same tables. Only namespace-affecting settings
  // (search_path) may hash in, canonicalized.
  test("P2: behavior-only options (statement_timeout, application_name) do NOT change the extraction file", () => {
    const plain = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio"));
    const withTimeout = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20statement_timeout%3D1000"));
    const withAppName = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20application_name%3Dx%20-c%20statement_timeout%3D5000"));
    assert.equal(plain, withTimeout);
    assert.equal(plain, withAppName);
  });

  test("P2: reordering options (mixing behavior-only and namespace ones) never changes the extraction file", () => {
    const a = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20statement_timeout%3D100%20-c%20search_path%3Dtenant_a"));
    const b = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20search_path%3Dtenant_a%20-c%20statement_timeout%3D500"));
    assert.equal(a, b);
  });

  test("P2: a repeated namespace option keeps only the LAST (effective) assignment", () => {
    const a = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20search_path%3Dtenant_a%20-c%20search_path%3Dtenant_b"));
    const b = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20search_path%3Dtenant_b"));
    assert.equal(a, b);
  });

  // Quoted option values may contain spaces ("tenant a" vs "tenant b"); a
  // naive whitespace tokenizer would truncate both at the space and collapse
  // two genuinely different namespaces onto one file.
  test("P2: quoted search_path values containing spaces stay distinct (never truncated to a shared prefix)", () => {
    const a = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20search_path%3D%22tenant%20a%22"));
    const b = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20search_path%3D%22tenant%20b%22"));
    assert.notEqual(a, b);
  });

  // P1 review finding: libpq also accepts the ATTACHED short-option form
  // `-csearch_path=tenant_a`. Skipping every single-dash token other than an
  // exact `-c` discarded the assignment, collapsing `-csearch_path=tenant_a`
  // and `-csearch_path=tenant_b` onto one identity — different namespaces
  // sharing one extraction file.
  test("P1: attached -c namespace assignments (-csearch_path=...) resolve to DIFFERENT files", () => {
    const a = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-csearch_path%3Dtenant_a"));
    const b = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-csearch_path%3Dtenant_b"));
    assert.notEqual(a, b);
  });

  test("P1: attached and spaced -c spellings of the SAME namespace resolve to the SAME file", () => {
    const attached = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-csearch_path%3Dtenant_a"));
    const spaced = extractionMod.extractionDbPath(postgresStore("postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20search_path%3Dtenant_a"));
    assert.equal(attached, spaced);
  });

  test("changing the host still resolves to a DIFFERENT file (identity isn't just the database name)", () => {
    const a = extractionMod.extractionDbPath(postgresStore("postgresql://u:p@host-a.example.com:5432/aperio"));
    const b = extractionMod.extractionDbPath(postgresStore("postgresql://u:p@host-b.example.com:5432/aperio"));
    assert.notEqual(a, b);
  });

  test("an unparseable connection string still resolves to something stable rather than throwing", () => {
    const store = postgresStore("not a real connection string");
    assert.doesNotThrow(() => extractionMod.extractionDbPath(store));
    assert.equal(extractionMod.extractionDbPath(store), extractionMod.extractionDbPath(store));
  });

  // P1 review finding: when APERIO_DB_ENCRYPT is on, db/sqlite/store.js opens
  // the live handle at a decrypted TEMP path (prepareDatabase's tmpdir()
  // scratch file), so store.db.name differs from the real SQLITE_PATH used
  // when encryption is off. Deriving identity from db.name alone made
  // toggling the flag change extractionDbPath for an already-provisioned
  // profile, permanently reserved-name-colliding with its own prior row.
  // store._encryptSourcePath (set unconditionally by SqliteStore.init(),
  // regardless of encryption mode) must be preferred instead, since it's the
  // one value that stays the real SQLITE_PATH in both modes.
  test("P1: identity is stable across an encryption toggle (uses _encryptSourcePath, not the live db.name)", () => {
    const unencrypted = { ...makeStore(), db: { name: "/data/profile-a/aperio.db" }, _encryptSourcePath: "/data/profile-a/aperio.db" };
    const encrypted = { ...makeStore(), db: { name: "/tmp/aperio-db-abc123.sqlite" }, _encryptSourcePath: "/data/profile-a/aperio.db" };
    assert.equal(extractionMod.extractionDbPath(unencrypted), extractionMod.extractionDbPath(encrypted));
  });

  test("falls back to db.name when _encryptSourcePath is absent (store shapes that don't set it)", () => {
    const store = sqliteStore("/data/profile-a/aperio.db");
    assert.equal(store._encryptSourcePath, undefined);
    assert.equal(extractionMod.extractionDbPath(store), extractionMod.extractionDbPath({ ...store, _encryptSourcePath: "/data/profile-a/aperio.db" }));
  });
});


describe("legacy identity adoption (P1)", () => {
  const legacyRow = (file) => ({ name: "extraction", engine: "sqlite", file, readOnly: false, provisioned: true });

  // P1 review finding: upgrading a Postgres profile whose URL carries a
  // username or options changed the extraction hash away from the previous
  // host/port/database identity, so a saved row still pointing at the old
  // file stopped matching isManagedExtractionFile and
  // provisionExtractionConnection() reported a reserved-name collision — orphaning every
  // pre-existing extracted document. Rows hashed from any earlier identity
  // must be adopted (recognized as this module's own file for this profile),
  // not rejected.
  test("P1: a row provisioned under the pre-expansion host/port/database identity is adopted, not rejected", async () => {
    const url = "postgresql://alice:pw@db.example.com:5432/aperio";
    const store = postgresStore(url);
    const legacyPaths = extractionMod.legacyExtractionDbPaths(store);
    assert.notEqual(legacyPaths[0], extractionMod.extractionDbPath(store), "the legacy identity genuinely differs for a URL with a username");

    const withLegacyRow = postgresStore(url, [legacyRow(legacyPaths[0])]);
    assert.equal(extractionMod.isManagedExtractionFile(legacyRow(legacyPaths[0]), store), true);

    // Adoption is in place: the same row comes back unchanged — no collision
    // error, no new file created, no rename.
    const connection = await extractionMod.provisionExtractionConnection(withLegacyRow);
    assert.equal(connection.file, legacyPaths[0]);
    assert.equal(fsCalls.mkdirSync.length, 0, "adoption must not create files");
  });

  test("P1: a row provisioned under the intermediate literal-role/raw-options identity is adopted, then migrated to the stable current path", async () => {
    // c42ae99 hashed the FULL raw options; the P2 canonicalization now filters
    // behavior-only ones away, so the two identities differ for this URL and
    // the intermediate row must still be recognized.
    const url = "postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20statement_timeout%3D1000";
    const store = postgresStore(url);
    const legacyPaths = extractionMod.legacyExtractionDbPaths(store);
    const current = extractionMod.extractionDbPath(store);
    assert.ok(legacyPaths.length >= 2, "v0 and v1 legacy identities are both recognized");
    assert.ok(legacyPaths.every((p) => p !== current), "each legacy identity differs from the current one for this URL");

    // v0 row: adopted in place — same file back, nothing created.
    const v0Store = postgresStore(url, [legacyRow(legacyPaths[0])]);
    assert.equal(extractionMod.isManagedExtractionFile(legacyRow(legacyPaths[0]), store), true);
    const v0 = await extractionMod.provisionExtractionConnection(v0Store);
    assert.equal(v0.file, legacyPaths[0]);

    // v1 row: its saved hash depends on the raw options, so it is MIGRATED to
    // the stable current path at provisioning (P1 review finding) — the stored
    // row now points at the current path, not the v1 path.
    const v1Store = postgresStore(url, [legacyRow(legacyPaths[1])]);
    assert.equal(extractionMod.isManagedExtractionFile(legacyRow(legacyPaths[1]), store), true);
    const v1 = await extractionMod.provisionExtractionConnection(v1Store);
    assert.equal(v1.file, current, "a v1-adopted row is migrated to the current identity path");
    const stored = await v1Store.getSetting(SETTINGS_KEY);
    assert.equal(stored[0].file, current, "the migration is persisted in the settings row");
    assert.equal(fsCalls.mkdirSync.length, 0, "migration must not create files");
  });

  // P1 review finding: a v1-adopted row kept at the old raw-options hash would
  // be orphaned by any later behavior-only option edit, because the recomputed
  // v1 path changes while the canonical current path stays stable. After the
  // migration, removing statement_timeout must leave the row fully managed.
  test("P1: after v1 migration, editing a behavior-only option no longer orphans the adopted row", async () => {
    const withTimeout = "postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20statement_timeout%3D1000";
    const withoutTimeout = "postgresql://svc:pw@db.example.com:5432/aperio";
    const migratedRow = legacyRow(extractionMod.extractionDbPath(postgresStore(withTimeout)));

    // Same stored row, but the user has since dropped statement_timeout: the
    // canonical current path is unchanged, so the migrated row still matches.
    const editedStore = postgresStore(withoutTimeout, [migratedRow]);
    assert.equal(extractionMod.isManagedExtractionFile(migratedRow, editedStore), true);
    const connection = await extractionMod.provisionExtractionConnection(editedStore);
    assert.equal(connection.file, migratedRow.file);
  });

  // P1 review finding: the migration must happen at the FIRST touch of the
  // adopted row, not only at provisioning — a profile that only READS the
  // extraction database never provisions, and a v1 row left at the raw-
  // options hash would then be orphaned by the first behavior-only option
  // edit. Every connection resolution (getDriver → adoptManagedExtractionRow)
  // migrates the row before any edit can orphan it, so reads, schema
  // introspection and writes all get the same guarantee.
  test("P1: the read path (adoptManagedExtractionRow) migrates a v1-adopted row at first touch, so a later options edit cannot orphan it", async () => {
    const withTimeout = "postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20statement_timeout%3D1000";
    const withoutTimeout = "postgresql://svc:pw@db.example.com:5432/aperio";
    const v1Path = extractionMod.legacyExtractionDbPaths(postgresStore(withTimeout))[1];
    const current = extractionMod.extractionDbPath(postgresStore(withTimeout));
    assert.notEqual(v1Path, current, "the v1 path genuinely differs from the canonical current path for this URL");

    // First touch (e.g. a db_query resolving the extraction connection): the
    // v1 row is migrated to the stable current path and persisted.
    const firstStore = postgresStore(withTimeout, [legacyRow(v1Path)]);
    const adopted = await extractionMod.adoptManagedExtractionRow(firstStore, legacyRow(v1Path));
    assert.equal(adopted.file, current, "a v1-adopted row is migrated at first touch");
    const stored = (await firstStore.getSetting(SETTINGS_KEY))[0];
    assert.equal(stored.file, current, "the read-path migration is persisted in the settings row");

    // The user then drops statement_timeout: the canonical current path is
    // unchanged, so the migrated row is still this profile's managed row and
    // provisioning reuses it instead of throwing a reserved-name collision.
    const editedStore = postgresStore(withoutTimeout, [stored]);
    assert.equal(extractionMod.isManagedExtractionFile(stored, editedStore), true);
    const connection = await extractionMod.provisionExtractionConnection(editedStore);
    assert.equal(connection.file, current);
  });

  // P1: adoptManagedExtractionRow is the resolution-path gate — it must never
  // touch rows that are not this profile's own, or the forged-`provisioned`
  // TOCTOU protection would silently accept attacker-chosen paths.
  test("P1: adoptManagedExtractionRow leaves forged and other-profile rows untouched", async () => {
    const store = postgresStore("postgresql://alice:pw@db.example.com:5432/aperio");
    const forged = { name: "extraction", engine: "sqlite", file: "/attacker/chosen/path.db", readOnly: false, provisioned: true };
    assert.equal(await extractionMod.adoptManagedExtractionRow(store, forged), forged);

    const otherProfileRow = legacyRow(
      extractionMod.legacyExtractionDbPaths(postgresStore("postgresql://alice:pw@other.example.com:5432/aperio"))[0],
    );
    assert.equal(await extractionMod.adoptManagedExtractionRow(store, otherProfileRow), otherProfileRow);
    assert.deepEqual(await store.getSetting(SETTINGS_KEY), [], "nothing was persisted");
  });

  // The one remaining corner, closed by the first-touch migration: a v1 row
  // whose connection string is edited BEFORE the new build has EVER resolved
  // this profile's extraction connection (no read, write, or provisioning
  // since the upgrade) has no derivable identity left — the old raw options
  // are gone and the saved hash cannot be inverted — so it stays rejected
  // rather than silently adopting an arbitrary var/extraction path (which
  // would reopen the forged-`provisioned` hole).
  test("P1: a v1 row edited before the new build's first touch stays rejected (identity not derivable — documented corner)", async () => {
    const withTimeout = "postgresql://svc:pw@db.example.com:5432/aperio?options=-c%20statement_timeout%3D1000";
    const withoutTimeout = "postgresql://svc:pw@db.example.com:5432/aperio";
    const v1Path = extractionMod.legacyExtractionDbPaths(postgresStore(withTimeout))[1];

    const editedStore = postgresStore(withoutTimeout, [legacyRow(v1Path)]);
    assert.equal(extractionMod.isManagedExtractionFile(legacyRow(v1Path), editedStore), false);
    await assert.rejects(
      () => extractionMod.provisionExtractionConnection(editedStore),
      /reserved/i,
    );
    // The message must diagnose THIS as Aperio's own stranded row (not a
    // generic "rename it" collision) and point at the real file so the data
    // can be recovered by hand.
    try {
      await extractionMod.provisionExtractionConnection(editedStore);
      assert.fail("expected provisionExtractionConnection to reject");
    } catch (err) {
      assert.match(err.message, /upgrade/i);
      assert.ok(err.message.includes(v1Path), "message names the actual stranded file path");
    }
  });

  test("P1: adoption is per-profile — a legacy path from a DIFFERENT host is not adopted", () => {
    const store = postgresStore("postgresql://alice:pw@db.example.com:5432/aperio");
    const otherHostLegacy = extractionMod.legacyExtractionDbPaths(postgresStore("postgresql://alice:pw@other.example.com:5432/aperio"))[0];
    assert.equal(extractionMod.isManagedExtractionFile(legacyRow(otherHostLegacy), store), false);
  });

  test("P1: a SQLite store's identity never changed — its legacy path is the current path (no adoption branch taken)", () => {
    const store = sqliteStore("/data/profile-a/aperio.db");
    assert.deepEqual(extractionMod.legacyExtractionDbPaths(store), [extractionMod.extractionDbPath(store)]);
  });
});

describe("findExtractionConnection", () => {
  test("null on a clean profile", async () => {
    assert.equal(await extractionMod.findExtractionConnection(makeStore()), null);
  });

  test("finds a previously-provisioned managed row case-insensitively", async () => {
    const store = makeStore([{ name: "Extraction", engine: "sqlite", file: "/x/extraction.db", readOnly: false, provisioned: true }]);
    const found = await extractionMod.findExtractionConnection(store);
    assert.equal(found.name, "Extraction");
  });

  test("ignores a same-named connection that is not the managed one (P2 collision)", async () => {
    // No `provisioned` marker: this is some other, unrelated connection that
    // happens to share the reserved name (e.g. seeded via DB_CONNECTIONS, or
    // created before this feature existed) — it must never be mistaken for
    // the self-provisioned destination.
    const store = makeStore([{ name: "extraction", engine: "postgres", host: "internal-db", readOnly: false }]);
    assert.equal(await extractionMod.findExtractionConnection(store), null);
  });
});

describe("provisionExtractionConnection", () => {
  test("registers a writable sqlite connection named 'extraction' on a clean profile", async () => {
    const store = sqliteStore("/data/profile-a/aperio.db");
    const connection = await extractionMod.provisionExtractionConnection(store);

    assert.equal(connection.name, extractionMod.EXTRACTION_CONNECTION);
    assert.equal(connection.engine, "sqlite");
    assert.equal(connection.readOnly, false);
    assert.equal(connection.provisioned, true);
    assert.ok(connection.file.endsWith(".db"));

    const stored = await store.getSetting(SETTINGS_KEY);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, "extraction");
    assert.equal(stored[0].readOnly, false);
  });

  test("P1: provisioning against two different profiles produces two different files", async () => {
    const a = await extractionMod.provisionExtractionConnection(sqliteStore("/data/profile-a/aperio.db"));
    const b = await extractionMod.provisionExtractionConnection(sqliteStore("/data/profile-b/aperio.db"));
    assert.notEqual(a.file, b.file);
  });

  test("creates the parent directory and the sqlite file when absent", async () => {
    existsSyncReturns = false;
    await extractionMod.provisionExtractionConnection(sqliteStore("/data/profile-a/aperio.db"));
    assert.ok(fsCalls.mkdirSync.length >= 1, "mkdirSync called");
    assert.ok(fsCalls.mkdirSync[0].opts.recursive);
  });

  test("does not recreate the file when it already exists on disk", async () => {
    existsSyncReturns = true;
    // A fresh store with no registered connection but a pre-existing file on
    // disk (e.g. left over from a prior provisioning) must not error and
    // must still register the connection.
    const store = sqliteStore("/data/profile-a/aperio.db");
    const connection = await extractionMod.provisionExtractionConnection(store);
    assert.equal(connection.name, "extraction");
  });

  test("is idempotent: a second call reuses the existing connection and touches nothing", async () => {
    const store = sqliteStore("/data/profile-a/aperio.db");
    const first = await extractionMod.provisionExtractionConnection(store);
    fsCalls.mkdirSync = [];
    fsCalls.existsSync = [];

    const second = await extractionMod.provisionExtractionConnection(store);
    assert.deepEqual(second, first);
    assert.equal(fsCalls.mkdirSync.length, 0, "no filesystem work on the already-provisioned path");

    const stored = await store.getSetting(SETTINGS_KEY);
    assert.equal(stored.length, 1, "still exactly one extraction connection, not duplicated");
  });

  test("preserves other configured connections", async () => {
    const store = sqliteStore("/data/profile-a/aperio.db", [{ name: "my-pg", engine: "postgres", host: "localhost" }]);
    await extractionMod.provisionExtractionConnection(store);
    const names = (await store.getSetting(SETTINGS_KEY)).map((c) => c.name);
    assert.ok(names.includes("my-pg"));
    assert.ok(names.includes("extraction"));
  });

  test("rejects rather than reuses or duplicates when the name collides with an unmanaged connection (P2)", async () => {
    const store = sqliteStore("/data/profile-a/aperio.db", [{ name: "extraction", engine: "postgres", host: "internal-db", readOnly: false }]);
    await assert.rejects(
      () => extractionMod.provisionExtractionConnection(store),
      /reserved/i,
    );
    // Nothing was created or appended — the original unmanaged row is untouched.
    const stored = await store.getSetting(SETTINGS_KEY);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].engine, "postgres");
    assert.equal(fsCalls.mkdirSync.length, 0, "no filesystem work when the name collides");
  });

  test("rejects on a read-only unmanaged collision too, without implying self-provisioning is blocked by that flag", async () => {
    const store = sqliteStore("/data/profile-a/aperio.db", [{ name: "Extraction", engine: "sqlite", file: "/somewhere/user.db", readOnly: true }]);
    await assert.rejects(
      () => extractionMod.provisionExtractionConnection(store),
      /reserved/i,
    );
  });

  // P2 review finding (TOCTOU): a settings write can land between an
  // already-confirmed write's revalidation and this call, forging a
  // `provisioned: true` row under the reserved name with an attacker-chosen
  // file. The `provisioned` marker alone must never be enough to reuse it —
  // isManagedExtractionFile's path check has to agree too, or this returns
  // the forged row as "the managed connection" and the caller's already-
  // confirmed SQL gets executed against the attacker's file instead.
  test("rejects rather than reuses a forged `provisioned: true` row whose file doesn't match this profile's real managed path (P2 TOCTOU)", async () => {
    const store = sqliteStore("/data/profile-a/aperio.db", [
      { name: "extraction", engine: "sqlite", file: "/attacker/chosen/path.db", readOnly: false, provisioned: true },
    ]);
    await assert.rejects(
      () => extractionMod.provisionExtractionConnection(store),
      /reserved/i,
    );
    // The forged row is untouched — not silently accepted, not replaced.
    const stored = await store.getSetting(SETTINGS_KEY);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].file, "/attacker/chosen/path.db");
    assert.equal(fsCalls.mkdirSync.length, 0, "no filesystem work when the row is forged");
  });
});

// A SQLITE_PATH=":memory:" store's store.db.name is the literal string
// ":memory:" for every such store — that alone would collapse every separate
// in-memory profile onto the same persisted extraction file (P2). Each
// process is meant to get its own random, session-scoped identity instead.
// Cache-busted dynamic imports simulate "a different process" here: each one
// re-runs the module's top-level code, regenerating the random tag exactly
// as a fresh Node process would.
describe("in-memory profile isolation (P2)", () => {
  const memStore = () => sqliteStore(":memory:");
  const cacheBustImport = () => import(`../../../lib/db-connect/extraction.js?t=${Date.now()}_${Math.random().toString(36).slice(2)}`);

  test("two separate profile processes never resolve an in-memory store to the same extraction file", async () => {
    const [modA, modB] = await Promise.all([cacheBustImport(), cacheBustImport()]);
    const pathA = modA.extractionDbPath(memStore());
    const pathB = modB.extractionDbPath(memStore());
    assert.notEqual(pathA, pathB, "two separate profile processes must not share an in-memory-profile extraction file");
  });

  test("within one process, repeated in-memory stores stay consistent so writes and reads still round-trip", () => {
    const a = extractionMod.extractionDbPath(memStore());
    const b = extractionMod.extractionDbPath(memStore());
    assert.equal(a, b, "the same running profile must resolve to one stable file, or appended data could never be read back");
  });

  test("provisioning against two in-memory profiles (simulated processes) produces two different files", async () => {
    const [modA, modB] = await Promise.all([cacheBustImport(), cacheBustImport()]);
    const a = await modA.provisionExtractionConnection(memStore());
    const b = await modB.provisionExtractionConnection(memStore());
    assert.notEqual(a.file, b.file);
  });

  test("does not merely hash the literal string ':memory:' — a real path containing that substring resolves differently", () => {
    const literalSubstring = extractionMod.extractionDbPath(sqliteStore("/some/real/path/to/:memory:/aperio.db"));
    const memory = extractionMod.extractionDbPath(memStore());
    assert.notEqual(literalSubstring, memory);
  });
});
