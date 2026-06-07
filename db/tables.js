// db/tables.js
// Whitelist of human-meaningful data tables exposed by the DB browser.
//
// Table names cannot be SQL-parameterized, so this list is the single source of
// truth that both stores and the API routes validate against. Internal plumbing
// — FTS5 index tables, vec_* embedding tables, schema_migrations — is excluded.
// SQLite and Postgres share this schema, so one list serves both backends.

export const DB_TABLES = [
  { name: 'memories',               label: 'Memories' },
  { name: 'wiki_articles',          label: 'Wiki articles' },
  { name: 'wiki_article_revisions', label: 'Wiki revisions' },
  { name: 'wiki_article_sources',   label: 'Wiki sources' },
  { name: 'settings',               label: 'Settings' },
  { name: 'cg_repos',               label: 'Codegraph repos' },
  { name: 'cg_files',               label: 'Codegraph files' },
  { name: 'cg_symbols',             label: 'Codegraph symbols' },
  { name: 'cg_edges',               label: 'Codegraph edges' },
];

const DB_TABLE_NAMES = new Set(DB_TABLES.map(t => t.name));

export function isAllowedTable(name) {
  return DB_TABLE_NAMES.has(name);
}
