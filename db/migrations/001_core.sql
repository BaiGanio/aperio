-- 001_core.sql — Postgres
-- Core schema: memories, wiki, settings.
-- All columns inline, all types included, no ALTER TABLE additions anywhere.

-- ===== Extensions =====
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS vector;

-- ===== MEMORIES =====
CREATE TABLE memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL CHECK (type IN (
                  'fact','preference','project','decision',
                  'solution','source','person','inference','workflow'
                )),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT[],
  importance    INT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  tier          INT NOT NULL DEFAULT 1 CHECK (tier IN (1, 2, 3)),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  source        TEXT DEFAULT 'manual',
  lang          TEXT NOT NULL DEFAULT 'english',
  search_vector TSVECTOR,
  embedding     vector(1024),
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until   TIMESTAMPTZ,
  confidence    FLOAT NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0),
  pinned        BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_memories_type       ON memories(type);
CREATE INDEX idx_memories_tags       ON memories USING GIN(tags);
CREATE INDEX idx_memories_importance ON memories(importance DESC);
CREATE INDEX idx_memories_fts        ON memories USING GIN(search_vector);
CREATE INDEX idx_memories_temporal   ON memories(valid_from, valid_until);
CREATE INDEX idx_memories_current    ON memories(id) WHERE valid_until IS NULL;
CREATE INDEX idx_memories_pinned     ON memories(pinned) WHERE pinned = true;
CREATE INDEX idx_memories_tier       ON memories(tier);
CREATE INDEX idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Auto-update search_vector from title + content + lang.
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

-- Auto-update updated_at.
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

-- View for backfill.
CREATE OR REPLACE VIEW memories_without_embeddings AS
SELECT id, title, content, type, tags
FROM memories
WHERE embedding IS NULL;

-- ===== WIKI =====
CREATE TABLE wiki_articles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  summary       TEXT,
  body_md       TEXT NOT NULL,
  tags          TEXT[],
  status        TEXT NOT NULL DEFAULT 'fresh'
                CHECK (status IN ('fresh','stale','draft','archived')),
  generated_by  TEXT,
  generated_at  TIMESTAMPTZ DEFAULT now(),
  source_hash   TEXT,
  revision      INT NOT NULL DEFAULT 1,
  search_vector TSVECTOR,
  embedding     vector(1024)
);

CREATE INDEX idx_wiki_tags      ON wiki_articles USING GIN(tags);
CREATE INDEX idx_wiki_fts       ON wiki_articles USING GIN(search_vector);
CREATE INDEX idx_wiki_status    ON wiki_articles(status);
CREATE INDEX idx_wiki_embedding ON wiki_articles
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE wiki_article_sources (
  article_id  UUID NOT NULL REFERENCES wiki_articles(id) ON DELETE CASCADE,
  memory_id   UUID NOT NULL REFERENCES memories(id)       ON DELETE CASCADE,
  weight      FLOAT DEFAULT 1.0,
  PRIMARY KEY (article_id, memory_id)
);
CREATE INDEX idx_wiki_sources_memory ON wiki_article_sources(memory_id);

CREATE TABLE wiki_article_revisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id    UUID NOT NULL REFERENCES wiki_articles(id) ON DELETE CASCADE,
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
CREATE INDEX idx_wiki_revisions_article ON wiki_article_revisions(article_id);

-- Wiki search_vector trigger.
CREATE OR REPLACE FUNCTION update_wiki_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple', NEW.title || ' ' || NEW.body_md);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_wiki_search_vector
BEFORE INSERT OR UPDATE OF title, body_md ON wiki_articles
FOR EACH ROW EXECUTE FUNCTION update_wiki_search_vector();

-- Auto-stale wiki when source memory changes.
CREATE OR REPLACE FUNCTION mark_wiki_stale()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE wiki_articles
     SET status = 'stale'
   WHERE id IN (SELECT article_id FROM wiki_article_sources WHERE memory_id = NEW.id)
     AND status = 'fresh';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_memories_mark_wiki_stale
AFTER UPDATE OF content, title ON memories
FOR EACH ROW EXECUTE FUNCTION mark_wiki_stale();

-- Archive wiki revision on substantive update (not status-only changes).
CREATE OR REPLACE FUNCTION archive_wiki_revision()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.body_md IS DISTINCT FROM NEW.body_md
     OR OLD.title   IS DISTINCT FROM NEW.title
     OR OLD.summary IS DISTINCT FROM NEW.summary
  THEN
    INSERT INTO wiki_article_revisions
      (article_id, revision, title, summary, body_md, tags, status,
       generated_by, generated_at, source_hash)
    VALUES
      (OLD.id, OLD.revision, OLD.title, OLD.summary, OLD.body_md, OLD.tags, OLD.status,
       OLD.generated_by, OLD.generated_at, OLD.source_hash);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_wiki_archive_revision
BEFORE UPDATE ON wiki_articles
FOR EACH ROW EXECUTE FUNCTION archive_wiki_revision();

-- ===== SETTINGS =====
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
