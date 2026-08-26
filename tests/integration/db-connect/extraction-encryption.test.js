// tests/integration/db-connect/extraction-encryption.test.js
//
// Verifies APERIO_DB_ENCRYPT is honored for the self-provisioned `extraction`
// connection (#250 WS1, P1 review finding): sensitive extracted documents
// must never land on disk as a plain SQLite file just because they live
// outside db/sqlite/store.js.
//
// execSync/execFileSync are mocked BEFORE any module that transitively pulls
// in db/encrypt.js is imported — leaving them real would hit the actual OS
// keychain. tests/integration/db/encrypt.test.js's own comment documents why
// this matters: unmocked, this has previously popped real SecurityAgent
// password prompts and written stray "aperio" keychain entries on a macOS
// dev machine.
//
// node:child_process is obtained via require(), never a static ESM `import`,
// anywhere in this file (P1 review finding). A static `import { x } from
// "node:child_process"` — even for an unrelated export like execFile — makes
// Node snapshot the module's CJS exports into the ESM namespace at THIS
// file's own load time, before before() below ever runs; a module later
// loaded dynamically (db/encrypt.js, via extraction.js → managed-sqlite.js)
// that does its own static `import { execSync, execFileSync } from
// "node:child_process"` then resolves against that pre-mock snapshot and
// keeps the REAL functions, silently defeating mock.method(cp, ...) below —
// confirmed by direct reproduction, not just by inspection.
//
// This file only exercises APERIO_DB_ENCRYPT=1. The "off" (plaintext, as
// before) path is already covered by tests/unit/db-connect/extraction.test.js
// and the real db_execute round-trip in
// tests/integration/handlers/database-confirm.test.js — both run with
// encryption unset, so mixing an "on" case into this file isn't needed and
// would risk the resolved-key cache in managed-sqlite.js (deliberately
// process-lifetime, to avoid a keychain shell-out on every db_execute call)
// leaking a stale key across an on/off boundary within one test process.

import { describe, test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { rmSync, rmdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const cp = require("node:child_process");
const execFileAsync = promisify(cp.execFile);
const WRITE_WORKER = fileURLToPath(new URL("./fixtures/managed-sqlite-write-worker.mjs", import.meta.url));

const PLAINTEXT_MAGIC = "SQLite format 3\0";

let mockExecResult = "";

before(() => {
  const fake = () => mockExecResult;
  mock.method(cp, "execSync", fake);
  mock.method(cp, "execFileSync", fake);
  process.env.APERIO_DB_ENCRYPT = "1";
  mockExecResult = ""; // no existing key on first read -> generate + "store" (mocked, no real keychain write)
});

after(() => {
  delete process.env.APERIO_DB_ENCRYPT;
  mock.reset();
});

// Only the file and its sidecars — never the shared var/extraction/ parent
// directory. That directory is written into by every extraction-touching
// test file (this one, api-database.test.js, database-confirm.test.js), and
// under plain `npm test` those files can run concurrently; an rmdirSync here
// could remove the directory out from under another test between its
// mkdirSync(..., {recursive:true}) and its first write, failing with an
// unrelated-looking ENOENT (P2 review finding). var/ is gitignored, so
// leaving the directory behind is harmless.
function removeManagedFile(file) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) { try { rmSync(file + suffix); } catch { /* ignore */ } }
}

function makeStore(dbName, connections = []) {
  const settings = new Map([["db.connections", connections]]);
  return {
    db: { name: dbName },
    getSetting: async (k) => (settings.has(k) ? settings.get(k) : null),
    setSetting: async (k, v) => { settings.set(k, v); return v; },
  };
}

const uniqueStore = () => makeStore(`enc-test:${randomBytes(8).toString("hex")}`);

