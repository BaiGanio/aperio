-- 002_agent_jobs.sql — Postgres
-- Background agent jobs + run history.
-- Every column inline — no ALTER TABLE additions.
-- Seed data is handled separately in JS (not migrations).

CREATE TABLE agent_jobs (
  id         TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_runs (
  id              BIGSERIAL PRIMARY KEY,
  job_id          TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,
  verdict         TEXT NOT NULL,
  mode            TEXT,
  model           TEXT,
  trigger         TEXT,
  error           TEXT,
  tools           JSONB,
  answer          TEXT,
  artifact_count  INTEGER NOT NULL DEFAULT 0,
  artifact_bytes  BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_agent_runs_job ON agent_runs (job_id, started_at DESC);
