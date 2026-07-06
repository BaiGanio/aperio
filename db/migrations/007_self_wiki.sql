-- 007_self_wiki.sql — Postgres
-- Self-wiki: agent-authored synthesis over self_memories, upserted by slug.
-- Walled off from user-facing wiki (no search_vector/embedding — not yet needed).
-- FK depends on self_memories (006), so this must run after 006.

CREATE TABLE self_wiki_articles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  summary       TEXT,
  body_md       TEXT NOT NULL,
  tags          TEXT[],
  status        TEXT NOT NULL DEFAULT 'fresh' CHECK (status IN ('fresh','stale')),
  generated_by  TEXT,
  generated_at  TIMESTAMPTZ DEFAULT now(),
  source_hash   TEXT,
  revision      INT NOT NULL DEFAULT 1
);
CREATE INDEX idx_self_wiki_status ON self_wiki_articles(status);

CREATE TABLE self_wiki_article_sources (
  article_id  UUID NOT NULL REFERENCES self_wiki_articles(id) ON DELETE CASCADE,
  memory_id   UUID NOT NULL REFERENCES self_memories(id)      ON DELETE CASCADE,
  PRIMARY KEY (article_id, memory_id)
);
CREATE INDEX idx_self_wiki_sources_memory ON self_wiki_article_sources(memory_id);

CREATE TABLE self_wiki_article_revisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id    UUID NOT NULL REFERENCES self_wiki_articles(id) ON DELETE CASCADE,
  revision      INT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT,
  body_md       TEXT NOT NULL,
  tags          TEXT[],
  status        TEXT NOT NULL,
  generated_by  TEXT,
  generated_at  TIMESTAMPTZ NOT NULL,
  source_hash   TEXT,
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (article_id, revision)
);
CREATE INDEX idx_self_wiki_revisions_article ON self_wiki_article_revisions(article_id);

-- Auto-stale self-wiki when source self-memory changes.
CREATE OR REPLACE FUNCTION mark_self_wiki_stale()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE self_wiki_articles
     SET status = 'stale'
   WHERE id IN (SELECT article_id FROM self_wiki_article_sources WHERE memory_id = NEW.id)
     AND status = 'fresh';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_self_memories_mark_self_wiki_stale
AFTER UPDATE OF content, title ON self_memories
FOR EACH ROW EXECUTE FUNCTION mark_self_wiki_stale();

-- Archive self-wiki revision on substantive update.
CREATE OR REPLACE FUNCTION archive_self_wiki_revision()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.body_md IS DISTINCT FROM NEW.body_md
     OR OLD.title   IS DISTINCT FROM NEW.title
     OR OLD.summary IS DISTINCT FROM NEW.summary
  THEN
    INSERT INTO self_wiki_article_revisions
      (article_id, revision, title, summary, body_md, tags, status,
       generated_by, generated_at, source_hash)
    VALUES
      (OLD.id, OLD.revision, OLD.title, OLD.summary, OLD.body_md, OLD.tags, OLD.status,
       OLD.generated_by, OLD.generated_at, OLD.source_hash);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_self_wiki_archive_revision
BEFORE UPDATE ON self_wiki_articles
FOR EACH ROW EXECUTE FUNCTION archive_self_wiki_revision();
