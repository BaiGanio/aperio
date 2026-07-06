-- 007_self_wiki.sql — SQLite
-- Self-wiki: agent-authored synthesis over self_memories, upserted by slug.
-- Walled off from user-facing wiki (no FTS/vector — not yet needed).
-- FK depends on self_memories (006), so this must run after 006.

CREATE TABLE self_wiki_articles (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  summary       TEXT,
  body_md       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  status        TEXT NOT NULL DEFAULT 'fresh' CHECK (status IN ('fresh','stale')),
  generated_by  TEXT,
  generated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_hash   TEXT,
  revision      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_self_wiki_status ON self_wiki_articles(status);

CREATE TABLE self_wiki_article_sources (
  article_id  TEXT NOT NULL REFERENCES self_wiki_articles(id) ON DELETE CASCADE,
  memory_id   TEXT NOT NULL REFERENCES self_memories(id)      ON DELETE CASCADE,
  PRIMARY KEY (article_id, memory_id)
);
CREATE INDEX idx_self_wiki_sources_memory ON self_wiki_article_sources(memory_id);

CREATE TABLE self_wiki_article_revisions (
  id            TEXT PRIMARY KEY,
  article_id    TEXT NOT NULL REFERENCES self_wiki_articles(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT,
  body_md       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL,
  generated_by  TEXT,
  generated_at  TEXT NOT NULL,
  source_hash   TEXT,
  archived_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (article_id, revision)
);
CREATE INDEX idx_self_wiki_revisions_article ON self_wiki_article_revisions(article_id);

-- Auto-stale self-wiki when source self-memory changes.
CREATE TRIGGER trg_self_memories_mark_self_wiki_stale
AFTER UPDATE OF content, title ON self_memories
BEGIN
  UPDATE self_wiki_articles
     SET status = 'stale'
   WHERE id IN (SELECT article_id FROM self_wiki_article_sources WHERE memory_id = NEW.id)
     AND status = 'fresh';
END;

-- Archive prior self-wiki revision on substantive update.
CREATE TRIGGER trg_self_wiki_archive_revision
BEFORE UPDATE ON self_wiki_articles
WHEN OLD.body_md IS NOT NEW.body_md
  OR OLD.title   IS NOT NEW.title
  OR OLD.summary IS NOT NEW.summary
BEGIN
  INSERT INTO self_wiki_article_revisions
    (id, article_id, revision, title, summary, body_md, tags, status,
     generated_by, generated_at, source_hash)
  VALUES
    (lower(hex(randomblob(16))), OLD.id, OLD.revision, OLD.title, OLD.summary,
     OLD.body_md, OLD.tags, OLD.status, OLD.generated_by, OLD.generated_at, OLD.source_hash);
END;
