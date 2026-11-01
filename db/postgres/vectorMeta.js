// db/postgres/vectorMeta.js
// vec_meta bookkeeping and physical vector-storage management (Postgres half):
// per-store embedding signature, the reindex lease state machine's storage
// side, and re-typing the pgvector columns (plus rebuilding their HNSW
// indexes) when EMBEDDING_DIMS changes.
//
// Split out of db/postgres/store.js by S3.2 (aperio-reset) — the method bodies
// and the three module-level tables moved verbatim. The RULES of the state
// machine deliberately live in lib/helpers/vecMeta.js so the two backends
// cannot drift on them; this file is only the Postgres storage side. The
// SQLite twin is db/sqlite/vectorMeta.js.
// pgvector's HNSW index type supports at most this many dimensions per
// vector — the vector(N) column type itself allows up to 16000, but an HNSW
// index build on a wider column fails outright.
const PGVECTOR_HNSW_MAX_DIMS = 2000;

// Logical vector store name → the table holding its embedding column, and the
// HNSW index over it. Single source for clearing (all or one) and resizing, so
// a new store can't be added to one path and forgotten in the other. Keys must
// match VECTOR_STORES in lib/helpers/vecMeta.js — a test asserts that.
const PG_VECTOR_TABLES = Object.freeze({
  memories:      'memories',
  wiki:          'wiki_articles',
  self_memories: 'self_memories',
  codegraph:     'cg_symbols',
  docgraph:      'docgraph_chunks',
});

const PG_VECTOR_INDEXES = Object.freeze({
  memories:        'idx_memories_embedding',
  wiki_articles:   'idx_wiki_embedding',
  self_memories:   'idx_self_memories_embedding',
  cg_symbols:      'idx_cg_symbols_embedding',
  docgraph_chunks: 'idx_dc_embedding',
});

