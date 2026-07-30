# Architecture

## Directory Structure

```
aperio/
├── server.js              # Thin production entrypoint — loads .env, installs error
│                           # handlers, delegates to lib/server.js createApp()
├── lib/server.js          # Callable composition root — createApp() builds Express +
│                           # HTTP + WebSocket + lifecycle. Accepts { skipBoot,
│                           # injectAgent, autoListen } for test isolation.
├── lib/server/            # browser.js, ws.js, shutdown.js (existing) plus
│                           # hydrateRuntime.js, graphWatchers.js, roundtable.js,
│                           # backgroundWorkers.js, locale.js, setupRoutes.js —
│                           # bootApp()'s domain boundaries, split out per #307 Phase 4
├── bootstrap.js           # First-run setup wizard (DB init, config, embeddings)
├── lib/
│   ├── agent/             # Agent orchestration: providers, tool profiles, hooks
│   ├── config.js          # Configuration registry (every knob in one place)
│   ├── config-resolver.js # Resolve config from DB / .env / defaults (precedence, default db-first)
│   ├── config-sync.js     # Sync hand-edited .env vars into the DB settings
│   ├── load-env.js        # Early env loading (before the full config stack)
│   ├── terminal.js        # Terminal chat client entry point
│   ├── terminal/          # Terminal UI (REPL, streaming, formatting)
│   ├── context/           # Context assembly (system prompt, memories, wiki, skills)
│   ├── agent/providers/   # Provider loops (Anthropic, llama.cpp, DeepSeek, Gemini, Claude Code, Codex)
│   │   └── codex-turn-meter.js # Codex per-turn work accounting and guardrails
│   ├── providers/         # Provider/model resolution and schema helpers;
│   │                      # model-facts.js holds the DB-hydrated sizing snapshot
│   ├── streaming/         # SSE + WebSocket streaming to the browser
│   ├── tools/             # Agent-side tool implementations (browser-facing)
│   ├── handlers/          # WebSocket message handlers (chat, tool calls, etc.)
│   ├── routes/            # Express API routes + path validation (paths.js)
│   ├── emitters/          # Event emitters for tool lifecycle, agent events
│   ├── helpers/           # Cross-cutting: logger, embeddings, auth, net guard, TLS, browser launcher
│   ├── workers/           # Background workers (embedding queue, etc.)
│   ├── utils/             # Pure utilities (path resolution, token counting, etc.)
│   ├── codegraph/         # Code symbol graph: tree-sitter index (extract-*, indexer, backends/),
│   │                      #   confidence-aware edges + synthetic file nodes (resolve.js), shared
│   │                      #   traversal (graph.js), native Louvain/SCC analysis (analysis.js),
│   │                      #   lazy revision-invalidated persistence (analysisService.js)
│   ├── docgraph/          # Document graph (full-text + vector index)
│   └── db-connect/        # External DB connection management
├── mcp/
│   ├── index.js           # MCP server entry point (stdio transport)
│   └── tools/             # MCP tool registrations (memory, files, web, shell, wiki, codegraph, docgraph, github, data, database, image)
├── db/
│   ├── index.js           # Store factory (auto-detects SQLite vs Postgres)
│   ├── sqlite.js          # SQLite adapter (better-sqlite3 + sqlite-vec + FTS5)
│   ├── postgres.js        # Postgres adapter (pg + pgvector)
│   ├── migrate.js         # Postgres migration runner
│   ├── migrate-sqlite.js  # SQLite migration runner
│   ├── migrations/        # Postgres SQL migrations (001_init.sql, ...)
│   ├── migrations-sqlite/ # SQLite SQL migrations (mirrors migrations/)
│   │                      # 011_model_facts seeds the curated model catalog
│   ├── tables.js          # Table definitions
│   ├── types.js           # Shared DB types
│   ├── encrypt.js         # AES-256-GCM database encryption (keychain-backed)
│   ├── memory-seed.js     # Seed data for memory system
│   └── wiki-seed.js       # Seed data for wiki system
├── skills/                # Agent skill definitions (~30+ skills)
├── public/                # Web UI (SPA: index.html, setup.html, CSS, JS, i18n)
├── tests/                 # Node.js native test runner tests
├── docker/                # Docker Compose files (dev + prod)
├── docs/                  # GitHub Pages site + docs assets
├── id/                    # Agent persona files (whoami.md, characters/, reference/)
├── var/                   # Runtime data (sessions, session/run scratch, legacy uploads, logs, DB files, plans)
├── scripts/               # Build/utility scripts
└── .github/               # CI/CD workflows, lite installer, contributor data
```

