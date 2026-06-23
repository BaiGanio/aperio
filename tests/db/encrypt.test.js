// tests/db/encrypt.test.js
//
// Tests for db/encrypt.js — AES-256-GCM encryption for SQLite databases.
// Only exported API functions are tested: isEncryptionEnabled, getOrCreateKey,
// prepareDatabase, and finalizeDatabase. Internal helpers (encrypt, decrypt,
// getTempPath, removeTempFiles) are tested indirectly through the public API.
//
// execSync is mocked for keychain tests; all fs operations use real temp files
// to avoid crashing winston/logger (which imports fs internally).

import { describe, test, mock, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";

const require = createRequire(import.meta.url);

// ─── Shared mock state for execSync (keychain operations only) ─────────────
let mockExecResult = "";
let mockExecThrow = false;

// ─── Cache-busting import helper ───────────────────────────────────────────
const _cacheBust = () => `../../db/encrypt.js?t=${Date.now()}_${Math.random().toString(36).slice(2)}`;

// ─── Mock execSync ONCE ───────────────────────────────────────────────────
// execSync is only used for platform keychain commands — no winston dependency.
before(() => {
  const cp = require("node:child_process");
  mock.method(cp, "execSync", () => {
    if (mockExecThrow) throw new Error(mockExecThrow);
    return mockExecResult;
  });
});

afterEach(() => {
  mockExecResult = "";
  mockExecThrow = false;
  delete process.env.APERIO_DB_ENCRYPT;
});

// ─── Temp file helpers ─────────────────────────────────────────────────────
let _tmpCounter = 0;
function tmpPath(name) {
  _tmpCounter++;
  return join(tmpdir(), `aperio-enc-test-${_tmpCounter}-${name}`);
}
function cleanup(...paths) {
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  }
}

// =============================================================================
// isEncryptionEnabled
// =============================================================================
describe("isEncryptionEnabled", () => {
  test("returns false when env var is not set", async () => {
    delete process.env.APERIO_DB_ENCRYPT;
    const { isEncryptionEnabled } = await import(_cacheBust());
    assert.strictEqual(isEncryptionEnabled(), false);
  });

  test("returns true when env var is 1", async () => {
    process.env.APERIO_DB_ENCRYPT = "1";
    const { isEncryptionEnabled } = await import(_cacheBust());
    assert.strictEqual(isEncryptionEnabled(), true);
  });

  test("returns false when env var is 0", async () => {
    process.env.APERIO_DB_ENCRYPT = "0";
    const { isEncryptionEnabled } = await import(_cacheBust());
    assert.strictEqual(isEncryptionEnabled(), false);
  });
});

// =============================================================================
// getOrCreateKey
// =============================================================================
describe("getOrCreateKey", () => {
  test("returns null when encryption is disabled", async () => {
    delete process.env.APERIO_DB_ENCRYPT;
    const mod = await import(_cacheBust());
    assert.strictEqual(mod.getOrCreateKey(), null);
  });

  test("generates and stores a new key on first run", async () => {
    process.env.APERIO_DB_ENCRYPT = "1";
    mockExecResult = ""; // no existing key → generate new

    const mod = await import(_cacheBust());
    const key = mod.getOrCreateKey();
    assert.ok(key instanceof Buffer, "should return a Buffer");
    assert.strictEqual(key.length, 32, "should be 32 bytes (256 bits)");
  });

  test("retrieves an existing key", async () => {
    process.env.APERIO_DB_ENCRYPT = "1";
    mockExecResult = "ab".repeat(32); // 64 hex chars = 32 bytes

    const mod = await import(_cacheBust());
    const key = mod.getOrCreateKey();
    assert.ok(key instanceof Buffer);
    assert.strictEqual(key.length, 32);
    assert.strictEqual(key.toString("hex"), "ab".repeat(32));
  });

  test("regenerates key when stored key has wrong length", async () => {
    process.env.APERIO_DB_ENCRYPT = "1";
    mockExecResult = "too_short";

    const mod = await import(_cacheBust());
    const key = mod.getOrCreateKey();
    assert.ok(key instanceof Buffer);
    assert.strictEqual(key.length, 32, "should generate a new 32-byte key");
  });
});

