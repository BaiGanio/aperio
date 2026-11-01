-- 006_self_memories.sql — SQLite
-- Agent's private memory store ("the gift"). Walled off from user-facing
-- memories: no type taxonomy, no versioning, no expiry, no pin.
-- generated_by is inline (no ALTER TABLE needed later).

CREATE TABLE self_memories (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]'  CHECK (json_valid(tags)),
  importance    INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source        TEXT NOT NULL DEFAULT 'self',
  lang          TEXT NOT NULL DEFAULT 'english',
  confidence    REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0),
  generated_by  TEXT
);
CREATE INDEX idx_self_memories_importance ON self_memories(importance DESC);

-- Keep updated_at fresh on every row update.
CREATE TRIGGER trg_self_memories_updated_at
AFTER UPDATE ON self_memories
BEGIN
  UPDATE self_memories
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = NEW.id;
END;

-- Full-text search — FTS5 external-content table.
CREATE VIRTUAL TABLE self_memories_fts USING fts5(
  title, content,
  content='self_memories',
  content_rowid='rowid'
);
CREATE TRIGGER trg_self_memories_fts_ai AFTER INSERT ON self_memories BEGIN
  INSERT INTO self_memories_fts(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
END;
CREATE TRIGGER trg_self_memories_fts_ad AFTER DELETE ON self_memories BEGIN
  INSERT INTO self_memories_fts(self_memories_fts, rowid, title, content) VALUES ('delete', OLD.rowid, OLD.title, OLD.content);
END;
CREATE TRIGGER trg_self_memories_fts_au AFTER UPDATE ON self_memories BEGIN
  INSERT INTO self_memories_fts(self_memories_fts, rowid, title, content) VALUES ('delete', OLD.rowid, OLD.title, OLD.content);
  INSERT INTO self_memories_fts(rowid, title, content)                    VALUES (NEW.rowid, NEW.title, NEW.content);
END;

-- Vector embeddings — sqlite-vec sidecar.
CREATE VIRTUAL TABLE vec_self_memories USING vec0(
  rowid INTEGER PRIMARY KEY,
  embedding FLOAT[1024]
);
CREATE TRIGGER trg_self_memories_vec_cleanup AFTER DELETE ON self_memories BEGIN
  DELETE FROM vec_self_memories WHERE rowid = OLD.rowid;
END;