## Data Flow / Request Lifecycle

Every request — whether from the Web UI, terminal client, or an external MCP host — follows the same path:

```
Browser / Terminal / MCP host
  │
  ├─ Web UI ───────────► server.js (Express + WebSocket on :31337)
  │                        │
  ├─ Terminal client ───► lib/terminal.js
  │                        │
  └─ MCP host ─────────► mcp/index.js (stdio transport, standalone)
                           │
                    ┌──────┴──────┐
                    ▼              ▼
              lib/handlers/   lib/agent/index.js
              (WS message      (orchestrator: picks provider,
               routing)         assembles context, wires tools)
                    │              │
                    ▼              ▼
              lib/streaming/  lib/context/        lib/agent/providers/
              (SSE + WS)      (system prompt,      (Anthropic loop,
                               memories, wiki,      llama.cpp loop,
                               skills injection)    DeepSeek loop, …)
                                                     │
                                                     ▼
                                               mcp/tools/
                                               (memory, files, web,
                                                shell, wiki, codegraph,
                                                docgraph, github, …)
                                                     │
                                                     ▼
                                               db/ (SQLite or Postgres)
```

### Generated artifact ownership

Generated files are owned by the conversation or standalone run that created
them; model-supplied filenames are display names, not internal destinations.
The web and terminal agents override the MCP-advertised XLSX/DOCX generators
with trusted in-process handlers so the active AsyncLocalStorage scratch context
is preserved without exposing a writable workspace argument to the model.

```text
Web/terminal session ──► host generator ──► var/scratch/<session-id>/
                                      └──► /scratch/<session-id>/<artifact>

Inbound image/scanned PDF ───────────────► var/scratch/<session-id>/attachments/

Standalone MCP run ─────► MCP generator ─► var/scratch/mcp-<run-id>/
                                      └──► retention sweep

Legacy download card ────────────────────► /uploads (read-only compatibility)
```

Deleting or pruning a session recursively removes its generated files and
attachments. Standalone `mcp-*` workspaces use `SESSION_RETENTION_DAYS`. Both
static routes remain cookie/auth protected, and preview/reveal resolution uses
realpath containment checks before opening an artifact.

**Key insight**: the agent orchestrator (`lib/agent/index.js`) and the MCP server (`mcp/index.js`)
share the same tool implementations and `db/` store. When the agent calls a tool internally,
it hits the same code path as an external MCP client — there's only one implementation of each tool.

**Standalone MCP mode** (`npm run mcp`): starts `mcp/index.js` directly via stdio transport.
No Express server, no WebSocket, no browser. This is how external agents (Claude Desktop,
Codex CLI, CodeWhale, etc.) connect.

### Model facts hydration

Curated llama.cpp sizing facts live in the `model_facts` table, seeded by paired
`011_model_facts.sql` migrations in SQLite and Postgres. `db/index.js` hydrates those rows
into an immutable process-local snapshot after migrations complete. This preserves the
synchronous sizing API used by preset construction, setup specs, progress reporting, and
RAM budgeting without keeping a second hand-maintained source-code catalog.

Resolution is: `APERIO_MODEL_FACTS_OVERRIDES` from effective DB/.env config, then cached
GGUF inspection, then the hydrated `model_facts` catalog, then conservative generic facts.
The setup specs route opens the selected store before reading facts; the pre-database Ollama
migration gate reads replacement model IDs from the config registry and does not depend on
the catalog.

