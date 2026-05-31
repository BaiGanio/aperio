-- ============================================================
-- Aperio — SQLite initial schema
--
-- Companion to db/migrations/001_init.sql (Postgres). Same semantics,
-- different dialect:
--   • UUIDs → TEXT primary keys (with random hex default via fn helper)
--   • tags TEXT[] → JSON text (validated via json_valid)
--   • vector(1024) → sqlite-vec vec0 virtual table joined by rowid
--   • tsvector + GIN → FTS5 virtual table kept in sync by triggers
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- MEMORIES
-- ──────────────────────────────────────────────────────────────
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,                            -- uuid v4 (generated in JS)
  type          TEXT NOT NULL CHECK (type IN (
                  'fact','preference','project','decision',
                  'solution','source','person','inference'
                )),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]'  CHECK (json_valid(tags)),
  importance    INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT,                                        -- nullable
  source        TEXT NOT NULL DEFAULT 'manual',
  lang          TEXT NOT NULL DEFAULT 'english',
  valid_from    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  valid_until   TEXT,                                        -- nullable; null = current
  confidence    REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0),
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1))
);
CREATE INDEX idx_memories_type       ON memories(type);
CREATE INDEX idx_memories_importance ON memories(importance DESC);
CREATE INDEX idx_memories_temporal   ON memories(valid_from, valid_until);
CREATE INDEX idx_memories_current    ON memories(id) WHERE valid_until IS NULL;
CREATE INDEX idx_memories_pinned     ON memories(pinned) WHERE pinned = 1;

-- Keep updated_at fresh on every row update.
CREATE TRIGGER trg_memories_updated_at
AFTER UPDATE ON memories
BEGIN
  UPDATE memories
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = NEW.id;
END;

-- Full-text search — FTS5 external-content table mirrors title+content.
-- BM25 ranking is the default; lower (more negative) `rank` = better match.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  title, content,
  content='memories',
  content_rowid='rowid'
);
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

-- Vector embeddings — sqlite-vec virtual table keyed by the memories rowid.
-- Dimension is fixed at table creation; changing requires dropping the DB.
CREATE VIRTUAL TABLE vec_memories USING vec0(
  rowid INTEGER PRIMARY KEY,
  embedding FLOAT[1024]
);

-- ──────────────────────────────────────────────────────────────
-- WIKI
-- ──────────────────────────────────────────────────────────────
CREATE TABLE wiki_articles (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  summary       TEXT,
  body_md       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  status        TEXT NOT NULL DEFAULT 'fresh'
                  CHECK (status IN ('fresh','stale','draft','archived')),
  generated_by  TEXT,
  generated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_hash   TEXT,
  revision      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_wiki_status ON wiki_articles(status);

CREATE TABLE wiki_article_sources (
  article_id  TEXT NOT NULL REFERENCES wiki_articles(id) ON DELETE CASCADE,
  memory_id   TEXT NOT NULL REFERENCES memories(id)        ON DELETE CASCADE,
  weight      REAL DEFAULT 1.0,
  PRIMARY KEY (article_id, memory_id)
);
CREATE INDEX idx_wiki_sources_memory ON wiki_article_sources(memory_id);

CREATE TABLE wiki_article_revisions (
  id            TEXT PRIMARY KEY,
  article_id    TEXT NOT NULL REFERENCES wiki_articles(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT,
  body_md       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  status        TEXT NOT NULL,
  generated_by  TEXT,
  generated_at  TEXT NOT NULL,
  source_hash   TEXT,
  archived_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (article_id, revision)
);
CREATE INDEX idx_wiki_revisions_article ON wiki_article_revisions(article_id);

CREATE VIRTUAL TABLE wiki_articles_fts USING fts5(
  title, body_md,
  content='wiki_articles',
  content_rowid='rowid'
);
CREATE TRIGGER trg_wiki_fts_ai AFTER INSERT ON wiki_articles BEGIN
  INSERT INTO wiki_articles_fts(rowid, title, body_md) VALUES (NEW.rowid, NEW.title, NEW.body_md);
END;
CREATE TRIGGER trg_wiki_fts_ad AFTER DELETE ON wiki_articles BEGIN
  INSERT INTO wiki_articles_fts(wiki_articles_fts, rowid, title, body_md) VALUES ('delete', OLD.rowid, OLD.title, OLD.body_md);
END;
CREATE TRIGGER trg_wiki_fts_au AFTER UPDATE ON wiki_articles BEGIN
  INSERT INTO wiki_articles_fts(wiki_articles_fts, rowid, title, body_md) VALUES ('delete', OLD.rowid, OLD.title, OLD.body_md);
  INSERT INTO wiki_articles_fts(rowid, title, body_md)                    VALUES (NEW.rowid, NEW.title, NEW.body_md);
END;

CREATE VIRTUAL TABLE vec_wiki USING vec0(
  rowid INTEGER PRIMARY KEY,
  embedding FLOAT[1024]
);

-- Auto-stale a wiki article whose source memory changes (content or title).
-- Mirrors Postgres trigger trg_memories_mark_wiki_stale.
CREATE TRIGGER trg_memories_mark_wiki_stale
AFTER UPDATE OF content, title ON memories
BEGIN
  UPDATE wiki_articles
     SET status = 'stale'
   WHERE id IN (SELECT article_id FROM wiki_article_sources WHERE memory_id = NEW.id)
     AND status = 'fresh';
END;

-- Archive prior wiki revision on substantive update.
-- Mirrors Postgres trigger trg_wiki_archive_revision.
CREATE TRIGGER trg_wiki_archive_revision
BEFORE UPDATE ON wiki_articles
WHEN OLD.body_md IS NOT NEW.body_md
  OR OLD.title   IS NOT NEW.title
  OR OLD.summary IS NOT NEW.summary
BEGIN
  INSERT INTO wiki_article_revisions
    (id, article_id, revision, title, summary, body_md, tags, status,
     generated_by, generated_at, source_hash)
  VALUES
    (lower(hex(randomblob(16))), OLD.id, OLD.revision, OLD.title, OLD.summary,
     OLD.body_md, OLD.tags, OLD.status, OLD.generated_by, OLD.generated_at, OLD.source_hash);
END;
