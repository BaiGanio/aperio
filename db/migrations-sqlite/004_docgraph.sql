-- 004_docgraph.sql — SQLite
-- Document graph: indexes human-readable documents for passage search.
-- FTS5 + sqlite-vec for hybrid search.

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

-- FTS5 over chunk text.
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

-- Embedding sidecar (rowid = docgraph_chunks.id).
CREATE VIRTUAL TABLE vec_docgraph_chunks USING vec0(
  rowid INTEGER PRIMARY KEY,
  embedding FLOAT[1024]
);
CREATE TRIGGER trg_docgraph_chunks_vec_cleanup AFTER DELETE ON docgraph_chunks BEGIN
  DELETE FROM vec_docgraph_chunks WHERE rowid = OLD.id;
END;

-- Cross-document references.
CREATE TABLE docgraph_refs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES docgraph_documents(id) ON DELETE CASCADE,
  section_id  INTEGER REFERENCES docgraph_sections(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL
);
CREATE INDEX idx_dr_value      ON docgraph_refs(value);
CREATE INDEX idx_dr_kind_value ON docgraph_refs(kind, value);
