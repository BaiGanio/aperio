// db/sqlite/vectorMeta.js
// vec_meta bookkeeping and physical vector-storage management (SQLite half):
// per-store embedding signature, the reindex lease state machine's storage
// side, and resizing the vec0 virtual tables when EMBEDDING_DIMS changes.
//
// Split out of db/sqlite/store.js by S3.2 (aperio-reset) — the method bodies
// and the two module-level tables moved verbatim. The RULES of the state
// machine deliberately live in lib/helpers/vecMeta.js so the two backends
// cannot drift on them; this file is only the SQLite storage side. The
// Postgres twin is db/postgres/vectorMeta.js.
import { fallbackVecTableSql } from './vecSupport.js';
import { nowIso } from './mappers.js';

// sqlite-vec's vec0 rejects FLOAT[N] columns wider than this at CREATE time.
const SQLITE_VEC_MAX_DIMS = 8192;

const SQLITE_VEC_TABLES = Object.freeze({
  memories:      'vec_memories',
  wiki:          'vec_wiki',
  self_memories: 'vec_self_memories',
  codegraph:     'vec_cg_symbols',
  docgraph:      'vec_docgraph_chunks',
});

export const withVectorMeta = (Base) => class extends Base {
  // ── vec_meta: per-store signature + reindex state (issue #287, WS1) ───────
  // Kept deliberately dumb — the state machine itself lives in
  // lib/helpers/vecMeta.js so both backends can't drift on the rules.

  async listVecMeta() {
    return this.db.prepare(
      `SELECT store_name, signature, dims, status, vectors_cleared, reindex_owner, reindex_expires_at, updated_at
         FROM vec_meta ORDER BY store_name`
    ).all();
  }

  async getVecMeta(storeName) {
    return this.db.prepare(
      `SELECT store_name, signature, dims, status, vectors_cleared, reindex_owner, reindex_expires_at, updated_at
         FROM vec_meta WHERE store_name = ?`
    ).get(storeName) ?? null;
  }

  // Insert only if absent — seeding must never clobber the recorded state of a
  // store that already has one (that state is what says "these vectors are in
  // the old space and still need reindexing").
  async seedVecMeta(storeName, { signature, dims, status = "current" }) {
    const info = this.db.prepare(
      `INSERT INTO vec_meta (store_name, signature, dims, status, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(store_name) DO NOTHING`
    ).run(storeName, signature, dims, status, nowIso());
    return info.changes > 0;
  }

  // Partial update; only the keys present in `patch` are written, so a caller
  // flipping status can't accidentally overwrite the recorded signature.
  // Atomically take ownership of a store's reindex. Returns the status the row
  // held *before* the claim, and whether this reindex has already cleared the
  // store's old-space vectors — the caller must clear them exactly once, and
  // clearing again mid-run would destroy work an earlier run completed.
  //
  // Claiming a `stale` store starts a fresh reindex, so the checkpoint resets
  // to false in the same atomic write that flips the status: a crash between
  // the two would otherwise resume into "already cleared" with every old
  // vector still in place.
  //
  // Runs inside an immediate transaction — the write lock is taken up front
  // rather than on first write, so two processes racing this call cannot both
  // read the row before either acquires it. A deferred transaction (the
  // default) lets that happen: both readers proceed, and the loser hits
  // SQLITE_BUSY upgrading its own transaction to a write lock instead of
  // cleanly returning { claimed: false } — turning the exact concurrent-runner
  // case this lease exists for into a thrown error.
  //
  // `expectedSignature` closes a race the ownership check alone cannot: if a
  // configuration change retargets this row between the caller listing it as
  // pending and this claim running, the row's signature no longer matches what
  // the caller is about to reindex toward. Claiming and completing it anyway
  // would finalize the row as current under the caller's *old* target while it
  // actually holds vectors for neither space — cross-space comparison for
  // whoever reads it next. Passing it through this same predicate keeps the
  // check atomic with the claim; omitted (undefined), the check is skipped for
  // callers that only care about ownership, not target (existing direct tests).
  async claimVecMetaReindex(storeName, owner, leaseMs, expectedSignature = undefined) {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT status, signature, vectors_cleared, reindex_owner, reindex_expires_at FROM vec_meta WHERE store_name = ?`
      ).get(storeName);
      if (!row || row.status === 'current') return { claimed: false, previousStatus: row?.status ?? null };

      if (expectedSignature !== undefined && row.signature !== expectedSignature) {
        return { claimed: false, previousStatus: row.status, retargeted: true };
      }

      // A live lease held by someone else wins; an expired one is up for grabs
      // so a crashed runner cannot block the store forever.
      const heldByOther = row.reindex_owner && row.reindex_owner !== owner;
      const leaseLive = row.reindex_expires_at && row.reindex_expires_at > nowIso();
      if (heldByOther && leaseLive) {
        return { claimed: false, previousStatus: row.status, heldBy: row.reindex_owner };
      }

      const vectorsCleared = row.status === 'stale' ? false : !!row.vectors_cleared;
      this.db.prepare(
        `UPDATE vec_meta
            SET status = 'reindexing', vectors_cleared = ?, reindex_owner = ?, reindex_expires_at = ?, updated_at = ?
          WHERE store_name = ?`
      ).run(vectorsCleared ? 1 : 0, owner, new Date(Date.now() + leaseMs).toISOString(), nowIso(), storeName);
      return { claimed: true, previousStatus: row.status, vectorsCleared };
    });
    return claim.immediate();
  }

  // Records that this reindex has cleared the store's old-space vectors. Called
  // immediately after the clear, so a crash can only ever leave a window in
  // which the next runner re-clears a store that is already empty.
  async markVectorsCleared(storeName) {
    const info = this.db.prepare(
      `UPDATE vec_meta SET vectors_cleared = 1, updated_at = ? WHERE store_name = ?`
    ).run(nowIso(), storeName);
    return info.changes > 0;
  }

  // Extends a lease we still hold. False means someone else took the store —
  // the caller must stop rather than write into a reindex it no longer owns.
  async renewVecMetaLease(storeName, owner, leaseMs) {
    const info = this.db.prepare(
      `UPDATE vec_meta SET reindex_expires_at = ?, updated_at = ?
        WHERE store_name = ? AND reindex_owner = ?`
    ).run(new Date(Date.now() + leaseMs).toISOString(), nowIso(), storeName, owner);
    return info.changes > 0;
  }

  async releaseVecMetaReindex(storeName, owner) {
    const info = this.db.prepare(
      `UPDATE vec_meta SET reindex_owner = NULL, reindex_expires_at = NULL, updated_at = ?
        WHERE store_name = ? AND reindex_owner = ?`
    ).run(nowIso(), storeName, owner);
    return info.changes > 0;
  }

  // Completes a reindex only if this owner still holds the store. One
  // statement so there is no gap between checking ownership and flipping the
  // status for another writer to land in — the failure mode a separate
  // renew-then-markCurrent pair leaves open. The owner check alone is enough
  // to catch a reassigned target: markStaleWhereChanged() clears reindex_owner
  // in the same write that moves a store to a new signature, so a target
  // change always shows up here as an owner mismatch — checking signature too
  // would additionally require the row to already carry the exact string this
  // call is completing to, which does not hold for every valid caller (a
  // store nudged into `reindexing` without markStaleWhereChanged first
  // recording that target, for instance).
  async finalizeVecMetaReindex(storeName, owner, { signature, dims }) {
    const info = this.db.prepare(
      `UPDATE vec_meta
          SET status = 'current', vectors_cleared = 0, reindex_owner = NULL, reindex_expires_at = NULL,
              signature = ?, dims = ?, updated_at = ?
        WHERE store_name = ? AND reindex_owner = ?`
    ).run(signature, dims, nowIso(), storeName, owner);
    return info.changes > 0;
  }

  async updateVecMeta(storeName, patch) {
    const allowed = ["signature", "dims", "status", "vectors_cleared", "reindex_owner", "reindex_expires_at"];
    const cols = allowed.filter(k => Object.hasOwn(patch, k));
    if (!cols.length) return false;
    const sets = cols.map(c => `${c} = ?`).join(", ");
    // better-sqlite3 refuses to bind booleans; the shared state machine speaks
    // in booleans so both backends can take the same patch object.
    const values = cols.map(c => (typeof patch[c] === "boolean" ? (patch[c] ? 1 : 0) : patch[c]));
    const info = this.db.prepare(
      `UPDATE vec_meta SET ${sets}, updated_at = ? WHERE store_name = ?`
    ).run(...values, nowIso(), storeName);
    return info.changes > 0;
  }

  // Clears one logical store's vectors (issue #287, WS1). The reindex driver
  // calls this when a stale store starts reindexing, so the store's rows show
  // up in the existing "without embeddings" scans and get re-embedded.
  async clearStoreEmbeddings(storeName) {
    const table = SQLITE_VEC_TABLES[storeName];
    if (!table) throw new Error(`clearStoreEmbeddings: unknown store "${storeName}"`);
    this.db.prepare(`DELETE FROM ${table}`).run();
  }

  async clearAllEmbeddings() {
    for (const table of Object.values(SQLITE_VEC_TABLES)) {
      this.db.prepare(`DELETE FROM ${table}`).run();
    }
  }

  // Drops and recreates every vec0 sidecar table at the new dimension. Needed
  // because vec0 columns are FLOAT[N] fixed at CREATE time — a plain
  // clearAllEmbeddings() empties the rows but leaves every subsequent insert
  // at the old N failing once EMBEDDING_DIMS changes.
  async resizeVectorStorage(dims) {
    if (!Number.isInteger(dims) || dims <= 0 || dims > SQLITE_VEC_MAX_DIMS) {
      throw new Error(`resizeVectorStorage: invalid dims ${dims} (must be an integer from 1 to ${SQLITE_VEC_MAX_DIMS})`);
    }
    const tables = Object.values(SQLITE_VEC_TABLES);
    // sqlite-vec's vec0 CREATE VIRTUAL TABLE does not participate in
    // SQLite's transaction rollback (confirmed empirically: its shadow-table
    // setup commits independently of an enclosing BEGIN/ROLLBACK), so this
    // loop can't be made atomic with a wrapping transaction the way ordinary
    // DDL could. The dims-range check above is the real defense — it
    // eliminates the only failure this loop was actually hitting in
    // practice (a width above sqlite-vec's max). Anything else that fails
    // mid-loop is fatal with a diagnostic naming exactly which tables were
    // and weren't replaced, rather than continuing into a half-resized DB.
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      try {
        this.db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
        // Without the extension the sidecar is an ordinary table of the same
        // name and width, so the resize keeps the schema self-consistent (and
        // getVectorDims() readable) even though nothing will KNN-query it.
        this.db.prepare(
          this.vectorSupported
            ? `CREATE VIRTUAL TABLE ${table} USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${dims}])`
            : fallbackVecTableSql(table, dims)
        ).run();
      } catch (err) {
        const done = tables.slice(0, i);
        const notDone = tables.slice(i);
        throw new Error(
          `resizeVectorStorage: failed replacing ${table} (${err.message}) — already replaced at ${dims} dims: [${done.join(", ") || "none"}]; not replaced: [${notDone.join(", ")}]`
        );
      }
    }
  }

  // Physical width of vec_memories, read from the table's own CREATE SQL
  // rather than trusting the stored fingerprint — a freshly-created DB
  // (migrations hardcode FLOAT[1024]) or a DB upgraded from before
  // resizeVectorStorage existed can both have a fingerprint that already
  // claims the configured dims without storage ever having been resized.
  async getVectorDims() {
    const row = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_memories'`
    ).get();
    const match = row?.sql?.match(/FLOAT\[(\d+)\]/);
    return match ? parseInt(match[1], 10) : null;
  }
};