export const withVectorMeta = (Base) => class extends Base {
  // ── vec_meta: per-store signature + reindex state (issue #287, WS1) ───────
  // Kept deliberately dumb — the state machine itself lives in
  // lib/helpers/vecMeta.js so both backends can't drift on the rules.

  async listVecMeta() {
    const { rows } = await this.pool.query(
      `SELECT store_name, signature, dims, status, vectors_cleared, reindex_owner, reindex_expires_at, updated_at
         FROM vec_meta ORDER BY store_name`
    );
    return rows;
  }

  async getVecMeta(storeName) {
    const { rows } = await this.pool.query(
      `SELECT store_name, signature, dims, status, vectors_cleared, reindex_owner, reindex_expires_at, updated_at
         FROM vec_meta WHERE store_name = $1`,
      [storeName]
    );
    return rows[0] ?? null;
  }

  // Insert only if absent — seeding must never clobber the recorded state of a
  // store that already has one (that state is what says "these vectors are in
  // the old space and still need reindexing").
  async seedVecMeta(storeName, { signature, dims, status = "current" }) {
    const { rowCount } = await this.pool.query(
      `INSERT INTO vec_meta (store_name, signature, dims, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (store_name) DO NOTHING`,
      [storeName, signature, dims, status]
    );
    return rowCount > 0;
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
  // One statement, so two processes racing here cannot both win: the CTE takes
  // a row lock, and the UPDATE's predicate is evaluated against the locked row.
  //
  // `expectedSignature` closes a race the ownership check alone cannot: if a
  // configuration change retargets this row between the caller listing it as
  // pending and this claim running, the row's signature no longer matches what
  // the caller is about to reindex toward. Claiming and completing it anyway
  // would finalize the row as current under the caller's *old* target while it
  // actually holds vectors for neither space. A NULL parameter skips the check
  // for callers that only care about ownership, not target.
  async claimVecMetaReindex(storeName, owner, leaseMs, expectedSignature = null) {
    const { rows } = await this.pool.query(
      `WITH prev AS (
         SELECT store_name, status, signature, vectors_cleared, reindex_owner, reindex_expires_at
           FROM vec_meta WHERE store_name = $1 FOR UPDATE
       )
       UPDATE vec_meta v
          SET status = 'reindexing',
              vectors_cleared = (prev.status <> 'stale' AND prev.vectors_cleared),
              reindex_owner = $2,
              reindex_expires_at = now() + ($3 || ' milliseconds')::interval,
              updated_at = now()
         FROM prev
        WHERE v.store_name = prev.store_name
          AND prev.status <> 'current'
          AND ($4::text IS NULL OR prev.signature = $4)
          AND (prev.reindex_owner IS NULL
               OR prev.reindex_owner = $2
               OR prev.reindex_expires_at IS NULL
               OR prev.reindex_expires_at < now())
        RETURNING prev.status AS previous_status, v.vectors_cleared AS vectors_cleared`,
      [storeName, owner, String(leaseMs), expectedSignature]
    );
    if (!rows.length) return { claimed: false };
    return {
      claimed: true,
      previousStatus: rows[0].previous_status,
      vectorsCleared: rows[0].vectors_cleared,
    };
  }

  // Records that this reindex has cleared the store's old-space vectors. Called
  // immediately after the clear, so a crash can only ever leave a window in
  // which the next runner re-clears a store that is already empty.
  async markVectorsCleared(storeName) {
    const { rowCount } = await this.pool.query(
      `UPDATE vec_meta SET vectors_cleared = true, updated_at = now() WHERE store_name = $1`,
      [storeName]
    );
    return rowCount > 0;
  }

  // Extends a lease we still hold. False means someone else took the store —
  // the caller must stop rather than write into a reindex it no longer owns.
  async renewVecMetaLease(storeName, owner, leaseMs) {
    const { rowCount } = await this.pool.query(
      `UPDATE vec_meta
          SET reindex_expires_at = now() + ($3 || ' milliseconds')::interval, updated_at = now()
        WHERE store_name = $1 AND reindex_owner = $2`,
      [storeName, owner, String(leaseMs)]
    );
    return rowCount > 0;
  }

  async releaseVecMetaReindex(storeName, owner) {
    const { rowCount } = await this.pool.query(
      `UPDATE vec_meta SET reindex_owner = NULL, reindex_expires_at = NULL, updated_at = now()
        WHERE store_name = $1 AND reindex_owner = $2`,
      [storeName, owner]
    );
    return rowCount > 0;
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
    const { rowCount } = await this.pool.query(
      `UPDATE vec_meta
          SET status = 'current', vectors_cleared = false, reindex_owner = NULL, reindex_expires_at = NULL,
              signature = $2, dims = $3, updated_at = now()
        WHERE store_name = $1 AND reindex_owner = $4`,
      [storeName, signature, dims, owner]
    );
    return rowCount > 0;
  }

  async updateVecMeta(storeName, patch) {
    const allowed = ["signature", "dims", "status", "vectors_cleared", "reindex_owner", "reindex_expires_at"];
    const cols = allowed.filter(k => Object.hasOwn(patch, k));
    if (!cols.length) return false;
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
    const { rowCount } = await this.pool.query(
      `UPDATE vec_meta SET ${sets}, updated_at = now() WHERE store_name = $1`,
      [storeName, ...cols.map(c => patch[c])]
    );
    return rowCount > 0;
  }

  // Clears one logical store's vectors (issue #287, WS1). The reindex driver
  // calls this when a stale store starts reindexing, so the store's rows show
  // up in the existing "without embeddings" scans and get re-embedded.
  async clearStoreEmbeddings(storeName) {
    const table = PG_VECTOR_TABLES[storeName];
    if (!table) throw new Error(`clearStoreEmbeddings: unknown store "${storeName}"`);
    await this.pool.query(`UPDATE ${table} SET embedding = NULL`);
  }

  async clearAllEmbeddings() {
    for (const table of Object.values(PG_VECTOR_TABLES)) {
      await this.pool.query(`UPDATE ${table} SET embedding = NULL`);
    }
  }

  // Nulls out and re-types every embedding column at the new dimension.
  // pgvector columns are vector(N) fixed at CREATE time — a plain
  // clearAllEmbeddings() empties the values but leaves every subsequent
  // insert at the old N failing once EMBEDDING_DIMS changes. The HNSW index
  // is dropped/recreated around the ALTER since it depends on the column,
  // and memories_without_embeddings (which reads memories.embedding) has to
  // be dropped/recreated too — Postgres refuses to ALTER a column a view
  // depends on. Runs as one transaction so a mid-resize failure can't leave
  // a table without its index or view.
  async resizeVectorStorage(dims) {
    if (!Number.isInteger(dims) || dims <= 0) {
      throw new Error(`resizeVectorStorage: invalid dims ${dims}`);
    }
    if (dims > PGVECTOR_HNSW_MAX_DIMS) {
      // Catch this before any DDL runs — otherwise the ALTER succeeds, the
      // subsequent CREATE INDEX fails, the whole transaction rolls back, and
      // the app hits this same failure on every boot as long as
      // EMBEDDING_DIMS stays set to an unsupported width.
      throw new Error(
        `resizeVectorStorage: dims ${dims} exceeds pgvector's HNSW index limit of ${PGVECTOR_HNSW_MAX_DIMS} — ` +
        `choose an EMBEDDING_DIMS at or below ${PGVECTOR_HNSW_MAX_DIMS}, or a Voyage model/output_dimension that fits it`
      );
    }
    const targets = Object.values(PG_VECTOR_TABLES)
      .map(table => ({ table, index: PG_VECTOR_INDEXES[table] }));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const { table, index } of targets) {
        await client.query(`UPDATE ${table} SET embedding = NULL`);
        await client.query(`DROP INDEX IF EXISTS ${index}`);
        if (table === "memories") {
          await client.query(`DROP VIEW IF EXISTS memories_without_embeddings`);
        }
        await client.query(`ALTER TABLE ${table} ALTER COLUMN embedding TYPE vector(${dims}) USING NULL`);
        if (table === "memories") {
          await client.query(`
            CREATE OR REPLACE VIEW memories_without_embeddings AS
            SELECT id, title, content, type, tags
            FROM memories
            WHERE embedding IS NULL
          `);
        }
        await client.query(
          `CREATE INDEX ${index} ON ${table} USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Physical width of the memories.embedding column, read from Postgres
  // catalog metadata rather than trusting the stored fingerprint — a
  // freshly-created DB (hardcoded vector(1024) at migration time) or a DB
  // upgraded from before resizeVectorStorage existed can both have a
  // fingerprint that already claims the configured dims without storage
  // ever having been resized to match.
  async getVectorDims() {
    const { rows } = await this.pool.query(`
      SELECT atttypmod AS dims
      FROM pg_attribute
      WHERE attrelid = 'memories'::regclass
        AND attname = 'embedding'
        AND NOT attisdropped
    `);
    const dims = rows[0]?.dims;
    return Number.isInteger(dims) && dims > 0 ? dims : null;
  }
};
