// db/index.js
// Resolves which vector backend to use at startup.
//
// Resolution order:
//   1. DB_BACKEND env var — 'lancedb' | 'postgres'  (explicit, wins always)
//   2. Auto-detect       — ping Docker; Postgres if reachable, else LanceDB
//   3. Safety fallback   — LanceDB (always works, zero config)

import { execSync } from 'child_process';
import { PostgresStore } from './postgres.js';
import { LanceDBStore }  from './lancedb.js';

function isDockerAvailable() {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function resolveBackend() {
  const explicit = process.env.DB_BACKEND?.toLowerCase();

  if (explicit === 'postgres' || explicit === 'lancedb') {
    console.error(`[aperio:db] Backend set via DB_BACKEND: ${explicit}`);
    return explicit;
  }
  if (explicit) {
    console.error(`[aperio:db] Unknown DB_BACKEND "${explicit}" — falling back to auto-detect`);
  }

  if (isDockerAvailable()) {
    console.error('[aperio:db] Docker detected → using Postgres (pgvector)');
    return 'postgres';
  }

  console.error('[aperio:db] Docker not found → using LanceDB (no setup required)');
  return 'lancedb';
}

export async function createVectorStore() {
  const backend = resolveBackend();

  if (backend === 'postgres') {
    try {
      const store = await PostgresStore.init();
      console.error('✅ Connected to Aperio database (Postgres)');
      return store;
    } catch (err) {
      console.error('[aperio:db] Postgres failed — falling back to LanceDB:', err.message);
    }
  }

  const store = await LanceDBStore.init();
  console.error('✅ Connected to Aperio database (LanceDB)');
  return store;
}