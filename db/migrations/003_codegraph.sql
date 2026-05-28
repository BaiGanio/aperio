-- 003_codegraph.sql
-- Pre-indexed code knowledge graph. Lets the LLM query symbols/edges
-- instead of reading dozens of files to answer "who calls X?", "what
-- does Y import?", "show me Z's body".
--
-- v0.1: schema + JS/TS indexer. Embeddings come later (cg_symbols.embedding
-- column is here from day one so we don't need a follow-up migration).

CREATE TABLE cg_repos (
  id              SERIAL PRIMARY KEY,
  root_path       TEXT NOT NULL UNIQUE,
  last_indexed_at TIMESTAMPTZ
);

CREATE TABLE cg_files (
  id        SERIAL PRIMARY KEY,
  repo_id   INT  NOT NULL REFERENCES cg_repos(id) ON DELETE CASCADE,
  path      TEXT NOT NULL,                       -- repo-relative
  language  TEXT NOT NULL,                       -- 'js','ts','jsx','tsx',...
  sha256    TEXT NOT NULL,                       -- content hash for incremental reindex
  mtime     TIMESTAMPTZ NOT NULL,
  UNIQUE (repo_id, path)
);
CREATE INDEX idx_cg_files_repo ON cg_files(repo_id);

CREATE TABLE cg_symbols (
  id         BIGSERIAL PRIMARY KEY,
  file_id    INT  NOT NULL REFERENCES cg_files(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                      -- function|class|method|const|type|import
  name       TEXT NOT NULL,
  qualified  TEXT NOT NULL,                      -- 'path/to/file.js::Class.method'
  start_line INT  NOT NULL,
  end_line   INT  NOT NULL,
  signature  TEXT,                               -- one-line preview
  doc        TEXT,                               -- leading comment / docstring
  embedding  vector(1024)                        -- nullable; populated in v0.2
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
  dst_unresolved  TEXT,                          -- target name when symbol can't be resolved
  kind            TEXT NOT NULL,                 -- calls|imports|extends|references
  src_line        INT
);
CREATE INDEX idx_cg_edges_src  ON cg_edges(src_symbol_id, kind);
CREATE INDEX idx_cg_edges_dst  ON cg_edges(dst_symbol_id, kind);
CREATE INDEX idx_cg_edges_unr  ON cg_edges(dst_unresolved) WHERE dst_unresolved IS NOT NULL;
