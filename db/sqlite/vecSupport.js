// db/sqlite/vecSupport.js — sqlite-vec availability, and the plain-table
// fallback used when the platform has no prebuilt extension.
//
// sqlite-vec ships prebuilt loadable extensions for a fixed platform list
// (darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64). Anything
// else — win32-arm64 today — makes sqliteVec.load() throw. That call used to
// sit uncaught in SqliteStore.init(), so on those platforms Aperio did not
// degrade: it crashed the moment anything opened the database.
//
// The degraded mode here keeps every non-KNN code path intact. The vec0
// sidecars are recreated as ORDINARY tables of the same name and shape, so:
//
//   • the DELETE triggers that reference them still resolve,
//   • the LEFT JOIN vec_* recall/list queries still run (embedding reads NULL),
//   • embedding writes still land (as opaque BLOBs nothing reads back),
//   • getVectorDims() still reads its width, because SQLite stores a column's
//     declared type verbatim and accepts `FLOAT[1024]` as a type name.
//
// Only `embedding MATCH ? AND k = ?` KNN search is impossible, and that path
// is already gated by lib/helpers/vecMeta.js — which consults
// `store.vectorSupported` and serves FTS-only when it is false.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import logger from '../../lib/helpers/logger.js';

// Matches the vec0 sidecar declarations in db/migrations-sqlite/*.sql and the
// one resizeVectorStorage() issues. Deliberately narrow: it only rewrites the
// `rowid INTEGER PRIMARY KEY, embedding FLOAT[N]` shape this repository
// actually uses, so a future vec0 table with a different column list fails
// loudly rather than being silently mangled into something else.
const VEC0_TABLE_RE =
  /CREATE\s+VIRTUAL\s+TABLE\s+(\w+)\s+USING\s+vec0\s*\(\s*rowid\s+INTEGER\s+PRIMARY\s+KEY\s*,\s*embedding\s+FLOAT\[(\d+)\]\s*\)/gi;

// The plain-table stand-in for one vec0 sidecar. The declared type is left as
// FLOAT[N] on purpose — SQLite's flexible typing accepts any type name and
// stores the text verbatim in sqlite_master, which is where getVectorDims()
// reads the store's width from.
export function fallbackVecTableSql(table, dims) {
  return `CREATE TABLE ${table} (rowid INTEGER PRIMARY KEY, embedding FLOAT[${dims}])`;
}

// Rewrites every vec0 declaration in a migration's SQL into its plain-table
// stand-in. A no-op on SQL that declares none.
export function rewriteVec0Tables(sql) {
  return sql.replace(VEC0_TABLE_RE, (_match, table, dims) => fallbackVecTableSql(table, dims));
}