describe("self-provisioned extraction connection honors APERIO_DB_ENCRYPT", () => {
  test("provisioning writes the file as an encrypted blob, never plaintext, from the start", async () => {
    const { provisionExtractionConnection } = await import("../../../lib/db-connect/extraction.js");
    const store = uniqueStore();
    const connection = await provisionExtractionConnection(store);
    try {
      const bytes = readFileSync(connection.file);
      assert.notEqual(
        bytes.toString("utf8", 0, 16), PLAINTEXT_MAGIC,
        "the extraction file must not be a readable plaintext SQLite database when APERIO_DB_ENCRYPT=1"
      );
    } finally {
      removeManagedFile(connection.file);
    }
  });

  test("a confirmed db_execute write round-trips through db_query and stays encrypted on disk after close", async () => {
    const { findExtractionConnection } = await import("../../../lib/db-connect/extraction.js");
    const { executeHandler, queryHandler } = await import("../../../lib/handlers/database/databaseHandlers.js");
    const store = uniqueStore();
    const ctx = { store };

    async function confirmed(args) {
      const proposed = await executeHandler(ctx, args);
      const token = proposed.content[0].text.match(/Token:\s*(db_[a-z0-9]+)/)?.[1];
      assert.ok(token, `expected a confirmation token: ${proposed.content[0].text}`);
      return executeHandler(ctx, { confirmation_token: token });
    }

    await confirmed({ connection: "extraction", sql: "CREATE TABLE document_extractions (amount REAL, currency TEXT)" });
    await confirmed({
      connection: "extraction",
      sql: "INSERT INTO document_extractions (amount, currency) VALUES (?, ?)",
      params: [142.5, "BGN"],
    });

    const registered = await findExtractionConnection(store);
    try {
      // On-disk bytes: the whole point of this fix. A write through the
      // normal confirmed tool path must leave an encrypted file behind, not
      // a plain one — this is the concrete "verify its on-disk bytes are
      // encrypted after shutdown" check the P1 finding asked for.
      const bytesAfterWrite = readFileSync(registered.file);
      assert.notEqual(
        bytesAfterWrite.toString("utf8", 0, 16), PLAINTEXT_MAGIC,
        "the file on disk after a confirmed write must stay encrypted, not plaintext"
      );

      // Round-trip: content survives a full decrypt-open / encrypt-close
      // cycle through the SAME real read path — proof this isn't just an
      // unreadable blob, the data genuinely comes back.
      const result = JSON.parse((await queryHandler(ctx, {
        connection: "extraction", sql: "SELECT amount, currency FROM document_extractions",
      })).content[0].text);
      assert.deepEqual(result.rows, [{ amount: 142.5, currency: "BGN" }]);
    } finally {
      removeManagedFile(registered.file);
    }
  });

  test("a second confirmed write against the same profile appends without corrupting the encrypted file", async () => {
    const { findExtractionConnection } = await import("../../../lib/db-connect/extraction.js");
    const { executeHandler, queryHandler } = await import("../../../lib/handlers/database/databaseHandlers.js");
    const store = uniqueStore();
    const ctx = { store };

    async function confirmed(args) {
      const proposed = await executeHandler(ctx, args);
      const token = proposed.content[0].text.match(/Token:\s*(db_[a-z0-9]+)/)?.[1];
      return executeHandler(ctx, { confirmation_token: token });
    }

    await confirmed({ connection: "extraction", sql: "CREATE TABLE t (a INTEGER)" });
    await confirmed({ connection: "extraction", sql: "INSERT INTO t (a) VALUES (1)" });
    await confirmed({ connection: "extraction", sql: "INSERT INTO t (a) VALUES (2)" });

    const registered = await findExtractionConnection(store);
    try {
      const result = JSON.parse((await queryHandler(ctx, { connection: "extraction", sql: "SELECT a FROM t ORDER BY a" })).content[0].text);
      assert.deepEqual(result.rows.map((r) => r.a), [1, 2]);
    } finally {
      removeManagedFile(registered.file);
    }
  });

  test("P1: overlapping opens against the same encrypted file are serialized, not raced (no lost writes, no readonly-write error)", async () => {
    const { createManagedSqliteFile, openManagedSqlite, managedEncryptionKey } = await import("../../../lib/db-connect/drivers/managed-sqlite.js");
    const file = join(tmpdir(), `aperio-managed-lock-test-${randomBytes(8).toString("hex")}.db`);
    const keyBuf = managedEncryptionKey();
    await createManagedSqliteFile(file, keyBuf);

    // Before the fix, two overlapping opens for the SAME encrypted file
    // shared one deterministic temp path: the second open's prepareDatabase()
    // removed/recreated it under the first handle's still-open Database, and
    // either close() could delete it out from under the other — reproducibly
    // "attempt to write a readonly database" or a write vanishing silently.
    async function writeJob(n) {
      const driver = await openManagedSqlite({ file, readOnly: false, keyBuf });
      try {
        driver.db.exec("CREATE TABLE IF NOT EXISTS t (n INTEGER)");
        driver.db.prepare("INSERT INTO t (n) VALUES (?)").run(n);
      } finally {
        driver.close();
      }
    }

    try {
      await Promise.all([writeJob(1), writeJob(2)]);

      const driver = await openManagedSqlite({ file, readOnly: true, keyBuf });
      try {
        const rows = driver.db.prepare("SELECT n FROM t ORDER BY n").all();
        assert.deepEqual(rows.map((r) => r.n), [1, 2], "both overlapping writes must land, neither lost to the race");
      } finally {
        driver.close();
      }
    } finally {
      removeManagedFile(file);
    }
  });

  test("P2: the file lock is released even when finalizeDatabase fails on close, so later opens don't hang forever", async () => {
    const { createManagedSqliteFile, openManagedSqlite } = await import("../../../lib/db-connect/drivers/managed-sqlite.js");
    // A fixed, explicit key — createManagedSqliteFile/openManagedSqlite both
    // take it as a plain parameter specifically so tests never touch the OS
    // keychain (see managed-sqlite.js's own module comment).
    const keyBuf = Buffer.alloc(32, 0x11);
    const file = join(tmpdir(), `aperio-managed-lock-fail-${randomBytes(8).toString("hex")}.db`);
    await createManagedSqliteFile(file, keyBuf);

    try {
      const driver = await openManagedSqlite({ file, readOnly: false, keyBuf });
      driver.db.exec("CREATE TABLE t (a INTEGER)");

      // Sabotage the re-encrypt destination with a real, portable, unmocked
      // failure: writeFileSync on a path that is now a DIRECTORY always
      // throws EISDIR — no fs mocking involved.
      const { unlinkSync, mkdirSync } = await import("node:fs");
      unlinkSync(file);
      mkdirSync(file);

      assert.throws(() => driver.close(), "close() must still surface the finalization failure to the caller");

      // The sabotaged close() means this profile's data at `file` is
      // genuinely gone (finalization never wrote it back) — that data loss
      // isn't what this test is about. What matters is whether the PATH
      // itself is usable again: restore it to a normal file and open it.
      // Before the fix, the first close()'s thrown error skipped release()
      // entirely and this second open would hang forever, queued behind a
      // lock nothing would ever free — race it against a short timeout so a
      // regression fails fast instead of hanging the whole suite.
      rmdirSync(file);
      await createManagedSqliteFile(file, keyBuf);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT: file lock was never released")), 3000));
      const reopened = await Promise.race([openManagedSqlite({ file, readOnly: true, keyBuf }), timeout]);
      reopened.close();
    } finally {
      removeManagedFile(file);
      try { rmdirSync(file); } catch { /* not a directory, or already gone */ }
    }
  });

  // P1 review finding: an in-process-only lock does nothing to stop TWO
  // SEPARATE processes — several MCP processes per agent session, or
  // Postgres as a multi-agent backend, are both explicitly-supported Aperio
  // deployments — from decrypting the same encrypted managed file to the
  // same deterministic plaintext temp path at once. Real child processes
  // (not async tasks in this one process) are used here specifically so the
  // test exercises genuine inter-process contention, not just the
  // in-process async queue already covered by the "overlapping opens" test
  // above.
  test("P1: two SEPARATE processes writing to the same encrypted managed file never lose a confirmed write", async () => {
    const { createManagedSqliteFile, openManagedSqlite } = await import("../../../lib/db-connect/drivers/managed-sqlite.js");
    const keyBuf = Buffer.alloc(32, 0x11);
    const file = join(tmpdir(), `aperio-cross-process-lock-${randomBytes(8).toString("hex")}.db`);
    await createManagedSqliteFile(file, keyBuf);

    try {
      await Promise.all([
        execFileAsync(process.execPath, [WRITE_WORKER, file, "1"]),
        execFileAsync(process.execPath, [WRITE_WORKER, file, "2"]),
      ]);

      const driver = await openManagedSqlite({ file, readOnly: true, keyBuf });
      try {
        const rows = driver.db.prepare("SELECT n FROM t ORDER BY n").all();
        assert.deepEqual(rows.map((r) => r.n), [1, 2], "both processes' writes must land, neither lost to the cross-process race");
      } finally {
        driver.close();
      }
    } finally {
      removeManagedFile(file);
    }
  });

  // P2 review finding: if the process crashes after creating `file` but
  // before finishing its header write (plaintext) or its final encrypted
  // write, the next provisioning attempt must not treat "a file exists at
  // this path" as "already successfully provisioned" — that registers a
  // connection that can never open again. A zero-byte file is exactly what
  // that interrupted first-use crash leaves behind.
  test("P2: recovers from a file left corrupt by an interrupted first-use provisioning, instead of registering a permanently-broken connection", async () => {
    const { createManagedSqliteFile, openManagedSqlite } = await import("../../../lib/db-connect/drivers/managed-sqlite.js");
    const keyBuf = Buffer.alloc(32, 0x11);
    const file = join(tmpdir(), `aperio-interrupted-provision-${randomBytes(8).toString("hex")}.db`);

    writeFileSync(file, Buffer.alloc(0)); // the exact wreckage an interrupted new Database(file) leaves

    try {
      await createManagedSqliteFile(file, keyBuf);

      // The corrupt leftover must have been replaced with a genuinely valid,
      // openable, ENCRYPTED managed file — not left in place, and not just
      // silently accepted as "already there".
      const bytes = readFileSync(file);
      assert.notEqual(bytes.length, 0, "the corrupt zero-byte leftover must have been replaced");
      assert.notEqual(
        bytes.toString("utf8", 0, 16), PLAINTEXT_MAGIC,
        "the recovered file must still be encrypted, never a plaintext fallback"
      );

      const driver = await openManagedSqlite({ file, readOnly: false, keyBuf });
      try {
        driver.db.exec("CREATE TABLE t (a INTEGER)");
        driver.db.prepare("INSERT INTO t (a) VALUES (1)").run();
      } finally {
        driver.close();
      }

      const reopened = await openManagedSqlite({ file, readOnly: true, keyBuf });
      try {
        assert.equal(reopened.db.prepare("SELECT a FROM t").get().a, 1);
      } finally {
        reopened.close();
      }
    } finally {
      removeManagedFile(file);
    }
  });
});
