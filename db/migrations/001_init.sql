-- ============================================================
-- Aperio - Initial Schema
-- Migration: 001_init.sql
-- Runs automatically on first docker compose up
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- MEMORIES
-- The core table. Every piece of context lives here.
-- ============================================================
CREATE TABLE memories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL CHECK (type IN (
                 'fact', 'preference', 'project',
                 'decision', 'solution', 'source', 'person'
               )),
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  tags         TEXT[],
  importance   INT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  source       TEXT DEFAULT 'manual'
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_memories_type       ON memories(type);
CREATE INDEX idx_memories_tags       ON memories USING GIN(tags);
CREATE INDEX idx_memories_importance ON memories(importance DESC);

-- Full-text search across title + content
CREATE INDEX idx_memories_fts ON memories USING GIN(
  to_tsvector('english', title || ' ' || content)
);

-- ============================================================
-- AUTO-UPDATE updated_at ON CHANGE
-- ============================================================
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
-- SEED: A few starter memories so the DB isn't empty
-- Edit these to reflect your actual setup!
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
  6
);
