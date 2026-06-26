// db/index.js
// Resolves which storage backend to use at startup.
//
// Resolution order:
//   1. DB_BACKEND env var — 'postgres' | 'sqlite'   (explicit, wins always)
//   2. Auto-detect       — ping Docker; Postgres if reachable, else SQLite
//   3. Safety fallback   — SQLite (zero-config; works without Docker)

import { spawnSync } from "child_process";
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

function isPostgresContainerRunning() {
  try {
    const result = spawnSync("docker", [
      "ps", "--filter", "name=aperio_db",
      "--filter", "status=running",
      "--format", "{{.Names}}"
    ], { timeout: 2000, stdio: "pipe" });
    return result.status === 0 && result.stdout.toString().trim() === 'aperio_db';
  } catch {
    return false;
  }
}

function resolveBackend() {
  const explicit = process.env.DB_BACKEND?.toLowerCase();

  if (explicit && SUPPORTED.has(explicit)) {
    logger.info(`[aperio:db] Backend set via DB_BACKEND: ${explicit}`);
    return explicit;
  }
  if (explicit) {
    // A typo'd/unsupported value shouldn't silently connect to a Postgres the
    // user never configured just because Docker happens to be up. Fall back to
    // the zero-config safe default (SQLite) rather than auto-detecting.
    logger.warn(`[aperio:db] Unknown DB_BACKEND "${explicit}" — falling back to SQLite (supported: ${[...SUPPORTED].join(', ')})`);
    return 'sqlite';
  }

  if (isDockerAvailable()) {
    if (isPostgresContainerRunning()) {
      logger.info('[aperio:db] Docker + aperio_db container running → using Postgres (pgvector)');
      return 'postgres';
    }
    logger.info('[aperio:db] Docker detected but aperio_db container not running → using SQLite (run `docker compose -f docker/docker-compose.yml --env-file .env up -d` to use Postgres)');
    return 'sqlite';
  }

  // Default to SQLite — zero-config, single file, full feature parity with
  // Postgres including codegraph.
  logger.info('[aperio:db] Using SQLite (zero-config; single-file DB)');
  return 'sqlite';
}

export async function createVectorStore() {
  return initBackend(resolveBackend());
}
