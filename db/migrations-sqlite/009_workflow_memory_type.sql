-- 009_workflow_memory_type.sql (SQLite)
-- Add 'workflow' to the memories type CHECK constraint.
--
-- SQLite cannot ALTER CHECK constraints, so we must rebuild the memories table
-- while preserving every rowid so FTS5 (memories_fts) and vec0 (vec_memories)
-- virtual tables, which reference memories.rowid, stay valid.
--
-- The table schema includes all columns added by prior migrations (tier, etc.)
-- so the rebuild is complete and self-contained.

-- ── Disable FK enforcement during the rebuild ────────────────────────────────
PRAGMA foreign_keys = OFF;

-- ── 1. Backup data (rowid is implicitly included) ────────────────────────────
CREATE TABLE IF NOT EXISTS memories_009_backup AS SELECT * FROM memories;

-- ── 2. Drop triggers that reference the memories table by name ───────────────
DROP TRIGGER IF EXISTS trg_memories_updated_at;
DROP TRIGGER IF EXISTS trg_memories_fts_ai;
DROP TRIGGER IF EXISTS trg_memories_fts_ad;
DROP TRIGGER IF EXISTS trg_memories_fts_au;
DROP TRIGGER IF EXISTS trg_memories_mark_wiki_stale;

-- ── 3. Drop the old table (FTS/vec virtual tables survive as rowid references) ─
DROP TABLE IF EXISTS memories;

-- ── 4. Recreate with updated CHECK constraint (including tier from 008) ──
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN (
                  'fact','preference','project','decision',
                  'solution','source','person','inference','workflow'
                )),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]'  CHECK (json_valid(tags)),
  importance    INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  tier          INTEGER NOT NULL DEFAULT 1 CHECK (tier IN (1, 2, 3)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',
  lang          TEXT NOT NULL DEFAULT 'english',
  valid_from    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  valid_until   TEXT,
  confidence    REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0),
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1))
);

-- ── 5. Copy data back, preserving rowids so FTS/vec references stay valid ────
INSERT INTO memories(
  rowid, id, type, title, content, tags, importance, tier,
  created_at, updated_at, expires_at, source, lang,
  valid_from, valid_until, confidence, pinned
)
SELECT
  rowid, id, type, title, content, tags, importance,
  COALESCE(tier, 1) AS tier,
  created_at, updated_at, expires_at, source, lang,
  valid_from, valid_until, confidence, pinned
FROM memories_009_backup;

-- ── 6. Drop the backup ───────────────────────────────────────────────────────
DROP TABLE IF EXISTS memories_009_backup;

-- ── 7. Recreate indexes ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_memories_type       ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_temporal   ON memories(valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_current    ON memories(id) WHERE valid_until IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_pinned     ON memories(pinned) WHERE pinned = 1;

-- ── 8. Recreate triggers ─────────────────────────────────────────────────────
CREATE TRIGGER trg_memories_updated_at
AFTER UPDATE ON memories
BEGIN
  UPDATE memories
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = NEW.id;
END;

CREATE TRIGGER trg_memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
END;
CREATE TRIGGER trg_memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', OLD.rowid, OLD.title, OLD.content);
END;
CREATE TRIGGER trg_memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', OLD.rowid, OLD.title, OLD.content);
  INSERT INTO memories_fts(rowid, title, content)                VALUES (NEW.rowid, NEW.title, NEW.content);
END;

CREATE TRIGGER trg_memories_mark_wiki_stale
AFTER UPDATE OF content, title ON memories
BEGIN
  UPDATE wiki_articles
     SET status = 'stale'
   WHERE id IN (SELECT article_id FROM wiki_article_sources WHERE memory_id = NEW.id)
     AND status = 'fresh';
END;

-- ── 9. Re-enable FK enforcement ──────────────────────────────────────────────
PRAGMA foreign_keys = ON;
