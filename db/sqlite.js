// db/sqlite.js
// SQLite backend for Aperio — barrel re-export. Implementation lives in
// db/sqlite/{mappers,encryption,wiki,search,store}.js; see db/sqlite/store.js
// for the storage-layout and search-semantics notes.

export { SqliteStore } from './sqlite/store.js';
export { _decryptDbFileInPlace } from './sqlite/encryption.js';
