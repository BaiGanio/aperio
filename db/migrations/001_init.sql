-- ============================================================
-- Aperio - Initial Schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- MEMORIES
-- ============================================================
CREATE TABLE memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL CHECK (type IN (
                  'fact', 'preference', 'project',
                  'decision', 'solution', 'source', 'person', 'inference'
                )),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT[],
  importance    INT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  source        TEXT DEFAULT 'manual',
  lang          TEXT NOT NULL DEFAULT 'english',
  search_vector TSVECTOR,
  embedding     vector(1024),
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until   TIMESTAMPTZ,
  confidence    FLOAT NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_memories_type       ON memories(type);
CREATE INDEX idx_memories_tags       ON memories USING GIN(tags);
CREATE INDEX idx_memories_importance ON memories(importance DESC);
CREATE INDEX idx_memories_fts        ON memories USING GIN(search_vector);
CREATE INDEX idx_memories_temporal   ON memories(valid_from, valid_until);
CREATE INDEX idx_memories_current    ON memories(id) WHERE valid_until IS NULL;
CREATE INDEX idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================
CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector(COALESCE(NEW.lang, 'simple')::regconfig,
                                   NEW.title || ' ' || NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_memories_search_vector
BEFORE INSERT OR UPDATE OF title, content, lang ON memories
FOR EACH ROW EXECUTE FUNCTION update_search_vector();

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_memories_updated_at
BEFORE UPDATE ON memories
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- VIEWS
-- ============================================================
CREATE OR REPLACE VIEW memories_without_embeddings AS
SELECT id, title, content, type, tags
FROM memories
WHERE embedding IS NULL;

-- ============================================================
-- SEED
-- ============================================================
INSERT INTO memories (type, title, content, tags, importance) VALUES
(
  'fact',
  'Primary development environment',
  'I use Docker for all local services. My main OS is the one running this stack.',
  ARRAY['setup', 'docker'],
  4
),
(
  'preference',
  'Code style preference',
  'I prefer clean, readable code over clever one-liners. Comments should explain WHY, not WHAT.',
  ARRAY['coding', 'style'],
  4
),
(
  'preference',
  'File write confirmation preference',
  'Always ask for confirmation before writing any file and show the path.',
  ARRAY['safety', 'file-io'],
  5
),
(
  'project',
  'Aperio',
  'A personal memory layer for AI tools. Built with Postgres + MCP. Currently in early development.',
  ARRAY['mcp', 'postgres', 'ai', 'personal'],
  2
);
