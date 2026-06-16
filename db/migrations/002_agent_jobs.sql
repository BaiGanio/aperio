-- 002_agent_jobs.sql (Postgres) — mirror of migrations-sqlite/002_agent_jobs.sql.
-- Background-agents Phase 4: jobs live in the DB, every run is recorded for the
-- status/run-history panel. See background-agents.md.

CREATE TABLE IF NOT EXISTS agent_jobs (
  id         TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id          BIGSERIAL PRIMARY KEY,
  job_id      TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  verdict     TEXT NOT NULL,
  mode        TEXT,
  trigger     TEXT,
  error       TEXT,
  tools       JSONB,
  answer      TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_job ON agent_runs (job_id, started_at DESC);

-- Seed the example job (formerly the committed var/agents/jobs.json example).
INSERT INTO agent_jobs (id, enabled, definition) VALUES (
  'nightly-maintenance', true,
  '{"trigger":{"kind":"interval","everyMs":86400000},"steps":[{"tool":"backfill_embeddings","input":{}},{"tool":"deduplicate_memories","input":{"threshold":0.97,"dry_run":true}}]}'::jsonb
) ON CONFLICT (id) DO NOTHING;
