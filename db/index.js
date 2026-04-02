// db/index.js
// Resolves which vector backend to use at startup.
//
// Resolution order:
//   1. DB_BACKEND env var — 'lancedb' | 'postgres'  (explicit, wins always)
//   2. Auto-detect       — ping Docker; Postgres if reachable, else LanceDB
//   3. Safety fallback   — LanceDB (always works, zero config)

import { existsSync } from 'fs';
import { PostgresStore } from './postgres.js';
import { LanceDBStore }  from './lancedb.js';
let instance = null;
let initializationPromise = null;

export async function getStore() {
  // --- Start Caller Detection ---
  // We create a dummy error to grab the stack trace
  const stack = new Error().stack;
  const stackLines = stack.split('\n');
  
  // Line 0 is 'Error', Line 1 is getStore, Line 2 is the caller
  const callerLine = stackLines[2] || ''; 
  // Clean up the path to show just the filename
  const fileName = callerLine.match(/([^\/]+)\.js/)?.[0] || 'unknown';
  console.error(`[aperio:db] 📥 getStore() called by: ${fileName}`);
  // --- End Caller Detection ---

  // 1. If already initialized, return the instance immediately
  if (instance) return instance;

  // 2. If initialization is already in progress, wait for that same promise
  if (initializationPromise) return initializationPromise;

  // 3. Otherwise, start initialization and save the promise
  initializationPromise = (async () => {
    const backend = resolveBackend();

    if (backend === 'postgres') {
      try {
        instance = await PostgresStore.init();
        console.error('✅ Connected to Aperio database (Postgres)');
        return instance;
      } catch (err) {
        console.error('[aperio:db] Postgres failed — falling back to LanceDB:', err.message);
      }
    }

    instance = await LanceDBStore.init();
    console.error('✅ Connected to Aperio database (LanceDB)');
    return instance;
  })();

  return initializationPromise;
}

export function isDockerAvailable() {
  try {
    // Check Docker socket directly — instant, no subprocess needed
    return existsSync('/var/run/docker.sock');
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