// db/migrate-sqlite.js
// Mirror of db/migrate.js for the SQLite backend. Applies every .sql file in
// db/migrations-sqlite/ exactly once, recording applied versions in a
// schema_migrations table inside the same DB file.

import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../lib/helpers/logger.js';

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = path.join(path.dirname(__filename), 'migrations-sqlite');

export async function runSqliteMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort();
  const applied = new Set(
    db.prepare(`SELECT version FROM schema_migrations`).all().map(r => r.version)
  );
  const pending = files.filter(f => !applied.has(f));

  if (!pending.length) {
    logger.info('[sqlite-migrate] Nothing to apply.');
    return;
  }

  // better-sqlite3 transactions are synchronous; one tx per migration so a
  // failure doesn't leave the DB half-applied.
  const recordApplied = db.prepare(`INSERT INTO schema_migrations (version) VALUES (?)`);
  for (const file of pending) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const tx  = db.transaction(() => {
      db.exec(sql);
      recordApplied.run(file);
    });
    try {
      tx();
      logger.info(`[sqlite-migrate] Applied: ${file}`);
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
}
