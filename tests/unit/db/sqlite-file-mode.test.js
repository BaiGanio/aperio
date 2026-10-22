// tests/unit/db/sqlite-file-mode.test.js
//
// #466 / SECRET-02 — the SQLite database holds provider API keys (the settings
// overlay landed in #252) next to every memory, but better-sqlite3 creates the
// file itself, so the process umask decided its mode and shipped installs at
// 0644 — world-readable on any shared machine. Two guarantees are locked in
// here: a freshly created database is 0600, and an existing 0644 database is
// repaired the next time it is opened.
//
// POSIX-only assertions. Windows has no POSIX mode bits (chmod is a no-op that
// can throw), so the hardening is best-effort there by design and the mode
// checks are skipped rather than asserted.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const POSIX = process.platform !== "win32";

// Env must be set before importing the store: db/sqlite/store.js freezes
// SQLITE_PATH and EMBEDDING_DIMS into module-level constants at import time.
const workdir = mkdtempSync(join(tmpdir(), "aperio-filemode-"));
const dbPath = join(workdir, "nested", "aperio.db");

const oldPath = process.env.SQLITE_PATH;
const oldDims = process.env.EMBEDDING_DIMS;
const oldEncrypt = process.env.APERIO_DB_ENCRYPT;
process.env.SQLITE_PATH = dbPath;
process.env.EMBEDDING_DIMS = "4";
process.env.APERIO_DB_ENCRYPT = "0";

const { SqliteStore, _hardenDbFiles } = await import("../../../db/sqlite.js");
const { restrictFileMode, precreateSecureFile } = await import("../../../lib/helpers/secureFile.js");
const { loadVectorExtension } = await import("../../../db/sqlite/vecSupport.js");

// Mode bits only, stripping the file-type bits statSync reports.
const modeOf = (p) => statSync(p).mode & 0o777;

after(() => {
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  if (oldDims) process.env.EMBEDDING_DIMS = oldDims; else delete process.env.EMBEDDING_DIMS;
  if (oldEncrypt) process.env.APERIO_DB_ENCRYPT = oldEncrypt; else delete process.env.APERIO_DB_ENCRYPT;
  rmSync(workdir, { recursive: true, force: true });
});

describe("restrictFileMode", () => {
  test("tightens a world-readable file to 0600", { skip: !POSIX }, () => {
    const f = join(workdir, "loose.txt");
    writeFileSync(f, "secret");
    chmodSync(f, 0o644);
    assert.equal(restrictFileMode(f), true);
    assert.equal(modeOf(f), 0o600);
  });

  test("returns false instead of throwing on a missing file", () => {
    assert.equal(restrictFileMode(join(workdir, "does-not-exist")), false);
  });
});

describe("precreateSecureFile", () => {
  // better-sqlite3 takes no `mode`, so without pre-creation the database exists
  // at 0644 for a moment and a local user can grab a descriptor that no later
  // chmod can revoke. The mode must come from us, not from the umask.
  test("creates a new file 0600 even under a permissive umask", { skip: !POSIX }, () => {
    const f = join(workdir, "precreated.db");
    const oldUmask = process.umask(0o000);
    try {
      assert.equal(precreateSecureFile(f), true);
      assert.equal(modeOf(f), 0o600);
    } finally {
      process.umask(oldUmask);
    }
  });

  test("leaves an existing file's contents and mode alone", { skip: !POSIX }, () => {
    const f = join(workdir, "already-there.db");
    writeFileSync(f, "payload");
    chmodSync(f, 0o644);
    assert.equal(precreateSecureFile(f), true);
    assert.equal(modeOf(f), 0o644, "pre-create must not chmod; restrictFileMode does that");
    assert.equal(readFileSync(f, "utf8"), "payload", "must not truncate");
  });
});

describe("_hardenDbFiles", () => {
  // With encryption on, the database we open is the decrypted temp copy, so the
  // encrypted path is a second root: an unclean WAL-mode exit on a pre-#466
  // install can have left *plaintext* -wal/-shm next to it that nothing else
  // ever revisits.
  test("tightens every sidecar of every root it is given", { skip: !POSIX }, () => {
    const rootA = join(workdir, "rootA.db");
    const rootB = join(workdir, "rootB.db");
    const files = [rootA, `${rootA}-wal`, `${rootA}-shm`, `${rootB}-wal`, `${rootB}-journal`];
    for (const f of files) {
      writeFileSync(f, "rows");
      chmodSync(f, 0o644);
    }

    _hardenDbFiles(rootA, rootB);

    for (const f of files) assert.equal(modeOf(f), 0o600, `${f} should be 0600`);
  });

  test("ignores absent sidecars and duplicate roots", () => {
    const root = join(workdir, "rootC.db");
    writeFileSync(root, "rows");
    assert.doesNotThrow(() => _hardenDbFiles(root, root, null, undefined));
  });
});

