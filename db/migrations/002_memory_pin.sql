ALTER TABLE memories ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned) WHERE pinned = true;