// True when the SQL still contains a vec0 declaration this module could not
// rewrite — i.e. one that does not match the supported shape. Callers use it
// to fail loudly instead of executing SQL the extension cannot run.
export function hasUnrewritableVec0(sql) {
  return /USING\s+vec0\s*\(/i.test(sql);
}

// Loads the sqlite-vec extension into an open better-sqlite3 handle.
//
// Returns true when vector search is available. Returns false — without
// throwing — when the platform has no prebuilt extension, which is a
// supported degraded mode, not an error. A load that fails for any *other*
// reason is still reported at warn level and still degrades rather than
// crashing a boot: FTS-only recall beats no database at all.
// The verdict is a property of the machine, not of the handle, so a boot that
// opens more than one connection (the reconcile pre-flight below, then the
// store's own) would otherwise repeat the same warning. Report it once.
let loadFailureReported = false;

export function loadVectorExtension(db) {
  // allow_load_extension is required for the extension APIs; binding keeps the
  // method present for sqlite-vec's own feature probe.
  db.loadExtension = db.loadExtension.bind(db);
  try {
    sqliteVec.load(db);
    return true;
  } catch (err) {
    if (loadFailureReported) return false;
    loadFailureReported = true;
    const unsupportedPlatform = /Unsupported platform for sqlite-vec/i.test(err.message);
    logger.warn(
      unsupportedPlatform
        ? `[sqlite-vec] no prebuilt extension for ${process.platform}-${process.arch} — `
          + `vector (semantic) search is disabled; recall falls back to full-text search. `
          + `Everything else works normally.`
        : `[sqlite-vec] extension failed to load (${err.message}) — `
          + `vector (semantic) search is disabled; recall falls back to full-text search.`
    );
    return false;
  }
}

// ── Reconciling a database whose sidecars were built on the other platform ──
//
// The rewrite above only covers migrations that have not run yet. A database
// created where sqlite-vec works and then opened where it does not (copied to
// a win32-arm64 machine, a synced install folder) has every migration already
// recorded, so nothing rewrites anything and the vec0 sidecars survive as
// virtual tables whose module is gone. Everything then fails with
// `no such module: vec0` — not only KNN, but the ordinary `LEFT JOIN vec_*`
// reads and counts — which is the opposite of the promised full-text-only mode.
// The mirror case is just as bad: sidecars degraded to plain tables keep their
// shape when the database returns to a supported platform, so KNN stays broken
// with no warning.
//
// So the physical kind of each sidecar is reconciled against what this machine
// can actually run, once, at open time.
//
// Both directions destroy the stored vectors, and neither can avoid it: a vec0
// table cannot be read without its module, and a plain table's blobs were never
// in a vec0 index. That is recoverable — vectors are derived data, and
// SqliteStore.rebuiltVectorStores tells lib/helpers/embeddings.js to mark the
// stores stale so the reindex driver refills them.

// Reconciliation needs its own connections: deleting a row from sqlite_master
// does not invalidate the schema already cached by the connection that deleted
// it (confirmed empirically — a CREATE of the same name still reports "table
// already exists"), so the repair must finish and reconnect before the store's
// real handle is opened.

// The sidecars the migrations declare, in the order db/sqlite/store.js lists
// them. Mirrors SQLITE_VEC_TABLES there; the pairing is asserted by tests.
//
// `migration` is the file that creates the table. It is what tells an absent
// sidecar apart from one that legitimately does not exist yet: if the
// migration is recorded in schema_migrations but the table is missing, no
// migration will ever recreate it, so this module has to.
const SIDECAR_TABLES = Object.freeze({
  memories:      { table: 'vec_memories',         migration: '001_core.sql' },
  wiki:          { table: 'vec_wiki',             migration: '001_core.sql' },
  self_memories: { table: 'vec_self_memories',    migration: '006_self_memories.sql' },
  codegraph:     { table: 'vec_cg_symbols',       migration: '003_codegraph.sql' },
  docgraph:      { table: 'vec_docgraph_chunks',  migration: '004_docgraph.sql' },
});

// Default width for a sidecar that has to be created from nothing, so there is
// no CREATE text to read it from. Any mismatch with the running configuration
// is caught and repaired by lib/helpers/embeddings.js, which compares
// getVectorDims() against EMBEDDING_DIMS on every boot and resizes.
const DEFAULT_DIMS = 1024;

// Migration versions already applied. An empty set (including when the table
// does not exist yet) means nothing is recorded, so no sidecar counts as
// missing — the migration runner is still going to create them.
function appliedMigrations(db) {
  try {
    return new Set(
      db.prepare(`SELECT version FROM schema_migrations`).all().map(r => r.version)
    );
  } catch {
    return new Set();
  }
}

// LIKE treats `_` as a single-character wildcard and every sidecar name
// contains several, so the prefix has to be escaped or `vec_memories_%` would
// also match tables it has no business dropping.
function likeEscape(name) {
  return name.replace(/[\\%_]/g, ch => `\\${ch}`);
}

// What each sidecar physically is right now: a vec0 virtual table, an ordinary
// table, or `missing` — present in no form even though its migration has run.
//
// `missing` is not a theoretical state. Every statement here autocommits (vec0
// in particular does not participate in transaction rollback at all — see the
// note in SqliteStore.resizeVectorStorage), so a crash, a kill, or a failed
// CREATE part-way through a rebuild leaves a sidecar dropped and not yet
// recreated. Nothing else would ever put it back: readSidecarKinds used to
// skip absent tables, and the migration that declares it is already recorded,
// so the next boot would sail past and every write or join against it would
// fail with "no such table". Reporting it here is what makes an interrupted
// rebuild recoverable on the next open.
//
// A sidecar whose migration has NOT run is skipped — the migration runner is
// about to create it, in whichever form this platform needs.
function readSidecarKinds(db) {
  const applied = appliedMigrations(db);
  const out = [];
  for (const [storeName, { table, migration }] of Object.entries(SIDECAR_TABLES)) {
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`
    ).get(table);
    if (!row?.sql) {
      if (applied.has(migration)) out.push({ storeName, table, kind: 'missing', dims: null });
      continue;
    }
    out.push({
      storeName,
      table,
      kind: /USING\s+vec0/i.test(row.sql) ? 'vec0' : 'plain',
      dims: parseInt(row.sql.match(/FLOAT\[(\d+)\]/)?.[1] ?? '0', 10) || null,
    });
  }
  return out;
}

// The one authoritative width for this database.
//
// vec_memories decides it whenever it has one, and not merely because it is
// first: SqliteStore.getVectorDims() reads that table and nothing else, so it
// is already the width the rest of the system believes the database has, and
// lib/helpers/embeddings.js compares exactly that against EMBEDDING_DIMS on
// every boot. Agreeing with it here is what lets that comparison finish an
// interrupted resize instead of missing it. resizeVectorStorage() also
// replaces the sidecars in this same order, so vec_memories additionally
// carries the *target* width of a resize that died part-way through.
//
// The remaining fallbacks cover a database where vec_memories is the sidecar
// that is missing: any surviving width beats inventing one.
function resolveDims(kinds) {
  const memories = kinds.find(k => k.storeName === 'memories');
  return memories?.dims ?? kinds.find(k => k.dims)?.dims ?? DEFAULT_DIMS;
}

// Removes a vec0 table whose module cannot be loaded. DROP TABLE is not an
// option — it calls into the module's xDestroy and fails the same way every
// other statement does — so the schema row is deleted directly and the shadow
// tables vec0 leaves behind (…_info, …_chunks, …_rowids, …_vector_chunks00)
// are dropped as the ordinary tables they are. Writing to sqlite_master needs
// both writable_schema and better-sqlite3's unsafe mode, and both are turned
// back off before returning.
function removeOrphanedVec0Table(db, table) {
  const shadows = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'`
  ).all(`${likeEscape(table)}\\_%`).map(r => r.name);

  db.unsafeMode(true);
  try {
    db.pragma('writable_schema = ON');
    db.prepare(`DELETE FROM sqlite_master WHERE name = ?`).run(table);
    for (const shadow of shadows) db.exec(`DROP TABLE IF EXISTS "${shadow}"`);
    db.pragma('writable_schema = OFF');
  } finally {
    db.unsafeMode(false);
  }
  return shadows.length;
}

// Brings every sidecar in an existing database into the shape this machine can
// run. Returns the logical store names whose vectors were destroyed, so the
// caller can have them reindexed; an empty array means nothing needed doing,
// which is the overwhelmingly common case.
//
// `dbPath` rather than an open handle, deliberately: see the note above about
// the schema cache. Never called for `:memory:` or a brand-new file — there is
// nothing there to reconcile.
//
// `vectorSupported` is probed here by default, because this runs before the
// store's own handle exists; pass it explicitly when the caller already knows
// (or needs to reconcile toward a specific verdict). Returns
// `{ vectorSupported, rebuilt }` — the caller still loads the extension into
// its own handle, which is where the vec0 SQL functions have to be registered.
export function reconcileVecSidecars(dbPath, { vectorSupported = null } = {}) {
  let db = new Database(dbPath);
  try {
    if (vectorSupported === null) vectorSupported = loadVectorExtension(db);
    else if (vectorSupported) loadVectorExtension(db);

    const wantKind = vectorSupported ? 'vec0' : 'plain';
    const kinds = readSidecarKinds(db);
    const dims = resolveDims(kinds);

    // Wrong kind, absent, or the right kind at the wrong width.
    //
    // That last case is what an interrupted resizeVectorStorage() leaves
    // behind. It replaces the five sidecars one at a time and cannot be wrapped
    // in a transaction — vec0's CREATE VIRTUAL TABLE commits its shadow-table
    // setup independently of any enclosing BEGIN — so a throw or a kill part-way
    // through leaves the early tables at the new width and the rest at the old
    // one. Every sidecar is then the right *kind*, so a kind-only check finds
    // nothing to do and returns; and because getVectorDims() reads vec_memories
    // alone, and vec_memories is the first table the resize replaced, the
    // provider check on the next boot sees the width it expects and resizes
    // nothing either. The database stays split forever, and reindexing the
    // stores left at the old width fails on every row — a vec0 table rejects a
    // vector of the wrong length — so they never leave `reindexing`. Nothing
    // else in the system looks at the other four widths, which makes this the
    // only place the split can be caught.
    const todo = kinds.filter(k => k.kind !== wantKind || (k.dims !== null && k.dims !== dims));
    if (!todo.length) return { vectorSupported, rebuilt: [] };

    const missing = todo.filter(k => k.kind === 'missing');
    const converted = todo.filter(k => k.kind !== 'missing' && k.kind !== wantKind);
    const rewidened = todo.filter(k => k.kind === wantKind);
    const names = list => list.map(k => k.table).join(', ');

    if (vectorSupported) {
      // → vec0. An ordinary table drops normally, so one connection does. No
      // transaction: vec0's CREATE VIRTUAL TABLE commits its shadow-table setup
      // independently of any enclosing BEGIN (documented in
      // SqliteStore.resizeVectorStorage), so wrapping this would only look
      // atomic. What makes an interruption safe is that it can only leave a
      // sidecar dropped, which the `missing` detection above recovers next boot.
      for (const { table } of todo) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
        db.exec(`CREATE VIRTUAL TABLE ${table} USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${dims}])`);
      }
    } else {
      // → plain. Removing a vec0 table means schema surgery, and that has to
      // land and the connection be dropped before the replacements can be
      // created — a connection does not see its own sqlite_master deletions.
      let shadowCount = 0;
      for (const { table } of converted) shadowCount += removeOrphanedVec0Table(db, table);
      db.close();

      db = new Database(dbPath);
      // Plain DDL does roll back, so the replacements land as one unit. The
      // DROP covers the wrong-width sidecars, which are ordinary tables that
      // are still very much present — the surgery above only removed the vec0
      // ones, and a name it removed no-ops here.
      db.transaction(() => {
        for (const { table } of todo) {
          db.exec(`DROP TABLE IF EXISTS ${table}`);
          db.exec(fallbackVecTableSql(table, dims));
        }
      })();

      if (converted.length) {
        logger.warn(
          `[sqlite-vec] this database was created where the extension is available, but it cannot load here. `
          + `${converted.length} vec0 sidecar(s) (+${shadowCount} internal tables) were replaced with plain tables `
          + `so the database stays usable: ${names(converted)}. `
          + `Their embeddings are gone and recall is full-text only on this machine.`
        );
      }
    }

    if (vectorSupported && converted.length) {
      logger.warn(
        `[sqlite-vec] ${converted.length} vector sidecar(s) were left as plain tables by a machine without the `
        + `extension and have been rebuilt as vec0: ${names(converted)}. `
        + `Their embeddings are gone and will be reindexed in the background.`
      );
    }
    if (rewidened.length) {
      logger.warn(
        `[sqlite-vec] ${rewidened.length} vector sidecar(s) did not match the database's width of ${dims} dims — `
        + `almost certainly a dimension change interrupted part-way through. Rebuilt at ${dims}: ${names(rewidened)}. `
        + `Their embeddings are gone and will be reindexed in the background.`
      );
    }
    if (missing.length) {
      logger.warn(
        `[sqlite-vec] ${missing.length} vector sidecar(s) were absent although their migration had already run — `
        + `an earlier rebuild was almost certainly interrupted. Recreated as ${wantKind}: ${names(missing)}. `
        + `Their embeddings are gone and will be reindexed in the background.`
      );
    }
    return { vectorSupported, rebuilt: todo.map(k => k.storeName) };
  } finally {
    try { db.close(); } catch { /* already closed by the → plain path */ }
  }
}

export const _SIDECAR_TABLES = SIDECAR_TABLES;
