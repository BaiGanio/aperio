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

  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort();

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
