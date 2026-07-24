// tests/db/reconcile-decrypt.test.js
//
// Covers the off→encrypted reconcile: when APERIO_DB_ENCRYPT is off but the file
// on disk is still an encrypted blob, _decryptDbFileInPlace must transparently
// decrypt it back to plaintext, preserve the data, and leave no backup/temp
// files behind (so repeated flips never accumulate noise). The key-acquisition
// wrapper is exercised separately; here we inject a known key.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { encryptFile } from "../../../db/encrypt.js";
import { _decryptDbFileInPlace } from "../../../db/sqlite.js";

const MAGIC = "SQLite format 3\0";
const KEY = Buffer.alloc(32, 0x5a);

function makeEncryptedDb(dir) {
  const plain = join(dir, "plain.db");
  const db = new Database(plain);
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO t(v) VALUES (?)").run("hello-reconcile");
  db.close();
  const dbPath = join(dir, "aperio.db");
  encryptFile(plain, dbPath, KEY);
  return dbPath;
}

describe("_decryptDbFileInPlace", () => {
  test("decrypts in place, preserves data, leaves no backup/temp", () => {
    const dir = mkdtempSync(join(tmpdir(), "aperio-recon-"));
    try {
      const dbPath = makeEncryptedDb(dir);
      // sanity: starts encrypted
      assert.notStrictEqual(readFileSync(dbPath).toString("utf8", 0, 16), MAGIC);

      _decryptDbFileInPlace(dbPath, KEY);

      assert.strictEqual(readFileSync(dbPath).toString("utf8", 0, 16), MAGIC, "should be plaintext now");
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare("SELECT v FROM t WHERE id=1").get();
      db.close();
      assert.strictEqual(row?.v, "hello-reconcile", "row must survive the migration");

      const leftovers = readdirSync(dir).filter((f) => /\.bak$|\.tmp$/.test(f));
      assert.deepStrictEqual(leftovers, [], "no backup/temp files should remain");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wrong key leaves the original encrypted file intact (no partial write)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aperio-recon-"));
    try {
      const dbPath = makeEncryptedDb(dir);
      const before = readFileSync(dbPath);

      assert.throws(() => _decryptDbFileInPlace(dbPath, Buffer.alloc(32, 0x11)));

      assert.ok(readFileSync(dbPath).equals(before), "original encrypted file must be untouched on failure");
      const leftovers = readdirSync(dir).filter((f) => /\.bak$|\.tmp$/.test(f));
      assert.deepStrictEqual(leftovers, [], "no backup/temp files should remain after a failed attempt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
