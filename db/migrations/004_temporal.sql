-- ============================================================
-- Aperio - Temporal Memory + Confidence
-- Migration: 004_temporal.sql
-- Adds valid_from/valid_until for point-in-time recall and
-- confidence for distinguishing inferred vs. stated facts.
-- ============================================================

-- 1. Add temporal columns
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS valid_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_until  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confidence   FLOAT NOT NULL DEFAULT 1.0
    CONSTRAINT memories_confidence_check CHECK (confidence BETWEEN 0.0 AND 1.0);

-- 2. Backfill: existing rows were valid from when they were created
UPDATE memories SET valid_from = created_at;

-- 3. Extend type constraint to include 'inference'
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_type_check
  CHECK (type IN (
    'fact', 'preference', 'project', 'decision',
    'solution', 'source', 'person', 'inference'
  ));

-- 4. Indexes for temporal queries
CREATE INDEX IF NOT EXISTS idx_memories_temporal
  ON memories(valid_from, valid_until);

-- Partial index for the hot path: current (non-tombstoned) rows only
CREATE INDEX IF NOT EXISTS idx_memories_current
  ON memories(id) WHERE valid_until IS NULL;
