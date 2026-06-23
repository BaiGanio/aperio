// db/encrypt.js
// Machine-bound AES-256-GCM encryption for the SQLite database file.
//
// When APERIO_DB_ENCRYPT=1:
//   1. A random 256-bit key is generated and stored in the OS keychain / DPAPI.
//   2. The key NEVER touches disk — it lives in the keychain and in memory.
//   3. At startup, the encrypted DB is decrypted to a temp location.
//   4. At shutdown, the temp DB is re-encrypted and temp files removed.
//
// Platform key storage:
//   macOS:   Keychain via `security` CLI (built-in, no deps)
//   Linux:   libsecret via `secret-tool` (apt install libsecret-tools)
//            Falls back to ~/.aperio/db.key with 0600 permissions.
//   Windows: DPAPI via PowerShell (built-in, machine+user bound)
//
// The file at SQLITE_PATH IS the encrypted file — no separate .enc suffix.
// When encrypted, it cannot be opened by SQLite tools directly.
//
// Crash recovery: if a temp file from a previous run exists and is newer
// than the encrypted file, it's restored (it has more recent committed data).

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import logger from '../lib/helpers/logger.js';

const ALGORITHM    = 'aes-256-gcm';
const KEY_LENGTH   = 32;  // 256 bits
const NONCE_LENGTH = 12;  // 96 bits
const TAG_LENGTH   = 16;  // 128 bits (GCM authentication tag)
const KEYCHAIN_SERVICE = 'aperio';
const KEYCHAIN_ACCOUNT = 'aperio-db-key';

const isMac  = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const isWin  = process.platform === 'win32';

// ── Key generation ────────────────────────────────────────────────────────────

function generateKey() {
  return randomBytes(KEY_LENGTH).toString('hex');
}

function keyToBuffer(hex) {
  return Buffer.from(hex, 'hex');
}

// ── Platform: macOS Keychain ──────────────────────────────────────────────────

function macStoreKey(keyHex) {
  // -A: allow any local app to read the key without a per-access password
  // prompt. The threat model here is at-rest disk theft (an attacker with the
  // encrypted DB file but not this machine); a process already running as this
  // user can read the key regardless. The previous `-T ""` left an empty ACL,
  // which made macOS prompt for the login password on EVERY launch — see #180.
  execSync(
    `security add-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w "${keyHex}" -A -U`,
    { stdio: 'ignore' }
  );
  logger.info('[encrypt] Key stored in macOS Keychain');
}

function macGetKey() {
  try {
    return execSync(
      `security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return null;
  }
}

// ── Platform: Linux libsecret ─────────────────────────────────────────────────

function linuxSecretToolAvailable() {
  try {
    execSync('which secret-tool', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function linuxStoreKey(keyHex) {
  if (linuxSecretToolAvailable()) {
    execSync(
      `secret-tool store --label='Aperio DB Key' service "${KEYCHAIN_SERVICE}" account "${KEYCHAIN_ACCOUNT}"`,
      { input: keyHex + '\n', stdio: ['pipe', 'ignore', 'pipe'] }
    );
    logger.info('[encrypt] Key stored in libsecret (secret-tool)');
    return;
  }
  linuxStoreKeyFile(keyHex);
}

function linuxGetKey() {
  if (linuxSecretToolAvailable()) {
    try {
      return execSync(
        `secret-tool lookup service "${KEYCHAIN_SERVICE}" account "${KEYCHAIN_ACCOUNT}"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
    } catch {
      return null;
    }
  }
  return linuxGetKeyFile();
}

function linuxKeyFilePath() {
  const dir = join(homedir(), '.aperio');
  return join(dir, 'db.key');
}

function linuxStoreKeyFile(keyHex) {
  const filePath = linuxKeyFilePath();
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, keyHex, { mode: 0o600, encoding: 'utf8' });
  logger.warn(
    '[encrypt] libsecret-tools not found — key stored in ~/.aperio/db.key (0600). ' +
    'Install libsecret-tools for OS-managed key storage.'
  );
}

function linuxGetKeyFile() {
  try {
    return readFileSync(linuxKeyFilePath(), 'utf8').trim();
  } catch {
    return null;
  }
}

