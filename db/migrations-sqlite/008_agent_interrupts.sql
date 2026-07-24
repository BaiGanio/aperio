-- 008_agent_interrupts.sql — SQLite
-- Durable descriptors for sensitive agent actions awaiting user decision.
-- These rows persist data only; executable continuations are reconstructed by
-- later interrupt-service code and are never stored in the database.

CREATE TABLE agent_interrupts (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT,
  run_id                TEXT,
  tool_name             TEXT NOT NULL,
  canonical_arguments   TEXT CHECK (canonical_arguments IS NULL OR json_valid(canonical_arguments)),
  protected_payload_ref TEXT CHECK (protected_payload_ref IS NULL OR json_valid(protected_payload_ref)),
  digest                TEXT NOT NULL,
  allowed_decisions     TEXT NOT NULL CHECK (json_valid(allowed_decisions)),
  decision              TEXT,
  decision_payload      TEXT CHECK (decision_payload IS NULL OR json_valid(decision_payload)),
  claim_id              TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','edited','rejected','responded','expired','claimed','executed','failed')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at            TEXT,
  claimed_at            TEXT,
  completed_at          TEXT,
  expires_at            TEXT,
  CHECK (session_id IS NOT NULL OR run_id IS NOT NULL),
  CHECK (canonical_arguments IS NOT NULL OR protected_payload_ref IS NOT NULL)
);

CREATE INDEX idx_agent_interrupts_session_status ON agent_interrupts (session_id, status, created_at DESC);
CREATE INDEX idx_agent_interrupts_run_status     ON agent_interrupts (run_id, status, created_at DESC);
CREATE INDEX idx_agent_interrupts_expiry         ON agent_interrupts (expires_at);
