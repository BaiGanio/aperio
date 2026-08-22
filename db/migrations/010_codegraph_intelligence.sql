-- 010_codegraph_intelligence.sql — Postgres
-- Native graph intelligence (issue #283): confidence-aware edges, file nodes,
-- graph revisioning, and persisted community/metric analysis snapshots.
-- Mirror of db/migrations-sqlite/010_codegraph_intelligence.sql — keep in lockstep.

-- ── cg_edges: relationship confidence + provenance ──────────────────────────
-- confidence: EXTRACTED (direct syntax fact), INFERRED (unique-name resolution),
-- AMBIGUOUS (reserved for future multi-candidate diagnostics). Existing rows take
-- the EXTRACTED default; the backfill below reclassifies resolved rows.
ALTER TABLE cg_edges
  ADD COLUMN confidence TEXT NOT NULL DEFAULT 'EXTRACTED'
    CHECK (confidence IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS')),
  ADD COLUMN confidence_score DOUBLE PRECISION
    CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
  ADD COLUMN provenance TEXT,
  ADD COLUMN relation_context TEXT;

-- Conservative upgrade backfill: any already-resolved call/extend/reference edge
-- from a v9 database was produced by unique-name resolution, so mark it INFERRED.
-- Unresolved extractor edges keep the EXTRACTED default. A schema-version bump
-- (below) forces a full rebuild on next index, which sets exact per-edge values.
UPDATE cg_edges
   SET confidence = 'INFERRED', confidence_score = 0.8, provenance = 'backfill-v10'
 WHERE dst_symbol_id IS NOT NULL
   AND kind IN ('calls', 'extends', 'references');

-- ── cg_repos: schema version, graph revision, analysis snapshot pointer ──────
-- index_schema_version: bump the code's expected value to force a full rebuild so
--   old graphs gain file/import nodes despite unchanged file hashes.
-- graph_revision: incremented once per successful symbol/edge mutation.
-- analyzed_revision/analyzed_at: the revision the persisted analysis describes.
ALTER TABLE cg_repos
  ADD COLUMN index_schema_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN graph_revision       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN analyzed_revision    INTEGER,
  ADD COLUMN analyzed_at          TIMESTAMPTZ;

-- ── cg_communities: stable community labels per repo ────────────────────────
CREATE TABLE cg_communities (
  repo_id      INT     NOT NULL REFERENCES cg_repos(id) ON DELETE CASCADE,
  community_id INT     NOT NULL,
  label        TEXT,
  size         INT     NOT NULL DEFAULT 0,
  cohesion     DOUBLE PRECISION,
  PRIMARY KEY (repo_id, community_id)
);
CREATE INDEX idx_cg_communities_repo ON cg_communities(repo_id);

-- ── cg_symbol_metrics: per-symbol analysis output ───────────────────────────
-- One row per symbol (cascade on symbol delete); repo_id gives a fast per-repo
-- wipe and cascade on repo delete. community_id is a soft reference into
-- cg_communities(repo_id, community_id) — analysis writes both together.
CREATE TABLE cg_symbol_metrics (
  symbol_id     BIGINT PRIMARY KEY REFERENCES cg_symbols(id) ON DELETE CASCADE,
  repo_id       INT    NOT NULL REFERENCES cg_repos(id) ON DELETE CASCADE,
  community_id  INT,
  degree        INT    NOT NULL DEFAULT 0,
  hotspot_score DOUBLE PRECISION,
  bridge_score  DOUBLE PRECISION
);
CREATE INDEX idx_cg_symbol_metrics_repo ON cg_symbol_metrics(repo_id);
CREATE INDEX idx_cg_symbol_metrics_comm ON cg_symbol_metrics(repo_id, community_id);
