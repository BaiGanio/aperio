-- ============================================================
-- Aperio - Wiki articles (LLM-authored projections over memories)
-- ============================================================

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

-- Keep FTS in sync with title/body.
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

-- When a cited memory's content changes, mark dependent articles stale.
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