// ── Platform: Windows DPAPI ───────────────────────────────────────────────────

function winKeyFilePath() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const dir = join(appData, 'aperio');
  return join(dir, 'db.key');
}

function winStoreKey(keyHex) {
  const filePath = winKeyFilePath();
  mkdirSync(dirname(filePath), { recursive: true });

  // DPAPI via PowerShell: ConvertFrom-SecureString encrypts with the current
  // user + machine context. The resulting blob can only be decrypted on this
  // machine by this user — it cannot be copied to another machine.
  // Escape single quotes in the key (hex chars only, but be safe).
  const escaped = keyHex.replace(/'/g, "''");
  const script =
    `$key='${escaped}';` +
    `$s=ConvertTo-SecureString $key -AsPlainText -Force;` +
    `$e=ConvertFrom-SecureString $s;` +
    `Set-Content -Path '${filePath}' -Value $e`;
  execSync(`powershell -NoProfile -NonInteractive -Command "${script}"`, { stdio: 'ignore' });
  logger.info('[encrypt] Key stored in Windows DPAPI');
}

function winGetKey() {
  const filePath = winKeyFilePath();
  if (!existsSync(filePath)) return null;
  try {
    const script =
      `$e=Get-Content -Path '${filePath}' -Raw;` +
      `$s=ConvertTo-SecureString $e.Trim();` +
      `$p=[System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);` +
      `[System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)`;
    return execSync(
      `powershell -NoProfile -NonInteractive -Command "${script}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return null;
  }
}

// ── Platform dispatch ─────────────────────────────────────────────────────────

function storeKey(keyHex) {
  if (isMac)  return macStoreKey(keyHex);
  if (isLinux) return linuxStoreKey(keyHex);
  if (isWin)  return winStoreKey(keyHex);
  throw new Error(`[encrypt] Unsupported platform: ${process.platform}`);
}

function getKey() {
  if (isMac)  return macGetKey();
  if (isLinux) return linuxGetKey();
  if (isWin)  return winGetKey();
  return null;
}

// ── Encryption / decryption ───────────────────────────────────────────────────

function encrypt(plainBuf, keyBuf) {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuf, nonce);
  const encrypted = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: [12-byte nonce][ciphertext][16-byte auth tag]
  return Buffer.concat([nonce, encrypted, tag]);
}

function decrypt(encBuf, keyBuf) {
  const nonce = encBuf.subarray(0, NONCE_LENGTH);
  const tag   = encBuf.subarray(encBuf.length - TAG_LENGTH);
  const data  = encBuf.subarray(NONCE_LENGTH, encBuf.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, keyBuf, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ── File operations ───────────────────────────────────────────────────────────

function encryptFile(srcPath, destPath, keyBuf) {
  logger.debug(`[encrypt] Encrypting ${srcPath} → ${destPath}`);
  const plain = readFileSync(srcPath);
  const enc   = encrypt(plain, keyBuf);
  writeFileSync(destPath, enc, { mode: 0o600 });
}

function decryptFile(srcPath, destPath, keyBuf) {
  logger.debug(`[encrypt] Decrypting ${srcPath} → ${destPath}`);
  const enc   = readFileSync(srcPath);
  const plain = decrypt(enc, keyBuf);
  writeFileSync(destPath, plain, { mode: 0o600 });
}

function getTempPath(dbPath) {
  const hash = Buffer.from(dbPath).toString('hex').slice(0, 12);
  return join(tmpdir(), `aperio-db-${hash}.sqlite`);
}

function removeTempFiles(tempPath) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = tempPath + suffix;
    try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Whether database encryption is enabled.
 */
export function isEncryptionEnabled() {
  return process.env.APERIO_DB_ENCRYPT === '1';
}

/**
 * Get or create the encryption key from the platform key store.
 * On first run, generates a key and stores it. On subsequent runs,
 * retrieves the existing key. Returns null if encryption is disabled.
 * @returns {Buffer|null} 32-byte key buffer, or null
 */
export function getOrCreateKey() {
  if (!isEncryptionEnabled()) return null;

  let keyHex = getKey();
  if (keyHex && keyHex.length === 64) {
    logger.info('[encrypt] Key retrieved from platform key store');
    return keyToBuffer(keyHex);
  }

  if (keyHex) {
    logger.warn('[encrypt] Stored key has incorrect length, regenerating...');
  }

  // First run or corrupted key: generate and store.
  keyHex = generateKey();
  storeKey(keyHex);
  logger.info('[encrypt] New encryption key generated and stored');
  return keyToBuffer(keyHex);
}

/**
 * Prepare the database for encrypted access.
 * - Decrypts the encrypted DB file to a temp location.
 * - Handles crash recovery: if a temp file from a prior run is newer,
 *   restores from it (it may have more recent committed data).
 * - Returns the path to the decrypted temp DB file.
 *
 * @param {string} dbPath   - Path to the encrypted database file (SQLITE_PATH)
 * @param {Buffer} keyBuf   - 32-byte encryption key
 * @returns {string|null}   - Path to temp decrypted DB, or null if not encrypted
 */
export function prepareDatabase(dbPath, keyBuf) {
  if (!keyBuf) return null;

  const tempPath = getTempPath(dbPath);
  const encPath  = dbPath; // The file at SQLITE_PATH IS the encrypted file

  // Crash recovery: if a temp file from a previous crash exists, check if
  // it's newer than the encrypted file. If so, the temp has more recent
  // committed writes — restore from it.
  if (existsSync(tempPath) && existsSync(encPath)) {
    const tempStat = statSync(tempPath);
    const encStat  = statSync(encPath);
    if (tempStat.mtime > encStat.mtime) {
      logger.warn('[encrypt] Found newer temp DB from previous crash — restoring writes');
      try {
        encryptFile(tempPath, encPath, keyBuf);
      } catch (err) {
        logger.warn(`[encrypt] Could not restore from temp: ${err.message}`);
      }
    }
    removeTempFiles(tempPath);
  }

  if (existsSync(encPath)) {
    // Detect plaintext SQLite files — migrate them to encrypted storage.
    // When a user first enables APERIO_DB_ENCRYPT=1 on an existing plaintext
    // database, the file starts with the SQLite magic header. Encrypt it
    // in-place instead of trying (and failing) to decrypt it.
    const rawHeader = readFileSync(encPath);
    const isPlaintext = rawHeader.toString('utf8', 0, 16) === 'SQLite format 3\u0000';

    if (isPlaintext) {
      logger.info('[encrypt] Existing plaintext database detected — migrating to encrypted');
      // Read plaintext, encrypt in-place at encPath, then decrypt to temp.
      const plaintext = readFileSync(encPath);
      writeFileSync(encPath, encrypt(plaintext, keyBuf), { mode: 0o600 });
      decryptFile(encPath, tempPath, keyBuf);
    } else {
      decryptFile(encPath, tempPath, keyBuf);
    }

    // Verify the resulting temp file is valid SQLite.
    try {
      const header = readFileSync(tempPath);
      const magic = header.toString('utf8', 0, 16);
      if (magic !== 'SQLite format 3\u0000') {
        throw new Error(
          'Decrypted file is not a valid SQLite database. ' +
          'This may mean the encryption key is wrong or the file is corrupted. ' +
          'If you recently changed machines, re-generate the key by removing ' +
          'the keychain entry and restarting (this will create a fresh database).'
        );
      }
    } catch (err) {
      removeTempFiles(tempPath);
      throw err;
    }
    logger.info(`[encrypt] Database decrypted: ${tempPath}`);
  } else {
    logger.info('[encrypt] No existing encrypted database — starting fresh');
  }

  return tempPath;
}

/**
 * Encrypt the temp DB back to the main path and clean up temp files.
 * Called on graceful shutdown. Safe to call even if encryption is disabled.
 *
 * @param {string} dbPath   - Path to save the encrypted database to
 * @param {string} tempPath - Path to the temp decrypted database
 * @param {Buffer} keyBuf   - 32-byte encryption key (null if disabled)
 */
export function finalizeDatabase(dbPath, tempPath, keyBuf) {
  if (!keyBuf || !tempPath) return;

  try {
    if (existsSync(tempPath)) {
      encryptFile(tempPath, dbPath, keyBuf);
      logger.info('[encrypt] Database encrypted and saved');
    }
  } finally {
    removeTempFiles(tempPath);
  }
}
