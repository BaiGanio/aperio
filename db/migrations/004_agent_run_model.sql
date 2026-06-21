-- 004_agent_run_model.sql (Postgres)
-- Record which model answered a freeform agent run so the run-history panel can
-- show "who triaged this". Null for steps-mode runs (deterministic, no model).

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS model TEXT;