### Sub-agent delegation

`lib/agent/spawn.js` (`spawnChild()`/`spawnParallel()`, agent-harness-epic WS2) lets an
agent delegate a task to child agents instead of hard-coding a second multi-agent mode.
A child is just another `createAgent()` call, built from an `AgentSpec` (`lib/agent/spec.js`)
that is strictly narrower than its parent's:

```text
parent AgentSpec ──narrowAgentSpec()──► child AgentSpec ──createAgent()──► child agent
      │                (lib/agent/bundle.js)                                    │
      │  recursionDepth − 1, toolAllowlist ⊆ parent's                           │
      └──────────────────────── agent_id-tagged emitter ◄───────────────────────┘
                                  (forwarded into the parent's own event stream)
```

`narrowAgentSpec()` is the same permission-narrowing machinery `loadAgentBundle()` uses for
on-disk agent bundles (an `AgentBundleError` if a child ever tries to widen `toolAllowlist`,
filesystem, or memory-scope access beyond its parent), extracted into a reusable export for
exactly this purpose. `recursionDepth` is a decrementing budget, not a depth counter: a spec
with `0` left refuses to spawn further — a graceful, parent-visible refusal rather than a
thrown error — while `concurrency` caps how many children `spawnParallel()` runs at once.
A child that fails, including tripping its own tool-failure budget, resolves as `{ ok: false }`
instead of rejecting, so a parent turn driving several children completes with whatever
results land. `lib/workers/roundtable.js` (a hard-coded, pre-created two-agent mode) predates
this and is not yet refactored onto it — see `A2D.md`.

## Module Coupling Map

Not every directory boundary is a clean module boundary. These implicit couplings are
load-bearing — changing one side without the other breaks things in non-obvious ways.

| Coupling | Why it matters |
|----------|----------------|
| `lib/agent/index.js` ↔ `lib/context/` | The orchestrator assembles context (system prompt, memories, skills). Context assembly defines the prompt shape used by all providers — a change here changes agent behavior everywhere. |
| `lib/agent/index.js` ↔ `lib/agent/providers/*` | One orchestrator drives six provider loops. Each loop expects the same tool schema format and message structure from the orchestrator. |
| `mcp/tools/*` all depend on `mcp/index.js` ctx | Every tool registration file receives the same `ctx` object. Adding/removing/renaming a field in `createContext()` silently breaks any tool that uses it. |
| `lib/routes/paths.js` → all file operations | Every `read_file`, `write_file`, `edit_file`, and shell tool gates through `paths.js`. A path traversal bug here is a security bug everywhere. |
| `db/migrations/` ↔ `db/migrations-sqlite/` | Must stay in lockstep. A migration in one but not the other causes silent schema drift between backends. |
| `db/index.js` → `lib/providers/model-facts.js` | Store initialization runs migrations and hydrates the process-local model-facts snapshot before synchronous llama.cpp sizing consumers execute. |
| `lib/config.js` → `scripts/gen-env-example.js` | The config registry is the single source of truth; `gen-env-example.js` walks it to regenerate both the slim `.env.example` (only `envTemplate` keys) and the full `docs/config-reference.md`. Adding a config key without running the generator breaks CI (`gen:env:check` gates both files). |
| `public/scripts/settings-overlay.js` → `paths-panel.js`, `db-connections-panel.js`, `github-triage-panel.js` | The Settings overlay owns the configuration navigation while the specialized modules retain their existing path, connection CRUD, secret masking, and triage behavior. Their DOM is mounted as overlay category views; do not duplicate those controls in the Settings drawer. |
| `lib/agent/index.js` ↔ `lib/workers/skills.js` | Skill matching and injection is called during context assembly. Skill behavior changes propagate to every conversation. |
| `server.js` → `lib/handlers/` → `lib/agent/index.js` | The Express/WS server routes messages through handlers into the agent orchestrator. The WebSocket message protocol between `public/index.js` and `lib/handlers/` has no formal schema — both sides must agree on message shapes. |

