-- 004_docgraph.sql — Postgres
-- Document graph: indexes human-readable documents for passage search.

CREATE TABLE docgraph_repos (
  id              SERIAL PRIMARY KEY,
  root_path       TEXT NOT NULL UNIQUE,
  last_indexed_at TIMESTAMPTZ
);

CREATE TABLE docgraph_documents (
  id          SERIAL PRIMARY KEY,
  repo_id     INT  NOT NULL REFERENCES docgraph_repos(id) ON DELETE CASCADE,
  rel_path    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        BIGINT,
  mtime       TIMESTAMPTZ,
  sha256      TEXT NOT NULL,
  title       TEXT,
  summary     TEXT,
  indexed_at  TIMESTAMPTZ,
  UNIQUE (repo_id, rel_path)
);
CREATE INDEX idx_dd_repo ON docgraph_documents(repo_id);

CREATE TABLE docgraph_sections (
  id          BIGSERIAL PRIMARY KEY,
  document_id INT NOT NULL REFERENCES docgraph_documents(id) ON DELETE CASCADE,
  parent_id   BIGINT REFERENCES docgraph_sections(id) ON DELETE SET NULL,
  ord         INT NOT NULL DEFAULT 0,
  level       INT NOT NULL DEFAULT 1,
  heading     TEXT,
  text        TEXT
);
CREATE INDEX idx_ds_doc    ON docgraph_sections(document_id);
CREATE INDEX idx_ds_parent ON docgraph_sections(parent_id);

CREATE TABLE docgraph_chunks (
  id          BIGSERIAL PRIMARY KEY,
  document_id INT    NOT NULL REFERENCES docgraph_documents(id) ON DELETE CASCADE,
  section_id  BIGINT NOT NULL REFERENCES docgraph_sections(id) ON DELETE CASCADE,
  ord         INT    NOT NULL,
  text        TEXT   NOT NULL,
  token_count INT,
  embedding   vector(1024)
);
CREATE INDEX idx_dc_doc       ON docgraph_chunks(document_id);
CREATE INDEX idx_dc_section   ON docgraph_chunks(section_id);
CREATE INDEX idx_dc_fts       ON docgraph_chunks USING GIN(to_tsvector('simple', text));
CREATE INDEX idx_dc_embedding ON docgraph_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE docgraph_refs (
  id          BIGSERIAL PRIMARY KEY,
  document_id INT    NOT NULL REFERENCES docgraph_documents(id) ON DELETE CASCADE,
  section_id  BIGINT REFERENCES docgraph_sections(id) ON DELETE SET NULL,
  kind        TEXT   NOT NULL,
  value       TEXT   NOT NULL
);
CREATE INDEX idx_dr_value      ON docgraph_refs(value);
CREATE INDEX idx_dr_kind_value ON docgraph_refs(kind, value);
