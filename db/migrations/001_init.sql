-- 001_init.sql — consolidated first-run schema.
-- Single migration: base + settings + codegraph.

-- ===== base =====
-- ============================================================
-- Aperio - Initial Schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- MEMORIES
-- ============================================================
CREATE TABLE memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL CHECK (type IN (
                  'fact', 'preference', 'project',
                  'decision', 'solution', 'source', 'person', 'inference'
                )),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT[],
  importance    INT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
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
CREATE INDEX idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

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

CREATE OR REPLACE VIEW memories_without_embeddings AS
SELECT id, title, content, type, tags
FROM memories
WHERE embedding IS NULL;

-- ============================================================
-- WIKI
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

-- Guards status-only UPDATEs (e.g. mark_wiki_stale) from polluting revision history.
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

-- ============================================================
-- SEED — Memories
-- ============================================================
INSERT INTO memories (type, title, content, tags, importance) VALUES
(
  'fact',
  'Core Value: Privacy and Data Ownership',
  'Privacy and data ownership are core values — deeply embedded in system design, not just enabled via feature flags. All implementations must prioritize user control and transparency by default.',
  ARRAY['privacy', 'data ownership', 'core value', 'principle'],
  5
),
(
  'project',
  'Aperio — Mission',
  'Aperio''s primary goal is to demonstrate that personal AI tools can be fully functional without requiring cloud infrastructure — proving the viability of self-hosted, privacy-first AI solutions.',
  ARRAY['aperio', 'local AI', 'self-hosted', 'personal AI'],
  5
),
(
  'project',
  'Aperio — Technology Stack',
  'The Aperio project stack: Node.js, Postgres 16, pgvector, Docker, Express, WebSocket, and Ollama with mxbai-embed-large for embeddings. Aperio-lite uses SQLite with sqlite-vec as a zero-config vector database for non-Docker users.',
  ARRAY['aperio', 'node.js', 'postgres', 'pgvector', 'docker', 'ollama', 'sqlite'],
  4
),
(
  'fact',
  'Aperio Port',
  'Aperio runs on port 31337 — the l33t (ELITE) port, originally used by the group Cult of the Dead Cow in 1998.',
  ARRAY['aperio', 'port', '31337'],
  3
),
(
  'preference',
  'Preference for Clean and Minimal Code',
  'Prefer clean, minimal code over over-engineered solutions. Comments should explain WHY, not WHAT. Clever one-liners that sacrifice readability are always the wrong call.',
  ARRAY['coding', 'style', 'minimalism'],
  4
),
(
  'preference',
  'Preference for Simplicity Over Abstraction',
  'Unnecessary abstraction layers are a code smell. Prefer simple, direct solutions — three similar lines are better than a premature abstraction.',
  ARRAY['simplicity', 'abstraction', 'architecture'],
  4
),
(
  'preference',
  'Answer Before Details',
  'Give the answer first. Provide supporting details only if explicitly requested or clearly necessary — avoid front-loading explanations.',
  ARRAY['communication', 'conciseness', 'answer-first'],
  4
),
(
  'preference',
  'Preference for Decision Explanations',
  'Always explain the reasoning behind a decision, not just the outcome. Understanding WHY matters as much as knowing WHAT was decided.',
  ARRAY['communication', 'decision rationale', 'transparency'],
  4
),
(
  'preference',
  'Brutal Honesty in Feedback',
  'Give brutally honest feedback — in code reviews and general assessments. Call out issues directly without diplomatic sugarcoating.',
  ARRAY['feedback', 'code review', 'honesty'],
  4
),
(
  'preference',
  'Dark Theme',
  'Prefer dark themes across all tools — editors, terminals, browsers. Consistent dark UI reduces eye strain during long sessions.',
  ARRAY['ui', 'dark mode', 'tooling'],
  3
),
(
  'preference',
  'Code Examples Over Prose',
  'When explaining technical concepts, prefer code examples over prose. Code is unambiguous, copy-pasteable, and immediately testable — prose is not.',
  ARRAY['communication', 'code examples', 'technical explanations'],
  4
),
(
  'preference',
  'Real-World Examples with Actual Data',
  'When illustrating a concept, use real-world examples backed by real data, links, or references wherever available — not contrived toy examples. E.g. link to an actual dataset, a real API response, a live doc page, or a well-known case study.',
  ARRAY['communication', 'examples', 'real data', 'references', 'links'],
  4
);

