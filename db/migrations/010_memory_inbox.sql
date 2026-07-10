-- 010_memory_inbox.sql — Postgres
-- Agent-proposed memories awaiting user review before being committed
-- to the main memories store.

CREATE TABLE pending_memories (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN (
                  'fact','preference','project','decision',
                  'solution','source','person','inference','workflow'
                )),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  importance    INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  tier          INTEGER NOT NULL DEFAULT 1 CHECK (tier IN (1, 2, 3)),
  proposed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source        TEXT NOT NULL DEFAULT 'agent',
  lang          TEXT NOT NULL DEFAULT 'english',
  confidence    REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected')),
  reviewed_at   TIMESTAMPTZ,
  session_id    TEXT
);

CREATE INDEX idx_pending_status ON pending_memories(status);
CREATE INDEX idx_pending_proposed ON pending_memories(proposed_at DESC);
