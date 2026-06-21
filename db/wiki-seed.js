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
| WebSocket handler | \`lib/emitters/\` | Real-time chat; streams tokens to the browser (\`wsEmitter.js\`, \`handlers/wsHandler.js\`) |
| MCP subprocess | \`mcp/\` | Tool execution (remember, recall, wiki_*) in a child process |
| DB store | \`db/index.js\` | Resolves SQLite vs Postgres; exposes a unified store interface |
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
- DB data: \`sqlite/aperio.db\` (SQLite) or Docker Postgres volume
- Sessions: \`var/sessions/\`
- Skills: \`skills/<name>/SKILL.md\`

## See Also

[[db-backends]] — SQLite vs Postgres trade-offs
[[ai-providers]] — supported LLM + embedding providers
[[mcp-tools]] — full tool surface
[[skills-system]] — how skill injection works
`.trim(),
  },

  {
    slug:    'memory-system',
    title:   'Memory System — Types, Lifecycle, and Recall',
    summary: 'How Aperio stores, versions, and retrieves memories, including temporal semantics and search modes.',
    tags:    ['memory', 'sqlite', 'recall', 'temporal', 'embeddings'],
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
The MCP subprocess writes to the same SQLite file; calling \`refreshCache()\` before
sensitive reads ensures cross-process consistency.

## See Also

[[embeddings]] — how vectors are generated and stored
[[db-backends]] — SQLite vs Postgres implementation differences
[[mcp-tools]] — remember, recall, update_memory, forget tools
`.trim(),
  },

  {
    slug:    'db-backends',
    title:   'Database Backends — SQLite vs Postgres',
    summary: 'How Aperio selects a storage backend at startup, and what differs between SQLite and Postgres.',
    tags:    ['sqlite', 'postgres', 'database', 'architecture', 'docker'],
    body_md: `
## Backend Resolution Order

At startup \`db/index.js\` resolves the backend in this order:

1. \`DB_BACKEND\` env var — \`'sqlite'\` or \`'postgres'\` (explicit, always wins)
2. Auto-detect — pings Docker; if reachable → Postgres, else → SQLite
3. Safety fallback — SQLite (zero-config, always works)

## SQLite (default for non-Docker users)

- **Embedded**: runs inside the Node.js process via \`better-sqlite3\`, no daemon needed.
- **Storage**: a single file at \`sqlite/aperio.db\` (set via \`SQLITE_PATH\`).
- **Tables**: \`memories\` + \`wiki_articles\`, each paired with a \`vec_*\` (sqlite-vec)
  and a \`*_fts\` (FTS5) virtual table, joined by \`rowid\`.
- **Vector search**: sqlite-vec \`vec0\` virtual table; KNN via \`embedding MATCH ? AND k = …\`.
- **FTS**: FTS5 + BM25, kept in sync by AFTER INSERT/UPDATE/DELETE triggers.
- **Hybrid search**: RRF merge of vector + FTS5 results, computed in JS.

## Postgres (Docker users)

- **External**: requires Docker + the \`pgvector\` extension.
- **Vector search**: HNSW index (\`embedding vector_cosine_ops\`, m=16, ef=64).
- **FTS**: native \`tsvector\` + \`plainto_tsquery\` with GIN index.
- **Hybrid search**: single SQL CTE using \`FULL OUTER JOIN\` for RRF.
- **Triggers**: \`trg_memories_mark_wiki_stale\` auto-marks wiki articles stale when
  a cited memory's content or title changes.
- **Transactions**: wiki writes use \`BEGIN/COMMIT\` with rollback on error.

## Behavioural Differences

| Feature | SQLite | Postgres |
|---|---|---|
| Wiki stale-marking | Trigger present, but no-op under temporal versioning (tombstone + insert) | Automatic via DB trigger |
| Source memory validation | \`store.cache\` lookup | \`SELECT … WHERE id = ANY($1)\` |
| Embedding storage | sqlite-vec \`vec0\` (float32) | \`vector(1024)\` pgvector type |
| Delete semantics | Physical delete + re-insert | Physical delete (wiki); tombstone (memories) |

## Resetting the SQLite Store

Because Aperio is in active development, wiping and re-creating is cheap:

\`\`\`bash
rm -f sqlite/aperio.db && node server.js   # tables re-created with seed data on next start
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
Changing providers after data exists requires wiping the database (dimension mismatch).

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
    tags:    ['mcp', 'tools', 'memory', 'wiki', 'files', 'shell', 'image', 'web'],
    body_md: `
## How MCP Works in Aperio

The MCP (Model Context Protocol) server runs as a **child process** spawned at startup
(\`lib/agent/index.js\` launches \`node mcp/index.js\` over a stdio transport). The main
LLM agent calls tools via the MCP protocol; the subprocess executes them against the
shared DB store and returns structured results. All tools receive a \`ctx\` object:
\`{ store, generateEmbedding, agent }\`.

Aperio currently registers **22 tools** across six tool files
(\`mcp/index.js\` → \`registerMemory/Files/Web/Image/Shell/Wiki\`).

## Memory Tools (\`mcp/tools/memory.js\`)

| Tool | Purpose |
|---|---|
| \`remember\` | Store a new memory. Auto-generates an embedding for semantic search. |
| \`recall\` | Retrieve memories by query. Semantic when a query is given, falls back to full-text. |
| \`update_memory\` | Update an existing memory by id (tombstones old, inserts new — history preserved). |
| \`forget\` | Delete a memory by id. |
| \`backfill_embeddings\` | Generate embeddings for memories that don't have one yet. |
| \`deduplicate_memories\` | Find near-duplicate memories by cosine similarity (dry_run=true reports; false merges). |

## Wiki Tools (\`mcp/tools/wiki.js\`)

| Tool | Purpose |
|---|---|
| \`wiki_write\` | Create or update a wiki article. Upserts by slug; bumps revision. |
| \`wiki_search\` | Hybrid FTS + semantic search over articles. Call before wiki_write. |
| \`wiki_list\` | Browse articles newest-first by tag/status/updated_since. No query. |
| \`wiki_get\` | Fetch a full article by slug; emits a breadcrumb and supports optional stale-refresh. |

## File Tools (\`mcp/tools/files.js\`)

| Tool | Purpose |
|---|---|
| \`read_file\` | Read a code/text file from disk. Max 500 lines per call; paginate via \`offset\`. |
| \`write_file\` | Create or overwrite a file (subject to the write-path guard). |
| \`append_file\` | Append to the end of an existing file without touching the rest. |
| \`edit_file\` | Replace an exact string in a file (\`replace_all\` for multiple occurrences). |
| \`scan_project\` | Traverse a project folder — returns a file tree and reads key files. |
| \`generate_xlsx\` | Generate a multi-sheet .xlsx workbook, served for download. |

> PowerPoint generation is **not** a dedicated tool. The agent writes a script
> (see \`skills/pptx/\`) and runs it via \`run_node_script\`.

## Image Tools (\`mcp/tools/image.js\`)

| Tool | Purpose |
|---|---|
| \`read_image\` | Load an image (file path or base64) so the model can see and analyse it. |
| \`preprocess_image\` | Normalise an image to RGB PNG (letterboxed) before a local VLM call. |
| \`describe_image\` | Send an image to a local Ollama vision model and return a text description. |

## Shell Tools (\`mcp/tools/shell.js\`)

| Tool | Purpose |
|---|---|
| \`run_node_script\` | Run a \`.js\` script located inside an allowed write path; returns its output. |
| \`syntax_check\` | Check a JavaScript file for syntax errors without executing it. |

> There is no general "run any shell command" tool. Execution is limited to Node.js
> scripts under an allowed write path — the path guard still applies.

## Web Tools (\`mcp/tools/web.js\`)

| Tool | Purpose |
|---|---|
| \`fetch_url\` | Fetch a URL, strip HTML, truncate at 15,000 characters. |
| \`web_search\` | Search the web via DuckDuckGo (title/URL/snippet); follow up with \`fetch_url\` to read and cite a result. No setup required. |

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

- On SQLite: under temporal versioning (tombstone + insert) the stale trigger is a
  no-op, so staleness surfaces lazily at read time.
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

**Important**: switching providers after data exists requires wiping the SQLite DB
(or the Postgres \`embedding\` column) because dimensions must match exactly.

## What Gets Embedded

| Entity | Text used for embedding |
|---|---|
| Memory | \`title + " " + content\` |
| Wiki article | \`title + ". " + summary + " " + body_md\` |

## Dimension Mismatch

If \`EMBEDDING_DIMS\` doesn't match the dimension stored in the sqlite-vec table,
the server throws at startup:

\`\`\`
Vector dimension mismatch: table has 1024D but EMBEDDING_DIMS=384.
Either set EMBEDDING_DIMS=1024 or delete sqlite/aperio.db to start fresh.
\`\`\`

Fix: either align \`EMBEDDING_DIMS\` to the table value, or \`rm -f sqlite/aperio.db\`
to start fresh (all data lost).

## Zero Vectors

Seed data and any memory stored before the embedding provider is available has a
zero vector (\`[0, 0, …, 0]\`). These rows are excluded from semantic search paths
but appear in BM25 fulltext results. Run \`backfill_embeddings\` (MCP tool) to
fill them in after the provider is configured.

## Search Modes Summary

| Mode | SQLite | Postgres |
|---|---|---|
| \`semantic\` | \`embedding MATCH ? AND k = …\` (sqlite-vec KNN) | \`embedding <=> $1::vector\` (HNSW) |
| \`fulltext\` | FTS5 \`MATCH\` + BM25 | \`plainto_tsquery\` + tsvector |
| \`auto\` (hybrid) | RRF merge in JS | RRF CTE in SQL |

## See Also

[[db-backends]] — how embedding storage differs between SQLite and Postgres
[[memory-system]] — zero-vector detection and cache behaviour
[[mcp-tools]] — \`backfill_embeddings\` tool
`.trim(),
  },

  // ── Philosophy ────────────────────────────────────────────────────────────
  // First-principles articles. These don't describe how Aperio works — they
  // explain *why* it works that way. They're written so a future LLM can cite
  // them when the user asks design-intent questions.

  {
    slug:    'why-local-first',
    title:   'Why Local-First — What Aperio Gives Up and Gains',
    summary: 'The deliberate trade-offs behind running entirely on the user\'s machine, with no telemetry or cloud sync.',
    tags:    ['philosophy', 'local-first', 'privacy', 'design-intent'],
    body_md: `
## The Premise

A personal AI assistant accumulates the most intimate possible record of its user:
half-formed thoughts, project plans, off-hand opinions about people, decisions made
under uncertainty. The default modern architecture for such a system — cloud-hosted,
multi-tenant, server-side memory — is fundamentally incompatible with that intimacy.

Aperio's local-first stance is a refusal of that default, not an optimisation.

## What We Give Up

- **Frictionless multi-device sync.** No magic "open my notes on my phone." If you
  want that, you run a tunnel or sync the data directory yourself.
- **Server-side model quality.** Local models (via Ollama) are smaller and slower
  than frontier cloud models. Cloud providers remain optional, but always opt-in
  per-request, never the default.
- **Crash-recovery-as-a-service.** Your \`sqlite/aperio.db\` file is yours to back up.
  Lose it, lose the memories.
- **Effortless onboarding.** A binary that needs no setup is impossible when the
  data has nowhere to live except the user's filesystem.

## What We Gain

- **No observer.** No vendor sees your conversations. No "we may use anonymised
  data to improve our service" clause. Aperio cannot leak what it never transmits.
- **Sovereignty over the substrate.** The user owns the database file. They can
  inspect it, copy it, encrypt it, delete it. Nothing is held hostage.
- **Coherent failure modes.** When the network is down, Aperio still works.
  When the vendor pivots, Aperio still works. When the laws change, Aperio
  still works.
- **An honest trust boundary.** The MCP subprocess is the only place where the
  agent can touch the world outside its own process. That seam is auditable
  precisely because it's local.

## The Pragmatic Compromise

Cloud LLMs (Anthropic, DeepSeek, Gemini) are supported because frontier reasoning
is sometimes the right tool. But the **memory layer is non-negotiably local**.
A cloud LLM call sends only the prompt and tool results of that turn — never the
memory store, never the wiki, never the session history beyond what's needed for
that one inference.

That asymmetry is the whole design: cloud for *thinking*, local for *remembering*.

## See Also

[[aperio-architecture]] — the runtime topology that makes this possible
[[memory-vs-knowledge]] — why the memory store is the load-bearing privacy boundary
[[agency-and-tools]] — the MCP subprocess as a trust seam
`.trim(),
  },

  {
    slug:    'memory-vs-knowledge',
    title:   'Memory vs Knowledge — Why Aperio Has Both',
    summary: 'The epistemic distinction between a memory (an event with provenance) and a wiki article (a synthesis), and why tombstones replace edits.',
    tags:    ['philosophy', 'memory', 'epistemology', 'design-intent'],
    body_md: `
## Two Kinds of Knowing

Most knowledge systems collapse two distinct things into one storage layer:

1. **What happened, when, and according to whom** — a witnessed event.
2. **What is true, as best we can tell right now** — a synthesised claim.

Aperio keeps them apart by design.

| Layer | What it holds | Update semantics |
|---|---|---|
| **Memories** | Witnessed events with provenance and time | Tombstoned (never overwritten) |
| **Wiki articles** | Syntheses over memories, with citations | Bumped revision (overwriting is fine) |

A memory says: *on 2026-05-08, the user told me their preferred indentation is tabs.*
A wiki article says: *the user prefers tabs* — and cites the memories that support it.

When the user later switches to spaces, the **old memory does not become false** —
it remains a true record of what was said on that date. A new memory is added.
The wiki article gets rewritten and its revision bumps.

## Why Tombstones, Not Edits

If memories were editable, you would lose the ability to ask: *what did I believe
last March?* Tombstoning (\`valid_until = now()\`) preserves the historical record
while keeping current queries fast (recall filters on \`valid_until IS NULL\`).

This matters for an assistant that reasons over its own past. An editable memory
store can be silently rewritten by the agent itself — a failure mode where the
assistant gaslights its own user. Append-only history makes that structurally
impossible.

## Why the Wiki Can Be Overwritten

Wiki articles are explicitly **derived**. They are caches of reasoning over the
memory layer. Overwriting a cache is fine; what matters is that the cache
remembers which inputs it was derived from (\`source_memory_ids\`) so it can be
invalidated when those inputs change. That's exactly what the stale-marking
mechanism does.

If you wanted the historical revisions of a wiki article, you would store them
as memories about the wiki, not as wiki rows.

## The Litmus Test

When deciding where a piece of information belongs, ask:

- *Could this become false later?* → memory (preserve the historical claim)
- *Is this a current best-guess derived from many memories?* → wiki article

## See Also

[[memory-system]] — the mechanics of tombstoning, recall, and cache
[[temporal-truth]] — why \`valid_from\` / \`valid_until\` is an epistemic claim
[[the-wiki-as-cache]] — staleness as cache invalidation
[[wiki-workflow]] — when to promote scattered memories into an article
`.trim(),
  },

  {
    slug:    'agency-and-tools',
    title:   'Agency and Tools — The MCP Boundary as Design',
    summary: 'Why tool use lives in a separate subprocess: trust seams, auditability, and the difference between thinking and acting.',
    tags:    ['philosophy', 'mcp', 'agency', 'design-intent'],
    body_md: `
## Thinking Is Cheap. Acting Has Consequences.

When an LLM generates the string \`rm -rf /tmp/data\`, nothing happens. When the
process holding the LLM's output executes that string, something happens. The
gap between those two moments is the only place where safety, auditability, and
user consent can actually live.

Aperio puts the MCP subprocess in that gap on purpose.

## Tools Are the Agent's Hands

The main agent process holds the model and the conversation. It can reason, plan,
draft replies. What it **cannot** do directly is touch the database, the
filesystem, the network, or the user's shell. To do any of that, it sends a tool
call across the MCP boundary, and the subprocess decides whether and how to
execute it.

This separation gives us:

- **A single auditable seam.** Every side-effect the assistant produces flows
  through one place. You can log it, gate it, rate-limit it, or refuse it.
- **Crash isolation.** A misbehaving tool (a hung shell command, a bad PDF parse)
  can be killed without taking down the conversation.
- **Replaceability.** The agent doesn't know how \`recall\` works — only that it
  returns ranked memories. The implementation can change without touching the
  reasoning layer.

## Why Not Function Calls in the Same Process?

Same-process function calls would be faster and simpler. They would also collapse
the trust boundary. The moment the LLM's tool-calling layer and the database
client live in the same memory space, there is no architectural reason an
inadvertent generation can't reach into the store directly. The subprocess
boundary is a physical fact that no prompt injection can talk past.

## The Skill / Tool Pairing

A **tool** is a capability (\`write_file\`, \`recall\`). A **skill** is a
prompt-injected description of when and how to use that capability. Tools live
in the subprocess; skills live in the main agent's system prompt. Together they
form a contract: *here is what you can do, here is when you should do it.*

The asymmetry is deliberate — you can change the skill without changing the
tool, and vice versa. That's how behaviour evolves faster than the surface area.

## See Also

[[mcp-tools]] — the current tool surface
[[skills-system]] — the prompt-injection mechanism
[[skills-as-prompts]] — why behaviour lives in markdown, not fine-tunes
[[why-local-first]] — the trust seam only matters because the substrate is local
`.trim(),
  },

  {
    slug:    'temporal-truth',
    title:   'Temporal Truth — Memories as Time-Indexed Claims',
    summary: 'Why every memory carries valid_from and valid_until: making the assistant\'s knowledge an explicit function of time.',
    tags:    ['philosophy', 'temporal', 'epistemology', 'design-intent'],
    body_md: `
## The Question No Assistant Should Avoid

*"What did I think was true last quarter?"*

A naive memory store cannot answer this. Updates overwrite. Deletes erase. The
present is the only time that exists. This is fine for a chatbot; it is fatal
for an assistant that's supposed to reason with you over years.

Aperio answers the question structurally: every memory is a claim **bracketed
by time**, not a fact about the world.

## The Bracket

\`\`\`
valid_from   ISO timestamp   when this claim entered the store
valid_until  ISO timestamp   when it stopped being current (null = still current)
\`\`\`

Reading the store at time \`T\` means filtering rows where
\`valid_from ≤ T < (valid_until OR ∞)\`. The default recall does this with \`T = now\`,
which is why "current memory" feels like a flat list. But the lattice is always
there underneath, and \`asOf\` parameters can walk it backward.

## Why This Is an Epistemic Choice, Not a Storage Trick

The bracket is not just about audit trails. It encodes a stance: **the
assistant's knowledge is not a snapshot of the world, it is a record of what
the assistant has been told and when.**

Saying *"the user prefers tabs"* is an oversimplification.
Saying *"on 2026-05-08, the user said they prefer tabs; on 2026-09-12, they
said spaces"* is honest.

The first form lets the assistant be confidently wrong. The second form forces
it to surface conflict and ask.

## Practical Consequences

- **Conflicting memories don't merge.** They coexist with different brackets.
  Recall returns both, and the agent must reconcile in-context.
- **Forgetting is rare.** Tombstoning is the default; physical \`forget\` is for
  the user's explicit "remove this from the record" requests, not for routine
  updates.
- **The wiki layer absorbs the synthesis.** Articles flatten the temporal lattice
  into a current best-guess — that's exactly why they need citations and
  staleness, not why they replace the underlying record.

## See Also

[[memory-system]] — the implementation of \`valid_from\` / \`valid_until\`
[[memory-vs-knowledge]] — why the wiki and memory layers diverge here
[[the-wiki-as-cache]] — how staleness flows from the temporal model
`.trim(),
  },

  {
    slug:    'skills-as-prompts',
    title:   'Skills as Prompts — Behaviour in Markdown, Not Weights',
    summary: 'Why Aperio encodes behavioural rules as injected markdown rather than fine-tunes, RAG, or hard-coded logic.',
    tags:    ['philosophy', 'skills', 'prompts', 'design-intent'],
    body_md: `
## The Question Behind Every Skill

How should a personal AI's behaviour be specified, and by whom?

Three honest answers compete:

1. **Fine-tune the model.** Bake the behaviour into weights.
2. **Hard-code in the application.** Bake it into the host program's logic.
3. **Inject it as text into the prompt.** Bake it into the conversation.

Aperio picks (3), almost everywhere it can. The reason isn't laziness — it's
that (3) keeps the behaviour in a layer the user can actually read, edit, and
diff.

## What a Skill Looks Like

A skill is a \`SKILL.md\` file with frontmatter and a markdown body. At startup,
the harness reads all skills and injects their bodies into the system prompt.
That's the whole mechanism.

There is no special skill engine, no plugin loader, no DSL. The "skill" is the
text. Restart the server, the text changes, the behaviour changes.

## Why Not Fine-Tuning?

Fine-tunes are opaque. A weight delta cannot explain itself, cannot be diffed,
cannot be turned off for a single conversation, and cannot be ported to a
different base model. The behavioural drift they introduce is irreversible
without retraining. For a personal assistant whose owner should remain in
control, that's the wrong tool.

## Why Not Hard-Coding?

Hard-coded behaviour ships at the same cadence as the application. Changing
"how the assistant talks about uncertainty" should not require a release.
It should require editing a file the user already has on their disk.

## What This Costs

- **Prompt budget.** Every loaded skill consumes context. The harness loads them
  selectively, but it's still a tax.
- **Drift.** The model can ignore a skill more easily than it can ignore a
  fine-tune. Skills lean on the model's compliance, not its inability to do
  otherwise.
- **No enforcement.** A skill that says "always cite memories" is a strong
  suggestion, not a guarantee. Real enforcement lives at the tool boundary.

The trade is accepted because the alternative — opaque, slow-to-change
behaviour — is worse for this product.

## The Pattern Generalises

The same logic explains why the wiki uses citations as text markers
(\`[[mem:uuid]]\`) rather than join tables: the textual form is what the model
actually reads. Storage that the model can't see during inference is invisible
from the model's point of view.

## See Also

[[skills-system]] — the loader and file layout
[[agency-and-tools]] — why skills sit alongside tools, not inside them
[[mcp-tools]] — what skills tell the model about how to use tools
`.trim(),
  },

  {
    slug:    'the-wiki-as-cache',
    title:   'The Wiki as Cache — Staleness as the Invalidation Primitive',
    summary: 'The wiki layer reframed as a cache of reasoning over memories, with source citations and staleness as the cache contract.',
    tags:    ['philosophy', 'wiki', 'caching', 'design-intent'],
    body_md: `
## Reframing the Wiki

Most "knowledge base" systems are written for humans to read first and machines
to query second. Aperio's wiki inverts the priority: it's written by the LLM,
for the LLM, with the user as a privileged read-only observer.

The right mental model is not *encyclopaedia*. It's *memoised reasoning*.

## The Cache Analogy in Full

| Caching concept | Wiki equivalent |
|---|---|
| Cache key | Article \`slug\` |
| Cache value | Synthesised \`body_md\` |
| Cache inputs | \`source_memory_ids\` |
| Cache hit | \`wiki_get(slug)\` returns \`fresh\` |
| Cache miss | Slug doesn't exist → \`wiki_write\` after \`recall\` |
| Invalidation | Source memory updated → article marked \`stale\` |
| Refresh | \`wiki_get(slug, refresh=true)\` regenerates the body |
| TTL | (Not used — staleness is content-derived, not time-derived) |

## Why This Framing Helps

It explains, in one move, several rules that otherwise look arbitrary:

- *Why must articles cite memories?* — A cache value with no recorded inputs
  can never be invalidated.
- *Why does updating a memory mark articles stale?* — A cache whose input changed
  must be re-derived or marked suspect.
- *Why does the LLM need a "search before write" step?* — A cache that doesn't
  check for existing entries duplicates work and fragments the namespace.
- *Why is the breadcrumb protocol important?* — It surfaces cache hits to the
  user, so they can see when the assistant is reasoning from memo vs. fresh.
- *Why a cheaper model for refresh?* — Refresh is summarisation, not novel
  reasoning. The expensive model's job was already done when the cache was
  populated.

## What This Framing Does Not Mean

It does **not** mean wiki articles are disposable. They're durable, citable,
linkable artifacts; the user reads them. The "cache" framing is about
**provenance and invalidation semantics**, not about value.

A good analogy: a literature review is a "cache" of the underlying papers in
the same sense — derived, can become outdated, but still the thing most readers
actually consume.

## The Failure Mode This Prevents

Without the cache framing, the wiki becomes a parallel knowledge store that
slowly diverges from memory. Two sources of truth, neither authoritative,
both decaying at different rates. The cache framing forces the wiki to remain
explicitly derived — and therefore explicitly correctable by going back to
the source.

## See Also

[[wiki-workflow]] — the recall → cite → write loop in practice
[[memory-vs-knowledge]] — why the two layers are kept separate
[[ai-providers]] — \`WIKI_REFRESH_PROVIDER\` and why refresh can use a cheaper model
[[temporal-truth]] — staleness inherits from the temporal model of memories
`.trim(),
  },
];