-- ============================================================
-- SEED — Wiki baseline articles
-- Embeddings are NULL here — backfilled at server startup.
-- ============================================================

INSERT INTO wiki_articles (slug, title, summary, body_md, tags, generated_by, source_hash, revision)
VALUES (

'aperio-architecture',
'Aperio — Architecture Overview',
'Component map, data flow, and technology stack for the Aperio personal AI system.',
$art1$
## What Aperio Is

Aperio is a self-hosted, privacy-first personal AI assistant. It runs entirely on the user's
machine — no telemetry, no cloud sync. The binary footprint is a Node.js process; the only
optional external dependency is a running Ollama daemon (or a cloud API key).

## Runtime Components

| Component | File | Role |
|---|---|---|
| HTTP + WebSocket server | `server.js` | Entrypoint; mounts Express routes and WS handler |
| REST API | `lib/routes/api.js` | `/api/*` — memories, wiki, sessions, status |
| WebSocket handler | `lib/ws/` | Real-time chat; streams tokens to the browser |
| MCP subprocess | `mcp/` | Tool execution (remember, recall, wiki_*) in a child process |
| DB store | `db/index.js` | Resolves SQLite vs Postgres; exposes a unified store interface |
| Skills loader | `skills/` | Injects SKILL.md prompt fragments into the system message |
| Agent | `lib/agent/` | Provider-agnostic LLM wrapper; handles streaming + tool loop |

## Request Flow (Chat)

1. Browser → WebSocket → WS handler
2. WS handler builds system prompt (base + injected skills)
3. Agent streams tokens back; tool calls are routed to the MCP subprocess
4. MCP tools read/write the DB store; results are fed back into the tool loop
5. Final assistant message is appended to the session log

## Key Ports and Paths

- Default port: **31337** (set via `PORT` env)
- DB data: `.sqlite/aperio.db` (SQLite) or Docker Postgres volume
- Sessions: `data/sessions/`
- Skills: `skills/<name>/SKILL.md`

## See Also

[[db-backends]] [[ai-providers]] [[mcp-tools]] [[skills-system]]
$art1$,
ARRAY['aperio','architecture','overview','server'],
'system', '', 1

),(

'memory-system',
'Memory System — Types, Lifecycle, and Recall',
'How Aperio stores, versions, and retrieves memories, including temporal semantics and search modes.',
$art2$
## Memory Types

Every memory has a `type` field that scopes what kind of knowledge it holds:

| Type | Use for |
|---|---|
| `fact` | Objective, durable truths |
| `preference` | User style/workflow preferences |
| `project` | Active project context, goals, deadlines |
| `decision` | Architectural or strategic choices + rationale |
| `solution` | Resolved problems; how something was fixed |
| `source` | External references (URLs, docs, people) |
| `person` | Information about a person |

## Temporal Versioning

Memories are never deleted in place — they are **tombstoned**.

- Every row has `valid_from` (ISO timestamp) and `valid_until` (null = current).
- When a memory is updated, the old row gets `valid_until = now()` and a new row is inserted.
- `store.cache` only holds rows where `valid_until IS NULL` (current versions).
- Historical snapshots are preserved for audit and point-in-time recall (`asOf` parameter).

## Other Fields

- `importance` (1–5): influences ranking in recall; higher = surfaces first in BM25 fallback
- `confidence` (0.0–1.0): model self-assessed certainty; default 1.0
- `expires_at`: optional TTL; expired rows are filtered out of all recall paths
- `source`: `manual` (user-typed), `mcp` (tool-written), `system` (seed data)

## Recall Modes

| Mode | Strategy |
|---|---|
| `auto` | Hybrid: vector search + BM25, merged via Reciprocal Rank Fusion (RRF) |
| `semantic` | Vector cosine similarity only |
| `fulltext` | BM25 over title + content only (no embeddings needed) |

## In-Memory Cache

`store.cache` is a snapshot of all current rows loaded at startup and refreshed on each
`checkoutLatest()` call. The MCP subprocess writes to the same files; calling `refreshCache()`
before sensitive reads ensures cross-process consistency.

## See Also

[[embeddings]] [[db-backends]] [[mcp-tools]]
$art2$,
ARRAY['memory','sqlite','recall','temporal','embeddings'],
'system', '', 1

),(

'db-backends',
'Database Backends — SQLite vs Postgres',
'How Aperio selects a storage backend at startup, and what differs between SQLite and Postgres.',
$art3$
## Backend Resolution Order

At startup `db/index.js` resolves the backend in this order:

1. `DB_BACKEND` env var — `'sqlite'` or `'postgres'` (explicit, always wins)
2. Auto-detect — pings Docker; if reachable → Postgres, else → SQLite
3. Safety fallback — SQLite (zero-config, always works)

## SQLite (default for non-Docker users)

- **Embedded**: runs inside the Node.js process via `better-sqlite3`, no daemon needed.
- **Storage**: a single file at `.sqlite/aperio.db` (set via `SQLITE_PATH`).
- **Tables**: `memories` + `wiki_articles`, each paired with a `vec_*` (sqlite-vec)
  and a `*_fts` (FTS5) virtual table, joined by `rowid`.
- **Vector search**: sqlite-vec `vec0` virtual table; KNN via `embedding MATCH ? AND k = …`.
- **FTS**: FTS5 + BM25, kept in sync by AFTER INSERT/UPDATE/DELETE triggers.
- **Hybrid search**: RRF merge of vector + FTS5 results, computed in JS.

## Postgres (Docker users)

- **External**: requires Docker + the `pgvector` extension.
- **Vector search**: HNSW index (`embedding vector_cosine_ops`, m=16, ef=64).
- **FTS**: native `tsvector` + `plainto_tsquery` with GIN index.
- **Hybrid search**: single SQL CTE using `FULL OUTER JOIN` for RRF.
- **Triggers**: `trg_memories_mark_wiki_stale` auto-marks wiki articles stale when
  a cited memory's content or title changes.

## Behavioural Differences

| Feature | SQLite | Postgres |
|---|---|---|
| Wiki stale-marking | Trigger present, no-op under tombstone+insert | Automatic via DB trigger |
| Source memory validation | `store.cache` lookup | `SELECT … WHERE id = ANY($1)` |
| Embedding storage | sqlite-vec `vec0` (float32) | `vector(1024)` pgvector type |

## Resetting SQLite

```bash
rm -f .sqlite/aperio.db && node server.js
```

Tables and seed data are re-created on next start.

## See Also

[[aperio-architecture]] [[memory-system]] [[embeddings]]
$art3$,
ARRAY['sqlite','postgres','database','architecture','docker'],
'system', '', 1

),(

'ai-providers',
'AI Providers — LLM and Embedding Configuration',
'Supported LLM and embedding providers, environment variables, and the wiki refresh provider pattern.',
$art4$
## Main LLM Provider

Set via `AI_PROVIDER` env var:

| Value | Notes |
|---|---|
| `ollama` | Local; requires Ollama daemon. Set `OLLAMA_MODEL` and `OLLAMA_BASE_URL`. |
| `anthropic` | Cloud; requires `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`. |
| `deepseek` | Cloud; requires `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL`. |
| `gemini` | Cloud; requires `GEMINI_API_KEY` and `GEMINI_MODEL`. |

## Embedding Provider

Set via `EMBEDDING_PROVIDER`:

| Value | Model | Notes |
|---|---|---|
| `transformers` | `mixedbread-ai/mxbai-embed-large-v1` (ONNX q8) | Default. Fully local; 1024 dims. |
| `voyage` | Voyage AI | Cloud; requires `VOYAGE_API_KEY`. Free tier: 50M tokens/month. |

Changing providers after data exists requires wiping the database (dimension mismatch).

## Wiki Refresh Provider

`WIKI_REFRESH_PROVIDER` configures a separate, cheaper model used only to rewrite
stale wiki articles on `wiki_get(refresh=true)`. Format: `provider:model`.

```
WIKI_REFRESH_PROVIDER=ollama:llama3.1
WIKI_REFRESH_PROVIDER=deepseek:deepseek-chat
WIKI_REFRESH_PROVIDER=anthropic:claude-haiku-4-5-20251001
```

Opt-in. If unset, refresh calls degrade gracefully. Set `WIKI_REFRESH_AUTOSTART_OLLAMA=true`
to auto-launch the Ollama daemon when the refresh provider is `ollama:*`.

## Roundtable (Multi-Agent)

`ROUNDTABLE_AGENTS` enables multi-model discussions. Format: comma-separated `provider:model` pairs.

```
ROUNDTABLE_AGENTS=anthropic:claude-haiku-4-5-20251001,deepseek:deepseek-chat
ROUNDTABLE_MAX_ROUNDS=3
```

## See Also

[[aperio-architecture]] [[embeddings]] [[wiki-workflow]]
$art4$,
ARRAY['providers','ollama','anthropic','deepseek','gemini','embeddings','configuration'],
'system', '', 1

),(

'mcp-tools',
'MCP Tools — Full Tool Surface',
'All tools available to the LLM via the MCP subprocess: memory, wiki, files, shell, web, and image.',
$art5$
## How MCP Works in Aperio

The MCP server runs as a **child process** spawned at startup. The main LLM agent calls tools
via the MCP protocol; the subprocess executes them against the shared DB store and returns
structured results. All tools receive a `ctx` object: `{ store, generateEmbedding, agent }`.

## Memory Tools (`mcp/tools/memory.js`)

| Tool | Purpose |
|---|---|
| `remember` | Store a new memory. Fields: type, title, content, tags, importance, confidence, source. |
| `recall` | Retrieve memories by query. Modes: auto (hybrid), semantic, fulltext. |
| `update_memory` | Update an existing memory by id (tombstones old, inserts new). |
| `forget` | Delete a memory by id. |
| `backfill_embeddings` | Generate embeddings for memories that have zero vectors. |
| `deduplicate_memories` | Find near-duplicate memories by cosine similarity. |

## Wiki Tools (`mcp/tools/wiki.js`)

| Tool | Purpose |
|---|---|
| `wiki_write` | Create or update a wiki article. Upserts by slug; bumps revision. |
| `wiki_search` | Hybrid FTS + semantic search over articles. Always call before wiki_write. |
| `wiki_list` | Browse articles by tag/status/date. No query — for listing recent activity. |
| `wiki_get` | Fetch a full article by slug, with optional stale-refresh. |

## File Tools (`mcp/tools/files.js`)

- `write_file` — write text/code files to `/public/exports/`
- `write_xlsx` — generate Excel workbooks (multi-sheet, formatted)
- `write_pptx` — generate PowerPoint presentations with theme selection

## Other Tools

| File | Tools |
|---|---|
| `mcp/tools/shell.js` | `run_shell_command` — whitelisted shell commands |
| `mcp/tools/web.js` | `web_search`, `fetch_url` — read external web content |
| `mcp/tools/image.js` | `describe_image` — describe an image file or URL |

## See Also

[[memory-system]] [[wiki-workflow]] [[aperio-architecture]]
$art5$,
ARRAY['mcp','tools','memory','wiki','files','shell'],
'system', '', 1

),(

'skills-system',
'Skills System — Prompt Injection via SKILL.md',
'How Aperio loads and injects skill fragments into the LLM system prompt at conversation start.',
$art6$
## What a Skill Is

A skill is a markdown file (`SKILL.md`) inside `skills/<name>/`. The harness reads these files
at startup and injects their content into the LLM system prompt. Skills encode **behavioural rules**
— not factual knowledge (that belongs in memories or wiki articles).

## Available Skills

```
skills/
  agent-conduct/        tone, refusal policy, honesty rules
  coding-examples/      how to write code examples
  coding-standards/     code style and quality rules
  conversation-lifecycle/  session open/close protocol
  mcp-builder/          how to write new MCP tools
  memory-learning/      when and how to store memories
  memory-protocol/      recall-before-answer protocol
  pdf/                  working with PDF files
  pptx/                 generating PowerPoint files
  preprocess-image/     image handling
  preprocess-pdf/       PDF pre-processing
  prompt-optimizer/     prompt engineering rules
  reasoning-planning/   chain-of-thought planning
  theme-factory/        visual theme generation
  tool-integration/     generic tool usage rules
  wiki/                 wiki read/write/surface protocol
  working-with-files/   file I/O guidance
  xlsx/                 generating Excel files
```

## Skill File Format

```markdown
---
name: my-skill
description: >
  One-line description — used to decide whether to load the skill.
---

## Section

Rules and instructions in plain markdown.
```

## Adding a New Skill

1. Create `skills/<kebab-name>/SKILL.md` with frontmatter + body.
2. Restart the server — skills are loaded at startup, not hot-reloaded.
3. The `mcp-builder` skill documents the pattern for pairing a skill with a new MCP tool.

## See Also

[[aperio-architecture]] [[mcp-tools]] [[wiki-workflow]]
$art6$,
ARRAY['skills','system-prompt','configuration','llm'],
'system', '', 1

),(

'wiki-workflow',
'Wiki Workflow — Writing, Citing, and Surfacing Articles',
'The full lifecycle of a wiki article: when to write one, the recall→cite→write loop, staleness, and the breadcrumb protocol.',
$art7$
## When to Write a Wiki Article

Write an article when you notice you have stitched together **3 or more memories on the same topic**
to answer a question and the topic is likely to recur. Don't write articles for single-fact
lookups — use `recall` directly for those.

## The Write Loop

1. `wiki_search(topic)` — check whether an article already exists. If yes, update it
   (same slug, bumped revision) instead of creating a duplicate.
2. `recall(topic)` — gather the 8–12 most relevant memories.
3. Draft `body_md`; cite every factual claim inline as `[[mem:<uuid>]]`.
   Link sibling articles as `[[other-slug]]`.
4. `wiki_write(slug, title, summary, body_md, tags, source_memory_ids)` — pass the
   cited memory ids in `source_memory_ids` for provenance tracking.

## Slugs Are Immutable

Slugs are permanent once another article links to them. Confirm slug with the user on
first creation. Use lowercase kebab-case: `aperio-architecture`.

## Staleness

An article becomes **stale** when one of its source memories is updated.

- SQLite: under temporal versioning (tombstone + insert) the stale trigger is a no-op,
  so staleness surfaces lazily at read time.
- Postgres: a DB trigger (`trg_memories_mark_wiki_stale`) marks it automatically.

To recover: `wiki_get(slug, refresh=true)` rewrites via `WIKI_REFRESH_PROVIDER` if configured.

## The Breadcrumb Protocol

When you use a wiki article to answer the user, **copy the breadcrumb verbatim as the
first line of your reply**:

```
🔖 From wiki: [[aperio-architecture]] (rev 3 · fresh · updated 2026-05-17)
```

## Article Status Values

| Status | Meaning |
|---|---|
| `fresh` | Up-to-date; all source memories match the version the article was written against |
| `stale` | At least one source memory has changed since last write |
| `draft` | Work in progress; not ready for recall |
| `archived` | Retired; excluded from all searches unless explicitly requested |

## See Also

[[memory-system]] [[mcp-tools]] [[skills-system]]
$art7$,
ARRAY['wiki','workflow','citations','stale','breadcrumb'],
'system', '', 1

),(

'embeddings',
'Embeddings — Providers, Dimensions, and Search Modes',
'How vector embeddings are generated, stored, and used for recall and wiki search in Aperio.',
$art8$
## Default Provider: HuggingFace Transformers

`EMBEDDING_PROVIDER=transformers` runs `mixedbread-ai/mxbai-embed-large-v1` locally via ONNX Runtime (q8).

- **Dimensions**: 1024 (set via `EMBEDDING_DIMS`; default 1024)
- **Download**: automatic on first run, cached in `~/.cache/aperio/transformers`
- **No API key, no external service** — fully offline

## Alternative: Voyage AI

`EMBEDDING_PROVIDER=voyage` uses Voyage AI cloud embeddings.

- Requires `VOYAGE_API_KEY`
- Free tier: 50M tokens/month
- **Switching providers** after data exists requires wiping the database — dimensions must match exactly.

## What Gets Embedded

| Entity | Text used |
|---|---|
| Memory | `title + " " + content` |
| Wiki article | `title + ". " + summary + " " + body_md` |

## Dimension Mismatch Error

```
Vector dimension mismatch: table has 1024D but EMBEDDING_DIMS=384.
Either set EMBEDDING_DIMS=1024 or delete .sqlite/aperio.db to start fresh.
```

Fix: align `EMBEDDING_DIMS` to the table value, or `rm -f .sqlite/aperio.db` to start fresh.

## Zero Vectors and Backfill

Seed data and memories stored before the embedding provider is available have a zero vector.
These rows are excluded from semantic search but appear in BM25 fulltext results.
The server **automatically backfills** zero-vector rows in the background at startup —
both memories and wiki articles are covered. Run `backfill_embeddings` (MCP tool) to
trigger manually at any time.

## Search Modes

| Mode | SQLite | Postgres |
|---|---|---|
| `semantic` | `embedding MATCH ? AND k = …` (sqlite-vec KNN) | `embedding <=> $1::vector` (HNSW) |
| `fulltext` | FTS5 `MATCH` + BM25 | `plainto_tsquery` + tsvector |
| `auto` (hybrid) | RRF merge in JS | RRF CTE in SQL |

## See Also

[[db-backends]] [[memory-system]] [[mcp-tools]]
$art8$,
ARRAY['embeddings','vector-search','mxbai','transformers','voyage','recall'],
'system', '', 1

);


