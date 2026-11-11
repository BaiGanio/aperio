-- 001_memories.sql - the v2 memory schema (spec S2.3).
--
-- The vector table is NOT here. It is derived data with a width that depends
-- on the embedding model, so src/store/open-store.js creates it at open.

CREATE TABLE memories (
  -- AUTOINCREMENT: a seq value is never used again, so a vector row left
  -- behind on a machine without sqlite-vec can never attach to a new memory.
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  type          TEXT NOT NULL CHECK (type IN (
                  'fact','preference','project','decision',
                  'solution','source','person','inference','workflow'
                )),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  importance    INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  source        TEXT NOT NULL DEFAULT 'manual',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- Opaque text from the embedding step (S2.4). NULL = this row has no vector.
  embedding_sig TEXT
);

CREATE INDEX idx_memories_type    ON memories(type);
CREATE INDEX idx_memories_ranking ON memories(importance DESC, created_at DESC);
CREATE INDEX idx_memories_created ON memories(created_at DESC);

-- Full-text search: an external-content FTS5 table kept in step by triggers.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  title, content,
  content='memories',
  content_rowid='seq',
  tokenize='unicode61'
);
CREATE TRIGGER trg_memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content) VALUES (NEW.seq, NEW.title, NEW.content);
END;
CREATE TRIGGER trg_memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', OLD.seq, OLD.title, OLD.content);
END;
CREATE TRIGGER trg_memories_fts_au AFTER UPDATE OF title, content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', OLD.seq, OLD.title, OLD.content);
  INSERT INTO memories_fts(rowid, title, content)                VALUES (NEW.seq, NEW.title, NEW.content);
END;

-- Old versions of a changed memory. Search and list never read this table.
CREATE TABLE memory_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL,
  importance  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  replaced_at TEXT NOT NULL
);
CREATE INDEX idx_memory_history_memory ON memory_history(memory_id, id DESC);
