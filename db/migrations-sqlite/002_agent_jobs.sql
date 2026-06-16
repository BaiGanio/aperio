-- 002_agent_jobs.sql (SQLite)
-- Background-agents Phase 4: job definitions move out of var/agents/jobs.json
-- into the DB, and every run is recorded so the status/run-history panel has
-- something to show. See background-agents.md.
--
-- A job's heterogeneous shape (steps vs. freeform; interval vs. watcher trigger)
-- is stored as a JSON `definition` blob; only `id` and `enabled` are promoted to
-- columns since those are all the scheduler filters on.

CREATE TABLE IF NOT EXISTS agent_jobs (
  id         TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  verdict     TEXT NOT NULL,
  mode        TEXT,
  trigger     TEXT,
  error       TEXT,
  tools       TEXT,
  answer      TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_job ON agent_runs (job_id, started_at DESC);

-- Seed the example job (formerly the committed var/agents/jobs.json example).
-- Harmless until APERIO_AGENT_JOBS=on; then it runs on its 24h interval.
INSERT OR IGNORE INTO agent_jobs (id, enabled, definition) VALUES (
  'nightly-maintenance', 1,
  '{"trigger":{"kind":"interval","everyMs":86400000},"steps":[{"tool":"backfill_embeddings","input":{}},{"tool":"deduplicate_memories","input":{"threshold":0.97,"dry_run":true}}]}'
);