describe("SqliteStore file permissions", () => {
  let store;

  before(async () => {
    store = await SqliteStore.init();
  });

  after(async () => {
    await store?.close?.();
  });

  test("a freshly created database file is 0600", { skip: !POSIX }, () => {
    assert.equal(modeOf(dbPath), 0o600);
  });

  test("WAL and SHM sidecars carry the same rows, so they are 0600 too", { skip: !POSIX }, () => {
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      if (!existsSync(sidecar)) continue; // created lazily; nothing to assert
      assert.equal(modeOf(sidecar), 0o600, `${sidecar} should be 0600`);
    }
  });

  test("a directory created for the database is not world-readable", { skip: !POSIX }, () => {
    // mkdirSync's mode is subject to umask; assert the group/other bits are
    // clear rather than an exact 0700, which a stricter umask would tighten.
    assert.equal(modeOf(join(workdir, "nested")) & 0o077, 0);
  });

  test("re-opening an existing 0644 database repairs it to 0600", { skip: !POSIX }, async () => {
    await store.close?.();
    chmodSync(dbPath, 0o644);            // simulate a pre-#466 install
    assert.equal(modeOf(dbPath), 0o644);

    store = await SqliteStore.init();
    assert.equal(modeOf(dbPath), 0o600);
  });

  // The vec-sidecar reconciliation runs on its own connection *before* the
  // store's handle is opened, so it is the earliest thing that can touch — and
  // write to — a legacy 0644 database. Hardening therefore has to happen before
  // it, and again if it throws.
  test("a pre-flight reconciliation that dies still leaves the file 0600", { skip: !POSIX }, async () => {
    await store.close?.();
    store = null;

    const raw = new Database(dbPath);
    // The sidecar is a vec0 virtual table wherever the extension exists, and
    // dropping one needs its module loaded.
    loadVectorExtension(raw);
    // 001_core.sql stays recorded while vec_memories disappears, so the
    // pre-flight reads it as an interrupted rebuild and tries to recreate it —
    // onto a name a view now occupies, which throws before init() opens
    // anything of its own.
    raw.exec("DROP TABLE IF EXISTS vec_memories");
    raw.exec("CREATE VIEW vec_memories AS SELECT 1 AS rowid, NULL AS embedding");
    raw.close();

    chmodSync(dbPath, 0o644);            // a legacy install, mid-repair
    assert.equal(modeOf(dbPath), 0o644);

    await assert.rejects(() => SqliteStore.init());
    assert.equal(modeOf(dbPath), 0o600, "the pre-flight must not be reached before hardening");

    // Undo the sabotage. The sidecar is genuinely missing now, which is the
    // interrupted-rebuild case the reconciliation recovers — so this also shows
    // the next boot repairing itself.
    const repair = new Database(dbPath);
    repair.exec("DROP VIEW IF EXISTS vec_memories");
    repair.close();
    store = await SqliteStore.init();
    assert.ok(store.db.prepare(`SELECT 1 FROM vec_memories`), "the sidecar should be back");
  });

  // Must run last: it leaves the database deliberately unopenable.
  test("a boot that dies after opening still leaves the file 0600", { skip: !POSIX }, async () => {
    await store.close?.();
    store = null;

    // Poison the migration bookkeeping so runSqliteMigrations() throws on its
    // `SELECT version FROM schema_migrations`. That is a faithful stand-in for
    // the real hazard: sqlite-vec failing to load, or any migration failing,
    // both of which throw uncaught between the open and the end of init().
    const raw = new Database(dbPath);
    raw.exec("DROP TABLE schema_migrations");
    raw.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY)");
    raw.close();

    chmodSync(dbPath, 0o644);            // a legacy install, mid-repair
    assert.equal(modeOf(dbPath), 0o644);

    await assert.rejects(() => SqliteStore.init(), /schema_migrations|version/i);

    // The repair must have already happened: a boot that never reached the end
    // of init() must not leave provider API keys world-readable behind it.
    assert.equal(modeOf(dbPath), 0o600);
  });

  // A crash leaves the WAL and SHM behind — a clean close checkpoints and removes
  // them, an unclean exit does not. On a pre-#466 install those leftovers are
  // 0644 and hold the same rows as the main file, so a boot that dies before the
  // sidecar pass must still have tightened them.
  test("a boot that dies also repairs pre-existing 0644 sidecars", { skip: !POSIX }, async () => {
    await store?.close?.();
    store = null;

    // An open second connection is what keeps the sidecars on disk here; closing
    // every connection would checkpoint the WAL away and delete them.
    const keeper = new Database(dbPath);
    keeper.pragma("journal_mode = WAL");
    keeper.exec("CREATE TABLE IF NOT EXISTS keepalive (x)");
    keeper.exec("INSERT INTO keepalive VALUES (1)");
    keeper.exec("DROP TABLE IF EXISTS schema_migrations");
    keeper.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY)");

    const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync);
    assert.ok(sidecars.length, "expected the keeper connection to leave WAL/SHM on disk");

    for (const f of [dbPath, ...sidecars]) chmodSync(f, 0o644);

    try {
      await assert.rejects(() => SqliteStore.init(), /schema_migrations|version/i);
      for (const f of [dbPath, ...sidecars]) {
        assert.equal(modeOf(f), 0o600, `${f} should be 0600 after a failed boot`);
      }
    } finally {
      keeper.close();
    }
  });
});
