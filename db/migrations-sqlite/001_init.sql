-- 001_init.sql — consolidated first-run schema.
-- Single migration: base + settings + codegraph + docgraph.

-- ===== base =====
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


-- ===== settings =====
-- 002_settings.sql (SQLite)
-- Key/value preferences. JSON stored as TEXT, validated.

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);


-- ===== codegraph =====
-- 003_codegraph.sql (SQLite)
-- Same shape as db/migrations/003_codegraph.sql (Postgres). FTS5 replaces
-- tsvector+GIN; sqlite-vec virtual tables replace pgvector + HNSW.

CREATE TABLE cg_repos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  root_path       TEXT NOT NULL UNIQUE,
  last_indexed_at TEXT
);

CREATE TABLE cg_files (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id   INTEGER NOT NULL REFERENCES cg_repos(id) ON DELETE CASCADE,
  path      TEXT NOT NULL,
  language  TEXT NOT NULL,
  sha256    TEXT NOT NULL,
  mtime     TEXT NOT NULL,
  UNIQUE (repo_id, path)
);
CREATE INDEX idx_cg_files_repo ON cg_files(repo_id);

CREATE TABLE cg_symbols (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id    INTEGER NOT NULL REFERENCES cg_files(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  qualified  TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  signature  TEXT,
  doc        TEXT
);
CREATE INDEX idx_cg_symbols_qualified ON cg_symbols(qualified);
CREATE INDEX idx_cg_symbols_name      ON cg_symbols(name);
CREATE INDEX idx_cg_symbols_file      ON cg_symbols(file_id);

CREATE VIRTUAL TABLE cg_symbols_fts USING fts5(
  name, doc,
  content='cg_symbols',
  content_rowid='id'
);
CREATE TRIGGER trg_cg_symbols_fts_ai AFTER INSERT ON cg_symbols BEGIN
  INSERT INTO cg_symbols_fts(rowid, name, doc) VALUES (NEW.id, NEW.name, COALESCE(NEW.doc, ''));
END;
CREATE TRIGGER trg_cg_symbols_fts_ad AFTER DELETE ON cg_symbols BEGIN
  INSERT INTO cg_symbols_fts(cg_symbols_fts, rowid, name, doc) VALUES ('delete', OLD.id, OLD.name, COALESCE(OLD.doc, ''));
END;
CREATE TRIGGER trg_cg_symbols_fts_au AFTER UPDATE ON cg_symbols BEGIN
  INSERT INTO cg_symbols_fts(cg_symbols_fts, rowid, name, doc) VALUES ('delete', OLD.id, OLD.name, COALESCE(OLD.doc, ''));
  INSERT INTO cg_symbols_fts(rowid, name, doc)                 VALUES (NEW.id, NEW.name, COALESCE(NEW.doc, ''));
END;

-- Embedding store. rowid here is the cg_symbols.id (FK enforced by trigger
-- below). Postgres puts the embedding in the same row; SQLite needs a sidecar
-- virtual table.
CREATE VIRTUAL TABLE vec_cg_symbols USING vec0(
  rowid INTEGER PRIMARY KEY,
  embedding FLOAT[1024]
);
-- Cascade deletes from cg_symbols → vec_cg_symbols (vec0 doesn't honor FKs).
CREATE TRIGGER trg_cg_symbols_vec_cleanup AFTER DELETE ON cg_symbols BEGIN
  DELETE FROM vec_cg_symbols WHERE rowid = OLD.id;
END;

CREATE TABLE cg_edges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  src_symbol_id   INTEGER NOT NULL REFERENCES cg_symbols(id) ON DELETE CASCADE,
  dst_symbol_id   INTEGER          REFERENCES cg_symbols(id) ON DELETE SET NULL,
  dst_unresolved  TEXT,
  kind            TEXT NOT NULL,
  src_line        INTEGER
);
CREATE INDEX idx_cg_edges_src ON cg_edges(src_symbol_id, kind);
CREATE INDEX idx_cg_edges_dst ON cg_edges(dst_symbol_id, kind);
CREATE INDEX idx_cg_edges_unr ON cg_edges(dst_unresolved) WHERE dst_unresolved IS NOT NULL;


-- ── docgraph (document graph) ────────────────────────────────────────────────
-- Document-shaped sibling of codegraph: indexes folders of human content
-- (Markdown/text/HTML/PDF/DOCX) into documents → sections → chunks, with FTS5 +
-- sqlite-vec for hybrid search. Section text is stored (not re-sliced from the
-- source file) so doc_context works uniformly across formats, including binary
-- ones where file offsets are meaningless.

CREATE TABLE docgraph_repos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  root_path       TEXT NOT NULL UNIQUE,
  last_indexed_at TEXT
);