// =============================================================================
// prepareDatabase
// =============================================================================
describe("prepareDatabase", () => {
  test("returns null when keyBuf is null/undefined", async () => {
    const mod = await import(_cacheBust());
    assert.strictEqual(mod.prepareDatabase("/tmp/test.db", null), null);
    assert.strictEqual(mod.prepareDatabase("/tmp/test.db", undefined), null);
  });

  test("decrypts an existing encrypted database", async () => {
    process.env.APERIO_DB_ENCRYPT = "1";
    const mod = await import(_cacheBust());
    const key = Buffer.alloc(32, 0x42);

    // We need an encrypted file at the source path.
    // Since encrypt/decrypt are internal, we create one by writing a plaintext
    // SQLite header file, then calling prepareDatabase with key — it detects
    // plaintext, encrypts in place, then decrypts to temp.
    const dbPath = tmpPath("decrypt-roundtrip.db");
    const sqliteData = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.from("decrypt-test-content"),
    ]);

    try {
      writeFileSync(dbPath, sqliteData);

      const tempPath = mod.prepareDatabase(dbPath, key);
      assert.ok(typeof tempPath === "string", "should return a temp path");
      assert.ok(tempPath.includes("aperio-db-"), "path should contain aperio prefix");

      // Original file should now be encrypted
      const raw = readFileSync(dbPath);
      const magic = raw.toString("utf8", 0, 16);
      assert.notStrictEqual(magic, "SQLite format 3\0", "file should be encrypted");

      // Temp file should be valid SQLite
      const decrypted = readFileSync(tempPath);
      assert.strictEqual(
        decrypted.toString("utf8", 0, 16), "SQLite format 3\0",
        "temp file should have SQLite header"
      );

      cleanup(tempPath, tempPath + "-wal", tempPath + "-shm", tempPath + "-journal");
    } finally {
      cleanup(dbPath);
    }
  });

  test("migrates a plaintext database to encrypted storage", async () => {
    process.env.APERIO_DB_ENCRYPT = "1";
    const mod = await import(_cacheBust());
    const key = Buffer.alloc(32, 0x42);

    const dbPath = tmpPath("migrate-plain.db");
    const plaintext = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.from("existing plaintext database content for migration test"),
    ]);

    try {
      writeFileSync(dbPath, plaintext);

      const tempPath = mod.prepareDatabase(dbPath, key);
      assert.ok(typeof tempPath === "string", "should return temp path");

      // Original should now be encrypted
      const after = readFileSync(dbPath);
      assert.notStrictEqual(
        after.toString("utf8", 0, 16), "SQLite format 3\0",
        "original should be encrypted after migration"
      );

      cleanup(tempPath, tempPath + "-wal", tempPath + "-shm", tempPath + "-journal");
    } finally {
      cleanup(dbPath);
    }
  });

  test("starts fresh when no file exists", async () => {
    process.env.APERIO_DB_ENCRYPT = "1";
    const mod = await import(_cacheBust());
    const missingPath = join(tmpdir(), "aperio-enc-nonexistent-" + Date.now() + ".db");

    const tempPath = mod.prepareDatabase(missingPath, Buffer.alloc(32, 0x42));
    assert.ok(typeof tempPath === "string", "should return temp path for fresh start");
    assert.ok(!existsSync(missingPath), "no source file created for fresh start");
  });
});

// =============================================================================
// finalizeDatabase
// =============================================================================
describe("finalizeDatabase", () => {
  test("does nothing when keyBuf is null", async () => {
    const mod = await import(_cacheBust());
    const dbPath = tmpPath("finalize-null.db");
    const tempPath = tmpPath("finalize-null-temp.db");

    try {
      writeFileSync(tempPath, "temp data");
      mod.finalizeDatabase(dbPath, tempPath, null);
      assert.ok(existsSync(tempPath), "temp file should remain when keyBuf is null");
    } finally {
      cleanup(dbPath, tempPath);
    }
  });

  test("encrypts temp file to target path and cleans up", async () => {
    process.env.APERIO_DB_ENCRYPT = "1";
    const mod = await import(_cacheBust());
    const key = Buffer.alloc(32, 0x42);
    const dbPath = tmpPath("finalize-target.db");
    const tempPath = tmpPath("finalize-temp.db");

    try {
      writeFileSync(tempPath, "SQLite format 3\0temporary data for finalization");
      assert.ok(existsSync(tempPath), "temp file should exist before finalization");

      mod.finalizeDatabase(dbPath, tempPath, key);

      assert.ok(!existsSync(tempPath), "temp file should be removed after finalization");
      assert.ok(existsSync(dbPath), "target encrypted file should exist");
    } finally {
      cleanup(dbPath, tempPath, tempPath + "-wal", tempPath + "-shm", tempPath + "-journal");
    }
  });

  test("handles missing temp file gracefully", async () => {
    const mod = await import(_cacheBust());
    const missingPath = join(tmpdir(), "aperio-nonexistent-" + Date.now());
    mod.finalizeDatabase("/tmp/target.db", missingPath, Buffer.alloc(32, 0x42));
    // Should not throw
  });
});

// =============================================================================
// prepareDatabase + finalizeDatabase integration (full round-trip)
// =============================================================================
describe("full encrypt/decrypt round-trip", () => {
  test("prepare → finalize encrypt-decrypt-encrypt round-trips", async () => {
    process.env.APERIO_DB_ENCRYPT = "1";
    const mod = await import(_cacheBust());
    const key = Buffer.alloc(32, 0x99);

    // 1. Start with a plaintext SQLite file
    const dbPath = tmpPath("roundtrip.db");
    const plaintext = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.from("Round-trip test content"),
    ]);

    try {
      writeFileSync(dbPath, plaintext);

      // 2. prepareDatabase encrypts the plaintext and returns a temp decrypted copy
      const tempPath = mod.prepareDatabase(dbPath, key);
      assert.ok(typeof tempPath === "string", "prepare should succeed");

      // The temp file should have the original plaintext
      const decrypted = readFileSync(tempPath);
      assert.ok(decrypted.equals(plaintext), "temp file should match original plaintext");

      // The source file should now be encrypted
      const encrypted = readFileSync(dbPath);
      assert.ok(!encrypted.equals(plaintext), "source should be encrypted");

      // 3. finalizeDatabase encrypts the temp back to source and cleans up
      mod.finalizeDatabase(dbPath, tempPath, key);
      assert.ok(!existsSync(tempPath), "temp should be cleaned up after finalize");

      // Source should still exist and be encrypted
      assert.ok(existsSync(dbPath), "source should exist after finalize");
      const reEncrypted = readFileSync(dbPath);
      assert.ok(!reEncrypted.equals(plaintext), "source should remain encrypted after finalize");

      cleanup(tempPath, tempPath + "-wal", tempPath + "-shm", tempPath + "-journal");
    } finally {
      cleanup(dbPath);
    }
  });
});
