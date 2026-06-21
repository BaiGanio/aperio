-- 004_agent_run_model.sql (SQLite)
-- Record which model answered a freeform agent run so the run-history panel can
-- show "who triaged this". Null for steps-mode runs (deterministic, no model).

ALTER TABLE agent_runs ADD COLUMN model TEXT;
