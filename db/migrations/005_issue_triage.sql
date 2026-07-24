-- 005_issue_triage.sql — Postgres
-- GitHub issue triage ledger. Each row = one issue the triage agent has seen.
-- updated_at is the GitHub issue timestamp (dedup key);
-- triaged_at NULL means pending re-triage.

CREATE TABLE issue_triage (
  repo         TEXT        NOT NULL,
  issue_number INTEGER     NOT NULL,
  title        TEXT,
  state        TEXT,
  updated_at   TIMESTAMPTZ,
  triaged_at   TIMESTAMPTZ,
  priority     INTEGER,
  verdict      TEXT,
  run_id       BIGINT,
  PRIMARY KEY (repo, issue_number)
);
CREATE INDEX idx_issue_triage_pending ON issue_triage (triaged_at);
