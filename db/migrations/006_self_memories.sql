-- 006_self_memories.sql — Postgres
-- Agent's private memory store ("the gift"). Walled off from user-facing
-- memories: no type taxonomy, no versioning, no expiry, no pin.
-- generated_by is inline (no ALTER TABLE needed later).

CREATE TABLE self_memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT[],
  importance    INT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  source        TEXT DEFAULT 'self',
  lang          TEXT NOT NULL DEFAULT 'english',
  search_vector TSVECTOR,
  embedding     vector(1024),
  confidence    FLOAT NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0),
  generated_by  TEXT
);

CREATE INDEX idx_self_memories_importance ON self_memories(importance DESC);
CREATE INDEX idx_self_memories_tags       ON self_memories USING GIN(tags);
CREATE INDEX idx_self_memories_fts        ON self_memories USING GIN(search_vector);
CREATE INDEX idx_self_memories_embedding
  ON self_memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Reuse the generic trigger functions from 001_core.sql
-- (update_search_vector / update_updated_at are table-agnostic).
CREATE TRIGGER trg_self_memories_search_vector
BEFORE INSERT OR UPDATE OF title, content, lang ON self_memories
FOR EACH ROW EXECUTE FUNCTION update_search_vector();

CREATE TRIGGER trg_self_memories_updated_at
BEFORE UPDATE ON self_memories
FOR EACH ROW EXECUTE FUNCTION update_updated_at();
