// db/wiki-seed.js
// Baseline wiki articles seeded when the wiki_articles table is first created.
// These are "founder" articles — broad enough to be useful immediately, narrow
// enough to stay fresh as the project evolves. No source_memory_ids on seed
// (zero provenance); the LLM will cite and re-anchor them on first wiki_write update.

export const WIKI_SEED = [
  {
    slug:    'aperio-architecture',
    title:   'Aperio — Architecture Overview',
    summary: 'Component map, data flow, and technology stack for the Aperio personal AI system.',
    tags:    ['aperio', 'architecture', 'overview', 'server'],
    body_md: `
## What Aperio Is

Aperio is a self-hosted, privacy-first personal AI assistant. It runs entirely on the user's
machine — no telemetry, no cloud sync. The binary footprint is a Node.js process; the only
optional external dependency is a running Ollama daemon (or a cloud API key).

## Runtime Components

| Component | File | Role |
|---|---|---|
| HTTP + WebSocket server | \`server.js\` | Entrypoint; mounts Express routes and WS handler |
| REST API | \`lib/routes/api.js\` | \`/api/*\` — memories, wiki, sessions, status |
| WebSocket handler | \`lib/ws/\` | Real-time chat; streams tokens to the browser |
| MCP subprocess | \`mcp/\` | Tool execution (remember, recall, wiki_*) in a child process |
| DB store | \`db/index.js\` | Resolves LanceDB vs Postgres; exposes a unified store interface |
| Skills loader | \`skills/\` | Injects SKILL.md prompt fragments into the system message |
| Agent | \`lib/agent/\` | Provider-agnostic LLM wrapper; handles streaming + tool loop |

## Request Flow (Chat)

1. Browser → WebSocket → WS handler
2. WS handler builds system prompt (base + injected skills)
3. Agent streams tokens back; tool calls are routed to the MCP subprocess
4. MCP tools read/write the DB store; results are fed back into the tool loop
5. Final assistant message is appended to the session log

## Key Ports and Paths

- Default port: **31337** (set via \`PORT\` env)
- DB data: \`.lancedb/\` (LanceDB) or Docker Postgres volume
- Sessions: \`data/sessions/\`
- Skills: \`skills/<name>/SKILL.md\`

## See Also

[[db-backends]] — LanceDB vs Postgres trade-offs
[[ai-providers]] — supported LLM + embedding providers
[[mcp-tools]] — full tool surface
[[skills-system]] — how skill injection works
`.trim(),
  },

  {
    slug:    'memory-system',
    title:   'Memory System — Types, Lifecycle, and Recall',
    summary: 'How Aperio stores, versions, and retrieves memories, including temporal semantics and search modes.',
    tags:    ['memory', 'lancedb', 'recall', 'temporal', 'embeddings'],
    body_md: `
## Memory Types

Every memory has a \`type\` field that scopes what kind of knowledge it holds:

| Type | Use for |
|---|---|
| \`fact\` | Objective, durable truths |
| \`preference\` | User style/workflow preferences |
| \`project\` | Active project context, goals, deadlines |
| \`decision\` | Architectural or strategic choices + rationale |
| \`solution\` | Resolved problems; how something was fixed |
| \`source\` | External references (URLs, docs, people) |
| \`person\` | Information about a person |

## Temporal Versioning

Memories are never deleted in place — they are **tombstoned**.

- Every row has \`valid_from\` (ISO timestamp) and \`valid_until\` (null = current).
- When a memory is updated, the old row gets \`valid_until = now()\` and a new row is inserted.
- \`store.cache\` only holds rows where \`valid_until IS NULL\` (current versions).
- Historical snapshots are preserved for audit and point-in-time recall (\`asOf\` parameter).

## Other Fields

- \`importance\` (1–5): influences ranking in recall; higher = surfaces first in BM25 fallback
- \`confidence\` (0.0–1.0): model's self-assessed certainty; default 1.0
- \`expires_at\`: optional TTL; expired rows are filtered out of all recall paths
- \`source\`: \`manual\` (user-typed), \`mcp\` (tool-written), \`system\` (seed data)

## Recall Modes

\`recall()\` accepts a \`mode\` parameter:

| Mode | Strategy |
|---|---|
| \`auto\` | Hybrid: vector search + BM25, merged via Reciprocal Rank Fusion (RRF) |
| \`semantic\` | Vector cosine similarity only |
| \`fulltext\` | BM25 over title + content only (no embeddings needed) |

Hybrid is the default and almost always the best choice.

## In-Memory Cache

The store maintains \`store.cache\` — a snapshot of all current (non-tombstoned,
non-expired) rows loaded at startup and refreshed on each \`checkoutLatest()\` call.
The MCP subprocess writes to the same LanceDB files; calling \`refreshCache()\` before
sensitive reads ensures cross-process consistency.

## See Also

[[embeddings]] — how vectors are generated and stored
[[db-backends]] — LanceDB vs Postgres implementation differences
[[mcp-tools]] — remember, recall, update_memory, forget tools
`.trim(),
  },

  {
    slug:    'db-backends',
    title:   'Database Backends — LanceDB vs Postgres',
    summary: 'How Aperio selects a storage backend at startup, and what differs between LanceDB and Postgres.',
    tags:    ['lancedb', 'postgres', 'database', 'architecture', 'docker'],
    body_md: `
## Backend Resolution Order

At startup \`db/index.js\` resolves the backend in this order:

1. \`DB_BACKEND\` env var — \`'lancedb'\` or \`'postgres'\` (explicit, always wins)
2. Auto-detect — pings Docker; if reachable → Postgres, else → LanceDB
3. Safety fallback — LanceDB (zero-config, always works)

## LanceDB (default for non-Docker users)

- **Embedded**: runs inside the Node.js process, no daemon needed.
- **Storage**: \`.lancedb/\` directory in the project root (set via \`LANCEDB_PATH\`).
- **Tables**: \`memories\` + \`wiki_articles\` (separate tables, same DB connection).
- **Vector search**: LanceDB native ANN (IVF-PQ under the hood).
- **FTS**: BM25 implemented in-process via \`bm25Rank()\` in \`db/lancedb.js\`.
- **Hybrid search**: RRF merge of vector + BM25 results, computed in JS.
- **Versioning**: all multi-process consistency relies on \`table.checkoutLatest()\`.

## Postgres (Docker users)

- **External**: requires Docker + the \`pgvector\` extension.
- **Vector search**: HNSW index (\`embedding vector_cosine_ops\`, m=16, ef=64).
- **FTS**: native \`tsvector\` + \`plainto_tsquery\` with GIN index.
- **Hybrid search**: single SQL CTE using \`FULL OUTER JOIN\` for RRF.
- **Triggers**: \`trg_memories_mark_wiki_stale\` auto-marks wiki articles stale when
  a cited memory's content or title changes.
- **Transactions**: wiki writes use \`BEGIN/COMMIT\` with rollback on error.

## Behavioural Differences

| Feature | LanceDB | Postgres |
|---|---|---|
| Wiki stale-marking | Manual / on next refresh | Automatic via DB trigger |
| Source memory validation | \`store.cache\` lookup | \`SELECT … WHERE id = ANY($1)\` |
| Embedding storage | Float32 FixedSizeList | \`vector(1024)\` pgvector type |
| Delete semantics | Physical delete + re-insert | Physical delete (wiki); tombstone (memories) |

## Resetting the LanceDB Store

Because Aperio is in active development, wiping and re-creating is cheap:

\`\`\`bash
rm -rf .lancedb && node server.js   # tables re-created with seed data on next start
\`\`\`

## See Also

[[aperio-architecture]] — where the DB fits in the full stack
[[memory-system]] — temporal versioning and cache behaviour
[[embeddings]] — dimension requirements and mismatch errors
`.trim(),
  },

  {
    slug:    'ai-providers',
    title:   'AI Providers — LLM and Embedding Configuration',
    summary: 'Supported LLM and embedding providers, environment variables, and the wiki refresh provider pattern.',
    tags:    ['providers', 'ollama', 'anthropic', 'deepseek', 'gemini', 'embeddings', 'configuration'],
    body_md: `
## Main LLM Provider

Set via \`AI_PROVIDER\` env var. Supported values:

| Value | Notes |
|---|---|
| \`ollama\` | Local; requires Ollama daemon. Set \`OLLAMA_MODEL\` and \`OLLAMA_BASE_URL\`. |
| \`anthropic\` | Cloud; requires \`ANTHROPIC_API_KEY\` and \`ANTHROPIC_MODEL\`. |
| \`deepseek\` | Cloud; requires \`DEEPSEEK_API_KEY\` and \`DEEPSEEK_MODEL\`. |
| \`gemini\` | Cloud; requires \`GEMINI_API_KEY\` and \`GEMINI_MODEL\`. |

The model is used for all chat, tool-loop reasoning, and wiki article generation.

## Embedding Provider

Set via \`EMBEDDING_PROVIDER\`:

| Value | Model | Notes |
|---|---|---|
| \`transformers\` | \`mixedbread-ai/mxbai-embed-large-v1\` (ONNX q8) | Default. Fully local; downloads on first run. 1024 dims. |
| \`voyage\` | Voyage AI | Cloud; requires \`VOYAGE_API_KEY\`. Free tier: 50M tokens/month. |

The embedding provider is used for all memory and wiki article vector storage.
Changing providers after data exists requires wiping \`.lancedb/\` (dimension mismatch).

## Wiki Refresh Provider

\`WIKI_REFRESH_PROVIDER\` configures a **separate, cheaper** model used only to rewrite
stale wiki articles on \`wiki_get(refresh=true)\`. Format: \`provider:model\`.

Examples:
\`\`\`
WIKI_REFRESH_PROVIDER=ollama:llama3.1
WIKI_REFRESH_PROVIDER=deepseek:deepseek-chat
WIKI_REFRESH_PROVIDER=anthropic:claude-haiku-4-5-20251001
\`\`\`

This is opt-in. If unset, refresh calls degrade gracefully (stale body + footer note).
When using Ollama, set \`WIKI_REFRESH_AUTOSTART_OLLAMA=true\` to auto-launch the daemon.

## Roundtable (Multi-Agent)

\`ROUNDTABLE_AGENTS\` enables multi-model discussions. Format: comma-separated
\`provider:model\` pairs. \`ROUNDTABLE_MAX_ROUNDS\` caps the turn count (default 3).

\`\`\`
ROUNDTABLE_AGENTS=anthropic:claude-haiku-4-5-20251001,deepseek:deepseek-chat
\`\`\`

## See Also

[[aperio-architecture]] — where providers are wired in
[[embeddings]] — dimension requirements per provider
[[wiki-workflow]] — when wiki refresh is triggered
`.trim(),
  },

  {
    slug:    'mcp-tools',
    title:   'MCP Tools — Full Tool Surface',
    summary: 'All tools available to the LLM via the MCP subprocess: memory, wiki, files, shell, web, and image.',
    tags:    ['mcp', 'tools', 'memory', 'wiki', 'files', 'shell'],
    body_md: `
## How MCP Works in Aperio

The MCP (Model Context Protocol) server runs as a **child process** spawned at startup.
The main LLM agent calls tools via the MCP protocol; the subprocess executes them against
the shared DB store and returns structured results. All tools receive a \`ctx\` object:
\`{ store, generateEmbedding, agent }\`.

## Memory Tools (\`mcp/tools/memory.js\`)

| Tool | Purpose |
|---|---|
| \`remember\` | Store a new memory. Fields: type, title, content, tags, importance, confidence, source. |
| \`recall\` | Retrieve memories by query. Modes: auto (hybrid), semantic, fulltext. Returns ranked list. |
| \`update_memory\` | Update an existing memory by id (tombstones old, inserts new). |
| \`forget\` | Delete a memory by id. |
| \`backfill_embeddings\` | Generate embeddings for memories that have zero vectors. |
| \`deduplicate_memories\` | Find near-duplicate memories (cosine similarity ≥ threshold). |

## Wiki Tools (\`mcp/tools/wiki.js\`)

| Tool | Purpose |
|---|---|
| \`wiki_write\` | Create or update a wiki article. Upserts by slug; bumps revision. |
| \`wiki_search\` | Hybrid FTS + semantic search over articles. Always call before wiki_write. |
| \`wiki_list\` | Browse articles by tag/status/date. No query — for listing recent activity. |
| \`wiki_get\` | Fetch a full article by slug, with optional stale-refresh. |

## File Tools (\`mcp/tools/files.js\`)

Handles file generation served via \`/public/exports/\`:

- \`write_file\` — write text/code files
- \`write_xlsx\` — generate Excel workbooks (multi-sheet, formatted)
- \`write_pptx\` — generate PowerPoint presentations with theme selection

## Other Tools

| Tool file | Tools |
|---|---|
| \`mcp/tools/shell.js\` | \`run_shell_command\` — execute whitelisted shell commands |
| \`mcp/tools/web.js\` | \`web_search\`, \`fetch_url\` — read external web content |
| \`mcp/tools/image.js\` | \`describe_image\` — describe an image file or URL |

## See Also

[[memory-system]] — memory types and lifecycle
[[wiki-workflow]] — wiki write workflow and citation rules
[[aperio-architecture]] — how MCP subprocess connects to the server
`.trim(),
  },

  {
    slug:    'skills-system',
    title:   'Skills System — Prompt Injection via SKILL.md',
    summary: 'How Aperio loads and injects skill fragments into the LLM system prompt at conversation start.',
    tags:    ['skills', 'system-prompt', 'configuration', 'llm'],
    body_md: `
## What a Skill Is

A skill is a markdown file (\`SKILL.md\`) inside \`skills/<name>/\`. The harness reads
these files at startup and injects their content into the LLM's system prompt.
Skills encode **behavioural rules** — how to use a tool, how to format output, what
protocol to follow — not factual knowledge (that belongs in memories or wiki articles).

## Directory Structure

\`\`\`
skills/
  agent-conduct/SKILL.md        # tone, refusal policy, honesty rules
  coding-examples/SKILL.md      # how to write code examples
  coding-standards/SKILL.md     # code style and quality rules
  conversation-lifecycle/SKILL.md  # session open/close protocol
  mcp-builder/SKILL.md          # how to write new MCP tools
  memory-learning/SKILL.md      # when and how to store memories
  memory-protocol/SKILL.md      # recall-before-answer protocol
  pdf/SKILL.md                  # working with PDF files
  pptx/SKILL.md                 # generating PowerPoint files
  preprocess-image/SKILL.md     # image handling
  preprocess-pdf/SKILL.md       # PDF pre-processing
  prompt-optimizer/SKILL.md     # prompt engineering rules
  reasoning-planning/SKILL.md   # chain-of-thought planning
  theme-factory/SKILL.md        # visual theme generation
  tool-integration/SKILL.md     # generic tool usage rules
  wiki/SKILL.md                 # wiki read/write/surface protocol
  working-with-files/SKILL.md   # file I/O guidance
  xlsx/SKILL.md                 # generating Excel files
\`\`\`

## Skill File Format

\`\`\`markdown
---
name: my-skill
description: >
  One-line description — used to decide whether to load the skill.
---

## Section

Rules and instructions in plain markdown.
\`\`\`

The frontmatter \`name\` and \`description\` are used for indexing.
The body is injected verbatim into the system prompt.

## Adding a New Skill

1. Create \`skills/<kebab-name>/SKILL.md\` with frontmatter + body.
2. Restart the server — skills are loaded at startup, not hot-reloaded.
3. The \`mcp-builder\` skill documents the pattern for pairing a skill with a new MCP tool.

## See Also

[[aperio-architecture]] — where skills are loaded in the startup sequence
[[mcp-tools]] — tools that skills describe how to use
[[wiki-workflow]] — the wiki skill is a good reference implementation
`.trim(),
  },

  {
    slug:    'wiki-workflow',
    title:   'Wiki Workflow — Writing, Citing, and Surfacing Articles',
    summary: 'The full lifecycle of a wiki article: when to write one, the recall→cite→write loop, staleness, and the breadcrumb protocol.',
    tags:    ['wiki', 'workflow', 'citations', 'stale', 'breadcrumb'],
    body_md: `
## When to Write a Wiki Article

Write an article when you notice you've stitched together **≥3 memories on the same topic**
to answer a question, and the topic is likely to come up again. Don't write articles for
single-fact lookups — use \`recall\` directly for those.

Good candidates: architecture overviews, project status summaries, "what do I know about X"
questions, recurring concepts that span multiple memories.

## The Write Loop

1. \`wiki_search(topic)\` — check whether an article already exists. If yes, update it
   (same slug, bumped revision) instead of creating a duplicate.
2. \`recall(topic)\` — gather the 8–12 most relevant memories.
3. Draft \`body_md\`; cite every factual claim inline as \`[[mem:<uuid>]]\`.
   Link sibling articles as \`[[other-slug]]\`.
4. \`wiki_write(slug, title, summary, body_md, tags, source_memory_ids)\` — pass the
   cited memory ids in \`source_memory_ids\` for provenance tracking.

## Slugs Are Immutable

Slugs are permanent once another article links to them via \`[[slug]]\`. Confirm the slug
with the user on first creation. Use lowercase kebab-case, e.g. \`aperio-architecture\`.

## Staleness

An article becomes **stale** when one of its source memories is updated (content or title changes).

- On LanceDB: staleness is checked lazily at read time (no trigger).
- On Postgres: a DB trigger (\`trg_memories_mark_wiki_stale\`) marks it automatically.

To recover a stale article:
- \`wiki_get(slug, refresh=true)\` — server rewrites it via \`WIKI_REFRESH_PROVIDER\` if configured.
- Or manually: \`recall\` → rewrite → \`wiki_write\`.

## The Breadcrumb Protocol

When you use a wiki article to answer the user, **copy the breadcrumb verbatim as the
first line of your reply**, before any other prose:

\`\`\`
🔖 From wiki: [[aperio-architecture]] (rev 3 · fresh · updated 2026-05-17)
\`\`\`

If you consulted multiple articles, list each breadcrumb on its own line.
This is the only way the user knows the wiki was consulted (there is no UI for it yet).

## Article Status Values

| Status | Meaning |
|---|---|
| \`fresh\` | Up-to-date; all source memories are at the version the article was written against |
| \`stale\` | At least one source memory has changed since last write |
| \`draft\` | Work in progress; not ready for recall |
| \`archived\` | Retired; excluded from all searches unless explicitly requested |

## See Also

[[memory-system]] — memory lifecycle, the source_memory_ids contract
[[mcp-tools]] — wiki_write, wiki_get, wiki_search, wiki_list
[[skills-system]] — the wiki SKILL.md encodes these rules for the LLM
`.trim(),
  },

  {
    slug:    'embeddings',
    title:   'Embeddings — Providers, Dimensions, and Search Modes',
    summary: 'How vector embeddings are generated, stored, and used for recall and wiki search in Aperio.',
    tags:    ['embeddings', 'vector-search', 'mxbai', 'transformers', 'voyage', 'recall'],
    body_md: `
## Default Provider: HuggingFace Transformers

The default embedding provider (\`EMBEDDING_PROVIDER=transformers\`) runs
\`mixedbread-ai/mxbai-embed-large-v1\` locally via ONNX Runtime (quantized to int8).

- **Dimensions**: 1024 (controlled by \`EMBEDDING_DIMS\` env var; default 1024)
- **Download**: happens automatically on first run, cached in the project root
- **No API key, no external service** — fully offline

## Alternative: Voyage AI

\`EMBEDDING_PROVIDER=voyage\` uses Voyage AI's cloud embedding API.

- Requires \`VOYAGE_API_KEY\`
- Free tier: 50M tokens/month
- Dimensions depend on the Voyage model chosen

**Important**: switching providers after data exists requires wiping \`.lancedb/\`
(or the Postgres \`embedding\` column) because dimensions must match exactly.

## What Gets Embedded

| Entity | Text used for embedding |
|---|---|
| Memory | \`title + " " + content\` |
| Wiki article | \`title + ". " + summary + " " + body_md\` |

## Dimension Mismatch

If \`EMBEDDING_DIMS\` doesn't match the dimension stored in the LanceDB table,
the server throws at startup:

\`\`\`
LanceDB vector dimension mismatch: table has 1024D but EMBEDDING_DIMS=384.
Either set EMBEDDING_DIMS=1024 or delete the .lancedb directory to start fresh.
\`\`\`

Fix: either align \`EMBEDDING_DIMS\` to the table value, or \`rm -rf .lancedb\`
to start fresh (all data lost).

## Zero Vectors

Seed data and any memory stored before the embedding provider is available has a
zero vector (\`[0, 0, …, 0]\`). These rows are excluded from semantic search paths
but appear in BM25 fulltext results. Run \`backfill_embeddings\` (MCP tool) to
fill them in after the provider is configured.

## Search Modes Summary

| Mode | LanceDB | Postgres |
|---|---|---|
| \`semantic\` | \`table.search(vec)\` (ANN) | \`embedding <=> $1::vector\` (HNSW) |
| \`fulltext\` | \`bm25Rank()\` in JS | \`plainto_tsquery\` + tsvector |
| \`auto\` (hybrid) | RRF merge in JS | RRF CTE in SQL |

## See Also

[[db-backends]] — how embedding storage differs between LanceDB and Postgres
[[memory-system]] — zero-vector detection and cache behaviour
[[mcp-tools]] — \`backfill_embeddings\` tool
`.trim(),
  },
];
