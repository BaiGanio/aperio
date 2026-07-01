-- 005_self_memories.sql (Postgres)
-- The agent's own walled-off memory store ("the gift"). A SEPARATE table from
-- `memories` — an absolute wall, so a user-facing recall can never touch it.
-- Mirrors the useful subset of the memories schema, minus the user-only bits:
-- no `type` taxonomy, no versioning (valid_from/valid_until), no expiry, no pin.
-- Updates are in-place. Local-only: never surfaced on a cloud provider.

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
  confidence    FLOAT NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0)
);

CREATE INDEX idx_self_memories_importance ON self_memories(importance DESC);
CREATE INDEX idx_self_memories_tags       ON self_memories USING GIN(tags);
CREATE INDEX idx_self_memories_fts        ON self_memories USING GIN(search_vector);
CREATE INDEX idx_self_memories_embedding
  ON self_memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Reuse the generic trigger functions defined in 001_init.sql
-- (update_search_vector / update_updated_at reference NEW.title/content/lang
--  and NEW.updated_at — table-agnostic, so they apply here unchanged).
CREATE TRIGGER trg_self_memories_search_vector
BEFORE INSERT OR UPDATE OF title, content, lang ON self_memories
FOR EACH ROW EXECUTE FUNCTION update_search_vector();

CREATE TRIGGER trg_self_memories_updated_at
BEFORE UPDATE ON self_memories
FOR EACH ROW EXECUTE FUNCTION update_updated_at();
