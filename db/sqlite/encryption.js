// db/sqlite/encryption.js
// Decrypt-in-place reconciliation for the one direction db/encrypt.js's
// prepareDatabase can't cover: APERIO_DB_ENCRYPT turned off while the file on
// disk is still an encrypted blob (see the call site in store.js init()).

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import logger from '../../lib/helpers/logger.js';
import { readExistingKey, isPlaintextSqlite, decryptFile, KeyUnreadableError } from '../encrypt.js';

// Decrypt an on-disk encrypted DB back to plaintext, in place, when the user
// has turned encryption off. Exported (underscore-prefixed) so it can be unit
// tested with a known key. Safety contract:
//   • Reads the EXISTING key only — never generates one (readExistingKey).
//   • Decryption is AES-256-GCM authenticated, so a wrong key throws rather than
//     producing garbage; the plaintext is byte-identical to the original.
//   • Verifies the result opens as a real SQLite DB BEFORE replacing the file.
//   • Swaps via an atomic rename, so the original is never half-written.
//   • Keeps a single .encrypted.bak only for the brief migration window, then
//     removes it on success — so repeated on/off flips never accumulate backups.
export function _decryptDbFileInPlace(dbPath, key) {
  const backup = dbPath + '.encrypted.bak';
  const tmp    = dbPath + '.decrypted.tmp';
  copyFileSync(dbPath, backup);
  try {
    decryptFile(dbPath, tmp, key);                 // throws on wrong key / corruption
    if (!isPlaintextSqlite(tmp)) {
      throw new Error('decrypted output is not a SQLite database');
    }
    const probe = new Database(tmp, { readonly: true });
    try { probe.prepare('SELECT count(*) FROM sqlite_master').get(); }
    finally { probe.close(); }
    renameSync(tmp, dbPath);                        // atomic: encrypted → plaintext
    unlinkSync(backup);                             // verified → leave no .bak behind
    logger.info('[sqlite] APERIO_DB_ENCRYPT is off — database decrypted to plaintext on disk (one-time migration).');
  } catch (err) {
    // The original is only replaced by the atomic rename AFTER verification, so
    // on any failure it is still the intact encrypted file. Just clean up.
    for (const p of [tmp, backup]) { try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ } }
    throw err;
  }
}

// Acquire the key, then decrypt. Split from _decryptDbFileInPlace so the latter
// stays key-injectable for tests and the keychain interaction lives here.
export function decryptDbFileInPlace(dbPath) {
  let key;
  try {
    key = readExistingKey();
  } catch (err) {
    if (err instanceof KeyUnreadableError) {
      throw new Error(
        `Your database is encrypted, but APERIO_DB_ENCRYPT is off and its key can't be read.\n` +
        `  • To keep it encrypted: set APERIO_DB_ENCRYPT=1 and restart.\n` +
        `  • To repair key access: run \`npm run db:fix-keychain\`, then restart.\n` +
        `  (${err.message})`
      );
    }
    throw err;
  }
  if (!key) {
    throw new Error(
      `Your database file is encrypted, but APERIO_DB_ENCRYPT is off and no encryption key was found ` +
      `in the keychain. Set APERIO_DB_ENCRYPT=1 to open it, or restore a plaintext backup.`
    );
  }
  try {
    _decryptDbFileInPlace(dbPath, key);
  } catch (err) {
    throw new Error(
      `Couldn't auto-decrypt the database after APERIO_DB_ENCRYPT was turned off: ${err.message}\n` +
      `Your original encrypted file is intact — set APERIO_DB_ENCRYPT=1 to keep using it.`
    );
  }
}
