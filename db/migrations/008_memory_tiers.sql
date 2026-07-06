-- 008_memory_tiers.sql
-- Memory sensitivity tiers + self-memory model tracking.
--
-- 1. Add tier (1=normal, 2=sensitive, 3=private) to memories.
--    Backfill: existing local-only tags → tier 2.
-- 2. Add generated_by to self_memories so we track which model created them.

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS tier INTEGER NOT NULL DEFAULT 1
    CHECK (tier IN (1, 2, 3));

-- Backfill: existing local-only memories become tier 2 (sensitive).
UPDATE memories
   SET tier = 2
 WHERE tags @> ARRAY['local-only']::text[]
   AND tier = 1;
-- (Only update tier-1 rows so the backfill is idempotent.)

CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);

ALTER TABLE self_memories
  ADD COLUMN IF NOT EXISTS generated_by TEXT;
