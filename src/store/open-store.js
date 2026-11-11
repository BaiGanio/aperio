// src/store/open-store.js - open the SQLite file, apply migrations, set up the
// vector table, and return the memory store (spec S2.3).
//
// No env read and no module state: the caller passes `path` and `dims` from
// config, so two stores with two paths never share anything (AP1, TR15).

import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { StoreError, createMemoryStore } from './memory-store.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const VEC_TABLE = 'vec_memories';

/** Apply every *.sql file once, in name order, one transaction per file. */
async function runMigrations(db, dir, log) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const record = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    try {
      db.transaction(() => {
        db.exec(sql);
        record.run(file);
      })();
    } catch (err) {
      throw new StoreError(`migration ${file} failed: ${err.message}`, { cause: err });
    }
    log.info(`[store] applied migration ${file}`);
  }
}

/** Load sqlite-vec. A failure is a supported mode (L-C20): full-text only. */
function tryLoadVector(db, loadVector, log) {
  try {
    loadVector(db);
    return true;
  } catch (err) {
    log.warn(`[store] sqlite-vec did not load (${err.message}). Semantic search is off; full-text search still works.`);
    return false;
  }
}

/**
 * Make sure the vector table exists at the right width. Vectors are derived
 * data: on a width change they are dropped and every row is marked for
 * re-embedding. Returns true when the vectors were reset.
 */
function ensureVectorTable(db, dims, log) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(VEC_TABLE);
  const have = row ? Number(row.sql.match(/FLOAT\[(\d+)\]/i)?.[1]) : null;
  // Default L2 distance. The store saves unit-length vectors, so the L2 order is
  // the cosine order, and L2 measured 4x faster here (2.8 ms vs 11.7 ms at 10k rows).
  const create = () =>
    db.exec(`CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${dims}])`);

  if (have === dims) {
    // Heal what a crash or a spell without the extension can leave behind.
    db.transaction(() => {
      db.exec(`DELETE FROM ${VEC_TABLE} WHERE rowid NOT IN (SELECT seq FROM memories)`);
      db.exec(`UPDATE memories SET embedding_sig = NULL
                WHERE embedding_sig IS NOT NULL AND seq NOT IN (SELECT rowid FROM ${VEC_TABLE})`);
    })();
    return false;
  }
  if (row) {
    // vec0 DDL commits on its own, so the order makes a crash safe: once the
    // table is gone, the same-width branch above clears the signatures next open.
    db.exec(`DROP TABLE ${VEC_TABLE}`);
    create();
    db.exec('UPDATE memories SET embedding_sig = NULL WHERE embedding_sig IS NOT NULL');
    log.warn(`[store] vector width changed from ${have} to ${dims}. All vectors were dropped; every memory needs a new embedding.`);
    return true;
  }
  create();
  db.exec('UPDATE memories SET embedding_sig = NULL WHERE embedding_sig IS NOT NULL');
  return false;
}

/**
 * @param {object} opts
 * @param {string} opts.path  SQLite file, or ':memory:'
 * @param {number} opts.dims  embedding width
 * @param {{warn: (m: string) => void, info: (m: string) => void}} [opts.log]
 * @param {(db: object) => void} [opts.loadVector]  test seam for "no extension"
 * @param {string} [opts.migrationsDir]  test seam
 */
export async function openStore({ path, dims, log = console, loadVector = sqliteVec.load, migrationsDir = MIGRATIONS_DIR } = {}) {
  if (typeof path !== 'string' || !path) throw new StoreError('openStore: path is required');
  if (!Number.isInteger(dims) || dims < 1) throw new StoreError(`openStore: dims must be a positive integer, got ${dims}`);

  const file = path === ':memory:' ? path : resolve(path);
  if (file !== ':memory:') await mkdir(dirname(file), { recursive: true });

  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const vectorSupported = tryLoadVector(db, loadVector, log);
    await runMigrations(db, migrationsDir, log);
    const vectorsReset = vectorSupported ? ensureVectorTable(db, dims, log) : false;
    return createMemoryStore({ db, dims, vectorSupported, vectorsReset });
  } catch (err) {
    db.close();
    throw err;
  }
}
