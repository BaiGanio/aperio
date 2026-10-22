// db/migrate-sqlite.js
// Mirror of db/migrate.js for the SQLite backend. Applies every .sql file in
// db/migrations-sqlite/ exactly once, recording applied versions in a
// schema_migrations table inside the same DB file.

import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../lib/helpers/logger.js';
import { rewriteVec0Tables, hasUnrewritableVec0 } from './sqlite/vecSupport.js';

const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = path.join(path.dirname(__filename), 'migrations-sqlite');

// `vectorSupported: false` means sqlite-vec could not be loaded on this
// platform. Every vec0 declaration is then rewritten into an ordinary table of
// the same name and shape so the rest of the schema — triggers referencing the
// sidecars, LEFT JOIN recall queries, embedding writes — applies unchanged.
// See db/sqlite/vecSupport.js for why that is safe.
export async function runSqliteMigrations(db, { vectorSupported = true } = {}) {
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
    let sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    if (!vectorSupported) {
      sql = rewriteVec0Tables(sql);
      // A vec0 declaration this rewriter does not recognise would otherwise be
      // executed as-is and fail with a bare "no such module: vec0". Name the
      // migration instead — the fix is to teach vecSupport.js the new shape.
      if (hasUnrewritableVec0(sql)) {
        throw new Error(
          `Migration ${file} declares a vec0 table in a shape db/sqlite/vecSupport.js `
          + `cannot rewrite, and sqlite-vec is unavailable on this platform.`
        );
      }
    }
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