## Vector store lifecycle

Every vector-bearing store — `memories`, `wiki`, `self_memories`, `codegraph`,
`docgraph` — carries its own row in `vec_meta` recording the embedding
signature (`provider:model:dims`) its vectors belong to, plus a status:

```
current  ──signature no longer matches configuration──▶  stale
stale    ──reindex driver claims the store and clears it──▶  reindexing
reindexing ──every row re-embedded──▶  current
```

Only a `current` store is vector-searchable. `stale` and `reindexing` both
degrade to full-text search, because a partially reindexed store holds a mix of
old- and new-space vectors and scoring a query against those produces confident
nonsense rather than a visible error. `lib/helpers/vecMeta.js` owns the rules;
both DB backends only do row CRUD, so they cannot drift.

Detection runs from every entry point that opens a store —
`lib/server/hydrateRuntime.js`, `mcp/index.js`, and the reindex CLI. Detection
never deletes: a signature change marks stores stale and leaves their vectors
in place. The single exception is a dimension change, where vec0 tables and
pgvector columns are physically fixed-width and storage must be recreated
before anything can be written at the new width.

Rebuilding is handled by `lib/embeddings/reindex.js`. It clears a store's
vectors exactly once, on the `stale → reindexing` edge, after which "rows still
needing work" is just the without-embeddings scan each store already has — so an
interrupted run resumes from where it stopped and costs exactly one embedding
call per row no matter how often it is killed. Each store is claimed under a
lease (`reindex_owner`/`reindex_expires_at`) so the server's background rebuild
and an operator's `npm run embeddings:reindex` cannot process the same store at
once; a crashed runner's lease expires and the store is reclaimed.

The HTTP server rebuilds in the background on boot. MCP processes deliberately
do not — they are spawned per agent session, so several can be alive at once and
each running its own reindex would multiply embedding calls; they report the
stale stores and leave the work to the server or the CLI.

## Key Files Reference

| File | Purpose |
|------|---------|
| `server.js` | Express + WebSocket server, bootstrap flow, locale detection |
| `bootstrap.js` | First-run setup: DB init, config wizard, embeddings download |
| `lib/config.js` | Configuration registry — single source of truth for all settings |
| `lib/config-resolver.js` | Resolves config from .env / DB / defaults with precedence |
| `lib/agent/index.js` | Agent orchestration — creates AI clients, wires tools, manages sessions |
| `lib/agent/spec.js` | AgentSpec validation/normalization — the runtime contract for chat, background, and delegated agents |
| `lib/agent/spawn.js` | Sub-agent spawn/delegation — `spawnChild()`/`spawnParallel()` |
| `mcp/index.js` | MCP server entry — creates context, registers all tools, stdio transport |
| `db/index.js` | Store factory — auto-detects SQLite or Postgres |
| `lib/providers/model-facts.js` | DB-hydrated llama.cpp sizing catalog and override/GGUF/fallback resolution |
| `lib/routes/paths.js` | Path resolution and validation for all file operations |
| `lib/helpers/embeddings.js` | Embedding generation (transformers or Voyage) |
| `lib/helpers/vecMeta.js` | Per-store embedding signature state machine (current/stale/reindexing) |
| `lib/embeddings/reindex.js` | Resumable, leased reindex driver |
| `lib/helpers/logger.js` | Winston logger with daily rotation |
| `lib/context/` | Context assembly — system prompts, memory injection, skills |
| `lib/agent/providers/` | Provider loops, including Claude Code and Codex CLI |
| `lib/providers/` | Provider/model resolution and shared schema helpers |
| `public/index.html` | Web UI SPA shell |
| `public/index.js` | Web UI main client script |
| `id/whoami.md` | Primary agent persona definition |
