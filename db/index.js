// db/index.js
// Resolves which storage backend to use at startup.
//
// Resolution order:
//   1. DB_BACKEND env var — 'postgres' | 'sqlite'   (explicit, wins always)
//   2. Auto-detect       — ping Docker; Postgres if reachable, else SQLite
//   3. Safety fallback   — SQLite (zero-config; works without Docker)
//
// Phase 4 of the LanceDB → SQLite migration: LanceDB has been removed. Users
// with existing .lancedb/ data should run `node db/migrate-from-lancedb.js`
// to move their memories + wiki across (requires temporarily installing the
// optional dep @lancedb/lancedb).

import { spawnSync } from "child_process";
import { existsSync, statSync, readdirSync } from "fs";
import path from "path";
import { PostgresStore } from './postgres.js';
import { SqliteStore }   from './sqlite.js';
import logger, { logError } from '../lib/helpers/logger.js';

const SUPPORTED = new Set(['postgres', 'sqlite']);

let instance = null;
let initializationPromise = null;

async function initBackend(backend) {
  if (backend === 'postgres') {
    const store = await PostgresStore.init();
    logger.info('✅ Connected to Aperio database (Postgres)');
    return store;
  }
  const store = await SqliteStore.init();
  logger.info('✅ Connected to Aperio database (SQLite + sqlite-vec)');
  return store;
}

export async function getStore() {
  if (instance) return instance;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    const backend = resolveBackend();

    // Postgres can fail (no Docker, bad URL, etc.) — fall back to SQLite so
    // the app boots in single-process mode rather than refusing to start.
    if (backend === 'postgres') {
      try {
        instance = await initBackend('postgres');
        return instance;
      } catch (err) {
        logError('[aperio:db] Postgres failed — falling back to SQLite', err);
      }
    }

    instance = await initBackend('sqlite');
    return instance;
  })();

  return initializationPromise;
}

export function isDockerAvailable() {
  try {
    const result = spawnSync("docker", ["info"], {
      timeout: 2000,
      stdio: "pipe",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function resolveBackend() {
  const explicit = process.env.DB_BACKEND?.toLowerCase();

  if (explicit === 'lancedb') {
    logger.warn(
      `[aperio:db] DB_BACKEND=lancedb is no longer supported. ` +
      `Run: node db/migrate-from-lancedb.js  — to move your data into SQLite. ` +
      `Falling back to SQLite for this run.`
    );
    return 'sqlite';
  }
  if (explicit && SUPPORTED.has(explicit)) {
    logger.info(`[aperio:db] Backend set via DB_BACKEND: ${explicit}`);
    return explicit;
  }
  if (explicit) {
    logger.warn(`[aperio:db] Unknown DB_BACKEND "${explicit}" — falling back to auto-detect (supported: ${[...SUPPORTED].join(', ')})`);
  }

  if (isDockerAvailable()) {
    logger.info('[aperio:db] Docker detected → using Postgres (pgvector)');
    return 'postgres';
  }

  // Default to SQLite — zero-config, single file, full feature parity with
  // Postgres including codegraph. If the user has an old .lancedb/ dir but
  // no SQLite DB, surface a one-line hint pointing at the migrator.
  const sqlitePath  = path.resolve(process.env.SQLITE_PATH || './sqlite/aperio.db');
  const lancedbPath = path.resolve(process.env.LANCEDB_PATH || './.lancedb');
  if (existsSync(lancedbPath) && !existsSync(sqlitePath)) {
    try {
      const hasData = readdirSync(lancedbPath).some(name => {
        const full = path.join(lancedbPath, name);
        return statSync(full).isDirectory() && !name.startsWith('.');
      });
      if (hasData) {
        logger.warn(
          `[aperio:db] Found legacy LanceDB data at ${lancedbPath} but no SQLite DB at ${sqlitePath}. ` +
          `Run: node db/migrate-from-lancedb.js  — to move your memories/wiki into SQLite.`
        );
      }
    } catch { /* not fatal — proceed with sqlite */ }
  }

  logger.info('[aperio:db] Using SQLite (zero-config; single-file DB)');
  return 'sqlite';
}

export async function createVectorStore() {
  return initBackend(resolveBackend());
}
