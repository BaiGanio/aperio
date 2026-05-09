// db/migrate.js
// Runs pending SQL migrations against Postgres and tracks them in schema_migrations.
//
// Bootstrap: if memories table exists but schema_migrations is empty (pre-runner DB),
// we detect which migrations are already applied from the live schema and mark them
// without re-running them — so existing hand-run installs are not disrupted.

import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../lib/helpers/logger.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  const files = await migrationFiles();
  await bootstrapIfNeeded(pool, files);

  const { rows } = await pool.query(`SELECT version FROM schema_migrations ORDER BY version`);
  const applied  = new Set(rows.map(r => r.version));
  const pending  = files.filter(f => !applied.has(f));

  if (!pending.length) return;

  for (const file of pending) {
    const sql    = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      logger.info(`[migrate] Applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function migrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter(f => f.endsWith('.sql')).sort();
}

// For databases that were initialized by hand before the runner existed,
// detect applied state from live schema and mark without re-running.
async function bootstrapIfNeeded(pool, files) {
  const { rows: existing } = await pool.query(`SELECT version FROM schema_migrations`);
  if (existing.length > 0) return; // already tracked — nothing to bootstrap

  const { rows: [{ exists: memoriesExists }] } = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'memories'
    )
  `);
  if (!memoriesExists) return; // fresh DB — let migrations run normally

  // memories table is there but tracker is empty: hand-run install.
  // Determine which migrations are already reflected in the schema.
  const { rows: [{ exists: embeddingExists }] } = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memories' AND column_name = 'embedding'
    )
  `);

  const detectors = {
    '001_init.sql':     () => true,
    '002_pgvector.sql': () => embeddingExists,
  };

  for (const file of files) {
    const isApplied = detectors[file]?.();
    if (isApplied) {
      await pool.query(
        `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
        [file]
      );
      logger.info(`[migrate] Bootstrap: marked ${file} as applied`);
    } else {
      break; // stop at first unapplied — keep ordering intact
    }
  }
}
