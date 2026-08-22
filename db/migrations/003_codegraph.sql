-- 003_codegraph.sql — Postgres
-- Pre-indexed code knowledge graph for symbol search and call graphs.

CREATE TABLE cg_repos (
  id              SERIAL PRIMARY KEY,
  root_path       TEXT NOT NULL UNIQUE,
  last_indexed_at TIMESTAMPTZ
);

CREATE TABLE cg_files (
  id        SERIAL PRIMARY KEY,
  repo_id   INT  NOT NULL REFERENCES cg_repos(id) ON DELETE CASCADE,
  path      TEXT NOT NULL,
  language  TEXT NOT NULL,
  sha256    TEXT NOT NULL,
  mtime     TIMESTAMPTZ NOT NULL,
  UNIQUE (repo_id, path)
);
CREATE INDEX idx_cg_files_repo ON cg_files(repo_id);

CREATE TABLE cg_symbols (
  id         BIGSERIAL PRIMARY KEY,
  file_id    INT  NOT NULL REFERENCES cg_files(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  qualified  TEXT NOT NULL,
  start_line INT  NOT NULL,
  end_line   INT  NOT NULL,
  signature  TEXT,
  doc        TEXT,
  embedding  vector(1024)
);
CREATE INDEX idx_cg_symbols_qualified ON cg_symbols(qualified);
CREATE INDEX idx_cg_symbols_name      ON cg_symbols(name);
CREATE INDEX idx_cg_symbols_file      ON cg_symbols(file_id);
CREATE INDEX idx_cg_symbols_fts       ON cg_symbols
  USING GIN(to_tsvector('simple', name || ' ' || COALESCE(doc, '')));
CREATE INDEX idx_cg_symbols_embedding ON cg_symbols
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE cg_edges (
  id              BIGSERIAL PRIMARY KEY,
  src_symbol_id   BIGINT NOT NULL REFERENCES cg_symbols(id) ON DELETE CASCADE,
  dst_symbol_id   BIGINT REFERENCES cg_symbols(id) ON DELETE SET NULL,
  dst_unresolved  TEXT,
  kind            TEXT NOT NULL,
  src_line        INT
);
CREATE INDEX idx_cg_edges_src  ON cg_edges(src_symbol_id, kind);
CREATE INDEX idx_cg_edges_dst  ON cg_edges(dst_symbol_id, kind);
CREATE INDEX idx_cg_edges_unr  ON cg_edges(dst_unresolved) WHERE dst_unresolved IS NOT NULL;
