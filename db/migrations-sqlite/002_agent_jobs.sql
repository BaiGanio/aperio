-- 002_agent_jobs.sql — SQLite
-- Background agent jobs + run history.
-- Every column inline — no ALTER TABLE additions.
-- Seed data is handled separately in JS (not migrations).

CREATE TABLE agent_jobs (
  id         TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE agent_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  duration_ms     INTEGER,
  verdict         TEXT NOT NULL,
  mode            TEXT,
  model           TEXT,
  trigger         TEXT,
  error           TEXT,
  tools           TEXT,
  answer          TEXT,
  artifact_count  INTEGER NOT NULL DEFAULT 0,
  artifact_bytes  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_agent_runs_job ON agent_runs (job_id, started_at DESC);
