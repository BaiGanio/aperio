-- 008_memory_tiers.sql — SQLite
-- Memory sensitivity tiers + self-memory model tracking.
-- Mirror of db/migrations/008_memory_tiers.sql (Postgres).
--
-- 1. Add tier (1=normal, 2=sensitive, 3=private) to memories.
--    Backfill: existing local-only tags → tier 2.
-- 2. Add generated_by to self_memories so we track which model created them.

ALTER TABLE memories
  ADD COLUMN tier INTEGER NOT NULL DEFAULT 1
    CHECK (tier IN (1, 2, 3));

-- Backfill: existing local-only memories become tier 2 (sensitive).
-- (json_extract provides NULL when no match, so the IS NOT NULL guard is safe.)
UPDATE memories
   SET tier = 2
 WHERE json_extract(tags, '$') LIKE '%"local-only"%'
   AND tier = 1;

CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);

ALTER TABLE self_memories
  ADD COLUMN generated_by TEXT;
