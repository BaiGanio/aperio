-- 014_extraction_templates.sql — Postgres
-- Document Intelligence WS3 (issue #250): persistent, reusable extraction
-- templates so a recognized document shape no longer re-derives its own
-- CREATE TABLE and field labels from scratch every session.
-- Mirror of db/migrations-sqlite/014_extraction_templates.sql — keep in lockstep.
--
-- These tables describe document *shapes* and extraction *history* — global,
-- backend-mirrored, like every other core table. The extracted data itself
-- never lands here; it continues to live in the user's own `extraction`
-- connection via WS1's db_execute confirm gate, unchanged.

-- ── extraction_templates: a learned document shape ──────────────────────────
-- confidence is the template's own rolling extraction-success rate, distinct
-- from a single extraction's per-run confidence (computed in WS3 handlers,
-- not stored here).
CREATE TABLE extraction_templates (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  match_keywords JSONB NOT NULL,
  fields         JSONB NOT NULL,
  confidence     REAL NOT NULL DEFAULT 0
                   CHECK (confidence >= 0 AND confidence <= 1),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── extraction_log: one row per extracted source, for dedup/verification ────
-- source_hash is the dedup key (sha256, same algorithm as docgraph_documents.
-- sha256); source_path is best-effort provenance only, never the dedup key.
CREATE TABLE extraction_log (
  id                   SERIAL PRIMARY KEY,
  source_hash          TEXT NOT NULL UNIQUE,
  source_path          TEXT,
  template_id          INT REFERENCES extraction_templates(id) ON DELETE SET NULL,
  extraction_connection TEXT NOT NULL DEFAULT 'extraction',
  verification_state   TEXT NOT NULL DEFAULT 'unverified'
                          CHECK (verification_state IN ('unverified', 'verified', 'rejected')),
  row_count            INT NOT NULL DEFAULT 0,
  extracted_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_extraction_log_template ON extraction_log (template_id);