CREATE TABLE docgraph_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES docgraph_repos(id) ON DELETE CASCADE,
  rel_path    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER,
  mtime       TEXT,
  sha256      TEXT NOT NULL,
  title       TEXT,
  summary     TEXT,
  indexed_at  TEXT,
  UNIQUE (repo_id, rel_path)
);
CREATE INDEX idx_dd_repo ON docgraph_documents(repo_id);

CREATE TABLE docgraph_sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES docgraph_documents(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES docgraph_sections(id) ON DELETE SET NULL,
  ord         INTEGER NOT NULL DEFAULT 0,
  level       INTEGER NOT NULL DEFAULT 1,
  heading     TEXT,
  text        TEXT
);
CREATE INDEX idx_ds_doc    ON docgraph_sections(document_id);
CREATE INDEX idx_ds_parent ON docgraph_sections(parent_id);

CREATE TABLE docgraph_chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES docgraph_documents(id) ON DELETE CASCADE,
  section_id  INTEGER NOT NULL REFERENCES docgraph_sections(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  token_count INTEGER
);
CREATE INDEX idx_dc_doc     ON docgraph_chunks(document_id);
CREATE INDEX idx_dc_section ON docgraph_chunks(section_id);

-- External-content FTS5 over chunk text. BM25 rank is negated at query time so
-- larger = better (uniform with vec scores).
CREATE VIRTUAL TABLE docgraph_fts USING fts5(
  text,
  content='docgraph_chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER trg_docgraph_fts_ai AFTER INSERT ON docgraph_chunks BEGIN
  INSERT INTO docgraph_fts(rowid, text) VALUES (NEW.id, NEW.text);
END;
CREATE TRIGGER trg_docgraph_fts_ad AFTER DELETE ON docgraph_chunks BEGIN
  INSERT INTO docgraph_fts(docgraph_fts, rowid, text) VALUES ('delete', OLD.id, OLD.text);
END;
CREATE TRIGGER trg_docgraph_fts_au AFTER UPDATE ON docgraph_chunks BEGIN
  INSERT INTO docgraph_fts(docgraph_fts, rowid, text) VALUES ('delete', OLD.id, OLD.text);
  INSERT INTO docgraph_fts(rowid, text)                VALUES (NEW.id, NEW.text);
END;

-- Embedding sidecar. rowid = docgraph_chunks.id. vec0 doesn't honor FKs, so a
-- delete trigger keeps it in sync.
CREATE VIRTUAL TABLE vec_docgraph_chunks USING vec0(
  rowid INTEGER PRIMARY KEY,
  embedding FLOAT[1024]
);
CREATE TRIGGER trg_docgraph_chunks_vec_cleanup AFTER DELETE ON docgraph_chunks BEGIN
  DELETE FROM vec_docgraph_chunks WHERE rowid = OLD.id;
END;

-- Cross-document references (Phase 5 populates these; table ships now so later
-- phases are additive).
CREATE TABLE docgraph_refs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES docgraph_documents(id) ON DELETE CASCADE,
  section_id  INTEGER REFERENCES docgraph_sections(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL
);
CREATE INDEX idx_dr_value      ON docgraph_refs(value);
CREATE INDEX idx_dr_kind_value ON docgraph_refs(kind, value);
