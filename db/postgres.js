// db/postgres.js
// Postgres backend for Aperio — barrel re-export. Implementation lives in
// db/postgres/{mappers,search,store}.js; see db/postgres/store.js for the
// storage-layout notes (mirrors db/sqlite.js's split).

export { PostgresStore, assertNonDefaultDbUrl } from './postgres/store.js';
export { LOCALE_TO_PG_CONFIG, localeToPgConfig } from './postgres/mappers.js';
