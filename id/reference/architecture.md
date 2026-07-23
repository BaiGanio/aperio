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
│   ├── providers/         # Provider/model resolution and schema helpers
│   ├── streaming/         # SSE + WebSocket streaming to the browser
│   ├── tools/             # Agent-side tool implementations (browser-facing)
│   ├── handlers/          # WebSocket message handlers (chat, tool calls, etc.)
│   ├── routes/            # Express API routes + path validation (paths.js)
│   ├── emitters/          # Event emitters for tool lifecycle, agent events
│   ├── helpers/           # Cross-cutting: logger, embeddings, auth, net guard, TLS, browser launcher
│   ├── workers/           # Background workers (embedding queue, etc.)
│   ├── utils/             # Pure utilities (path resolution, token counting, etc.)
│   ├── codegraph/         # Code symbol graph (tree-sitter index)
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
| `lib/config.js` → `scripts/gen-env-example.js` | The config registry is the single source of truth; `gen-env-example.js` walks it to regenerate both the slim `.env.example` (only `envTemplate` keys) and the full `docs/config-reference.md`. Adding a config key without running the generator breaks CI (`gen:env:check` gates both files). |
| `public/scripts/settings-overlay.js` → `paths-panel.js`, `db-connections-panel.js`, `github-triage-panel.js` | The Settings overlay owns the configuration navigation while the specialized modules retain their existing path, connection CRUD, secret masking, and triage behavior. Their DOM is mounted as overlay category views; do not duplicate those controls in the Settings drawer. |
| `lib/agent/index.js` ↔ `lib/workers/skills.js` | Skill matching and injection is called during context assembly. Skill behavior changes propagate to every conversation. |
| `server.js` → `lib/handlers/` → `lib/agent/index.js` | The Express/WS server routes messages through handlers into the agent orchestrator. The WebSocket message protocol between `public/index.js` and `lib/handlers/` has no formal schema — both sides must agree on message shapes. |

## Key Files Reference

| File | Purpose |
|------|---------|
| `server.js` | Express + WebSocket server, bootstrap flow, locale detection |
| `bootstrap.js` | First-run setup: DB init, config wizard, embeddings download |
| `lib/config.js` | Configuration registry — single source of truth for all settings |
| `lib/config-resolver.js` | Resolves config from .env / DB / defaults with precedence |
| `lib/agent/index.js` | Agent orchestration — creates AI clients, wires tools, manages sessions |
| `mcp/index.js` | MCP server entry — creates context, registers all tools, stdio transport |
| `db/index.js` | Store factory — auto-detects SQLite or Postgres |
| `lib/routes/paths.js` | Path resolution and validation for all file operations |
| `lib/helpers/embeddings.js` | Embedding generation (transformers or Voyage) |
| `lib/helpers/logger.js` | Winston logger with daily rotation |
| `lib/context/` | Context assembly — system prompts, memory injection, skills |
| `lib/agent/providers/` | Provider loops, including Claude Code and Codex CLI |
| `lib/providers/` | Provider/model resolution and shared schema helpers |
| `public/index.html` | Web UI SPA shell |
| `public/index.js` | Web UI main client script |
| `id/whoami.md` | Primary agent persona definition |
