-- 008_agent_interrupts.sql — Postgres
-- Durable descriptors for sensitive agent actions awaiting user decision.
-- These rows persist data only; executable continuations are reconstructed by
-- later interrupt-service code and are never stored in the database.

CREATE TABLE agent_interrupts (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT,
  run_id                TEXT,
  tool_name             TEXT NOT NULL,
  canonical_arguments   JSONB,
  protected_payload_ref JSONB,
  digest                TEXT NOT NULL,
  allowed_decisions     JSONB NOT NULL,
  decision              TEXT,
  decision_payload      JSONB,
  claim_id              TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','edited','rejected','responded','expired','claimed','executed','failed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at            TIMESTAMPTZ,
  claimed_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,
  CHECK (session_id IS NOT NULL OR run_id IS NOT NULL),
  CHECK (canonical_arguments IS NOT NULL OR protected_payload_ref IS NOT NULL)
);

CREATE INDEX idx_agent_interrupts_session_status ON agent_interrupts (session_id, status, created_at DESC);
CREATE INDEX idx_agent_interrupts_run_status     ON agent_interrupts (run_id, status, created_at DESC);
CREATE INDEX idx_agent_interrupts_expiry         ON agent_interrupts (expires_at);