-- ===== settings =====
-- 002_settings.sql
-- Key/value store for user preferences that used to live in env vars or
-- browser localStorage (theme, sound, voice, allowed paths, reasoning toggle…).
-- One row per setting; value is JSONB so we can store strings, booleans,
-- numbers, or small objects without a schema change per preference.

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ===== codegraph =====
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


-- ===== docgraph =====
-- Document graph: the document-shaped sibling of codegraph. Indexes folders of
-- human content (Markdown/HTML/PDF/DOCX/XLSX/PPTX/EML) into
-- documents → sections → chunks, with pgvector embeddings + tsvector/GIN FTS.
-- Section text is stored (not re-sliced from the source) so doc_context works
-- uniformly across formats. Mirrors db/migrations-sqlite/001_init.sql docgraph.

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
  document_id INT NOT NULL REFERENCES docgraph_documents(id) ON DELETE CASCADE,
  section_id  BIGINT NOT NULL REFERENCES docgraph_sections(id) ON DELETE CASCADE,
  ord         INT NOT NULL,
  text        TEXT NOT NULL,
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
  document_id INT NOT NULL REFERENCES docgraph_documents(id) ON DELETE CASCADE,
  section_id  BIGINT REFERENCES docgraph_sections(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL
);
CREATE INDEX idx_dr_value      ON docgraph_refs(value);
CREATE INDEX idx_dr_kind_value ON docgraph_refs(kind, value);
