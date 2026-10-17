// tests/integration/db-connect/managed-sqlite-open-failure-cleanup.test.js
//
// P2 review finding on lib/db-connect/drivers/managed-sqlite.js: when
// APERIO_DB_ENCRYPT is on, prepareDatabase() already writes the COMPLETE
// plaintext database to the deterministic temp path before the Database
// constructor runs. If SQLite then refuses to open that file, the plaintext
// must not linger on disk indefinitely — the encrypted source at `file` is
// untouched, so there is nothing else worth preserving there.
//
// Deliberately its OWN file, not folded into extraction-encryption.test.js:
// this test sabotages better-sqlite3's Database class via require.cache
// (the same technique tests/unit/db-connect/extraction.test.js uses) so its
// SECOND construction call — openManagedSqlite's real, already-decrypted
// temp path, never createManagedSqliteFile's own scratch write — has its
// permissions yanked out from under it, reproducing a genuine SQLITE_CANTOPEN
// at construction time without touching anything mocked. That only works if
// this is the FIRST thing in the process to ever resolve 'better-sqlite3'
// through Node's ESM/CJS interop: that resolution is cached once per
// process (like 'node:fs' — see the file-lock/legacy-quarantine test
// comments elsewhere in this repo for the same gotcha), so a LATER test in
// a file that already loaded the real class first would silently miss the
// sabotage. `node --test` runs each FILE in its own process, so keeping
// this the only test here — and the only thing that ever imports
// managed-sqlite.js in this process — makes that ordering guaranteed rather
// than incidental.
//
// execSync/execFileSync are mocked before anything touches db/encrypt.js,
// same reasoning as extraction-encryption.test.js: unmocked, this can pop a
// real macOS Keychain prompt and write a stray "aperio" entry.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { rmSync, readFileSync, existsSync, chmodSync } from "node:fs";

const require = createRequire(import.meta.url);

before(() => {
  const cp = require("node:child_process");
  mock.method(cp, "execSync", () => "");
  mock.method(cp, "execFileSync", () => "");
  process.env.APERIO_DB_ENCRYPT = "1";
});

after(() => {
  delete process.env.APERIO_DB_ENCRYPT;
  mock.reset();
});

describe("managed-sqlite open-failure cleanup", () => {
  test("cleans up the decrypted plaintext temp file when SQLite refuses to open it, instead of leaving it on disk", async () => {
    const bsqlitePath = require.resolve("better-sqlite3");
    const RealDatabase = require(bsqlitePath);

    let capturedContent = null;
    let sabotagedPath = null;
    class SabotagingDatabase extends RealDatabase {
      constructor(path, opts) {
        // Only the SECOND construction call in this whole process matters:
        // openManagedSqlite's real, already-decrypted temp path. It's the
        // first (and only, in this process) call made with fileMustExist
        // against a path that already exists — createManagedSqliteFile's
        // own scratch write never passes fileMustExist.
        if (!sabotagedPath && opts?.fileMustExist && existsSync(path)) {
          capturedContent = readFileSync(path);
          chmodSync(path, 0o000);
          sabotagedPath = path;
        }
        super(path, opts);
      }
    }
    require.cache[bsqlitePath] = { ...require.cache[bsqlitePath], exports: SabotagingDatabase };

    const { createManagedSqliteFile, openManagedSqlite } = await import("../../../lib/db-connect/drivers/managed-sqlite.js");
    const keyBuf = Buffer.alloc(32, 0x11); // fixed test key — never touches the OS keychain
    const file = join(tmpdir(), `aperio-open-fail-cleanup-${randomBytes(8).toString("hex")}.db`);
    const expectedTempPath = join(
      tmpdir(),
      `aperio-db-${createHash("sha256").update(file).digest("hex").slice(0, 16)}.sqlite`
    );

    try {
      await createManagedSqliteFile(file, keyBuf);

      await assert.rejects(
        () => openManagedSqlite({ file, readOnly: true, keyBuf }),
        /SQLITE_CANTOPEN|unable to open/i,
        "the sabotaged permission must surface as a real open failure"
      );

      assert.ok(sabotagedPath, "sanity: the sabotage must have actually fired against a real temp path");
      assert.ok(capturedContent && capturedContent.length > 0, "sanity: prepareDatabase really had written real plaintext content before the failure");
      assert.equal(sabotagedPath, expectedTempPath, "sanity: sabotaged exactly the deterministic temp path openManagedSqlite uses");

      assert.ok(!existsSync(expectedTempPath), "the decrypted plaintext temp file must be removed after the failed open, not left on disk");
    } finally {
      try { chmodSync(expectedTempPath, 0o600); } catch { /* already cleaned up, or never existed */ }
      for (const suffix of ["", "-wal", "-shm", "-journal"]) { try { rmSync(file + suffix); } catch { /* already gone */ } }
      for (const suffix of ["", "-wal", "-shm", "-journal"]) { try { rmSync(expectedTempPath + suffix); } catch { /* already gone */ } }
    }
  });
});
