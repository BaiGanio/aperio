-- ============================================================
-- Aperio - Per-language FTS Migration
-- Migration: 003_fts_lang.sql
-- Replaces the hard-coded 'english' GIN index with a
-- trigger-maintained search_vector column so each memory uses
-- its own pg text-search config (english, german, simple, …).
-- ============================================================

-- 1. Add columns
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS lang          TEXT NOT NULL DEFAULT 'english',
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

-- 2. Trigger function: rebuild search_vector whenever title/content/lang changes
CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector(COALESCE(NEW.lang, 'simple')::regconfig,
                                   NEW.title || ' ' || NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memories_search_vector ON memories;
CREATE TRIGGER trg_memories_search_vector
BEFORE INSERT OR UPDATE OF title, content, lang ON memories
FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- 3. Backfill existing rows
UPDATE memories
SET search_vector = to_tsvector(COALESCE(lang, 'simple')::regconfig,
                                title || ' ' || content);

-- 4. Swap the index
DROP INDEX IF EXISTS idx_memories_fts;
CREATE INDEX idx_memories_fts ON memories USING GIN(search_vector);
