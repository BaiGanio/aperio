-- 013_vec_meta.sql — per-store embedding signature + reindex state (issue #287, WS1)
--
-- SQLite mirror of db/migrations/013_vec_meta.sql. See that file for the full
-- rationale; the two must stay in lockstep (AGENTS.md hard rule).
--
-- status:
--   current     — signature matches configuration; vector search enabled
--   stale       — signature differs; vector search disabled (FTS-only) until reindexed
--   reindexing  — reindex in progress; still FTS-only, because a partially
--                 reindexed store holds a mix of old- and new-space vectors
--
--
-- vectors_cleared is a crash checkpoint, not a status flag. A reindex clears the
-- store's old-space vectors exactly once, on the stale → reindexing edge, and
-- the status alone cannot record that: a process killed after the status write
-- but before the clear would resume at `reindexing`, skip the clear, find no
-- rows missing a vector, and declare the store current with every old-space
-- vector still in place — precisely the cross-space scoring this table exists
-- to prevent. The flag is written immediately after the clear, so the only
-- window a crash can leave behind is one where re-clearing an already-empty
-- store is harmless.
--
-- reindex_owner / reindex_expires_at are a lease, not bookkeeping. Two runners
-- can want the same store at once — the server's background reindex and an
-- operator running the CLI. Without a lease both would select the same stale
-- row: one clears vectors the other has already rebuilt, and every remaining
-- row gets embedded twice (real money on a paid embedding API). A runner must
-- win an atomic claim before touching a store, and renews the lease as it
-- works so a crashed runner's claim expires instead of blocking the store
-- forever.
--
-- Rows are seeded at runtime, not here — see ensureVecMeta() in
-- lib/helpers/vecMeta.js.

CREATE TABLE vec_meta (
  store_name     TEXT PRIMARY KEY,
  signature      TEXT NOT NULL,
  dims           INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'current'
                   CHECK (status IN ('current', 'stale', 'reindexing')),
  vectors_cleared    INTEGER NOT NULL DEFAULT 0,
  reindex_owner      TEXT,
  reindex_expires_at TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_vec_meta_status ON vec_meta (status);
