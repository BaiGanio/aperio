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
