# CLAUDE.md

## Project: Aperio

**One brain. Every agent. Nothing forgotten.**  
A self-hosted personal memory layer for AI agents. SQLite (or Postgres) + MCP + Ollama.

- **Role**: MCP server first, bundled Web UI and terminal client second
- **Version**: 0.67.0 (see `package.json`)
- **License**: MIT
- **Repo**: [BaiGanio/aperio](https://github.com/BaiGanio/aperio)

---

## Quick Start (Development)

```bash
git clone --depth 1 -b dev https://github.com/BaiGanio/aperio.git
cd aperio
npm install
cp .env.example .env          # edit AI_PROVIDER + model as needed
npm run migrate               # Postgres; for SQLite: npm run migrate:sqlite
npm run start:local           # localhost:31337, browser opens automatically
npm run chat:local            # terminal chat client
```

---

## Tech Stack

- **Runtime**: Node.js (ESM — `"type": "module"`)
- **Web server**: Express 5 + WebSocket (`ws`)
- **Database**: SQLite (`better-sqlite3` + `sqlite-vec` + FTS5) or Postgres (`pg` + `pgvector`)
- **MCP**: `@modelcontextprotocol/sdk` — stdio transport
- **Embeddings**: HuggingFace `@huggingface/transformers` (local, default) or Voyage AI (cloud)
- **AI providers**: Ollama (local), Anthropic, DeepSeek, Google Gemini, Claude Code (Agent SDK), OpenAI Codex CLI
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk` (for `claude-code` provider)
- **Codex integration**: authenticated `codex exec --json` with Aperio's stdio MCP server
- **Skills/doc generation**: `docx`, `pdf-lib`, `pptxgenjs`, `exceljs`, `sharp`, `mammoth`, `pdfjs-dist`
- **Code graph**: `web-tree-sitter` + `tree-sitter-wasms` — currently at `^0.24.7` (ABI 14). Cannot upgrade to 0.25+ until `tree-sitter-wasms` ships ABI-15 grammars. See `lib/codegraph/` extractors.
- **Testing**: Node.js native test runner (`node --test`), `c8` for coverage
- **Logging**: `winston` + `winston-daily-rotate-file`

---

## Architecture

```
aperio/
├── server.js              # Express + WebSocket entry point (port 31337 by default)
├── bootstrap.js           # First-run setup wizard (DB init, config, embeddings)
├── lib/
│   ├── agent/             # Agent orchestration: providers, tool profiles, hooks
│   ├── config.js          # Configuration registry (every knob in one place)
│   ├── config-resolver.js # Resolve config from .env / DB / defaults (precedence)
│   ├── config-sync.js     # Sync hand-edited .env vars into the DB panel
│   ├── load-env.js        # Early env loading (before the full config stack)
│   ├── terminal.js        # Terminal chat client entry point
│   ├── terminal/          # Terminal UI (REPL, streaming, formatting)
│   ├── context/           # Context assembly (system prompt, memories, wiki, skills)
│   ├── agent/providers/   # Provider loops (Anthropic, Ollama, DeepSeek, Gemini, Claude Code, Codex)
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
├── id/                    # Agent persona files (whoami.md, characters/)
├── var/                   # Runtime data (sessions, uploads, logs, DB files)
├── scripts/               # Build/utility scripts
└── .github/               # CI/CD workflows, lite installer, contributor data
```

---

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
                               memories, wiki,      Ollama loop,
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

**Key insight**: the agent orchestrator (`lib/agent/index.js`) and the MCP server (`mcp/index.js`) share the same tool implementations and `db/` store. When the agent calls a tool internally, it hits the same code path as an external MCP client — there's only one implementation of each tool.

**Standalone MCP mode** (`npm run mcp`): starts `mcp/index.js` directly via stdio transport. No Express server, no WebSocket, no browser. This is how external agents (Claude Desktop, Codex CLI, etc.) connect.

---

## Troubleshooting

### Agent / server won't start

| Symptom | Check |
|---------|-------|
| "Store failed to initialize" | Is the DB file writable? If Postgres: is Docker running? Is the connection string correct in `.env`? |
| Provider error / auth failure | `AI_PROVIDER` set correctly? API key env var present? Model name matches the provider's catalog? |
| Port in use | `PORT` env var (default 31337). Check `lsof -i :31337` |
| Crash loop (PROC-01) | Check `var/logs/` — 5+ fatal errors in 60s triggers crash breaker. Fix the root cause before restarting |

### Tool behavior

| Symptom | Check |
|---------|-------|
| Shell tool returns "not allowed" | `APERIO_ENABLE_SHELL` defaults to `off`. Set it to `on` |
| File reads/writes fail with path errors | `APERIO_ALLOWED_PATHS_TO_READ` / `APERIO_ALLOWED_PATHS_TO_WRITE` gate access. Default: project root only |
| `recall()` / vector search returns nothing | Embeddings may not be generated yet. Run bootstrap or check `EMBEDDING_PROVIDER` |
| Code graph returns empty | `APERIO_CODEGRAPH` must be `on` and the repo must be indexed |

### Database

| Symptom | Check |
|---------|-------|
| SQLITE_BUSY / concurrent write errors | SQLite is single-writer. Switch to Postgres for multi-agent setups |
| Migrations fail | Are `db/migrations/` and `db/migrations-sqlite/` in sync? A migration in one but not the other causes drift |
| DB encryption key lost | Keys are stored in the OS keychain (`db/encrypt.js`). Regenerating means data loss |

### Embeddings

| Symptom | Check |
|---------|-------|
| `generateEmbedding` returns null | Embedding provider not initialized. Check `EMBEDDING_PROVIDER` (default: `transformers`). First run downloads the model — this can take a while |
| High memory usage | Local transformers load the model into RAM. Switch to `voyage` (cloud) for low-memory environments |

---

## Fragile / No-Touch Zones

These modules are load-bearing — changes here have wide blast radius and may not be obvious from the diff.

### `lib/config.js` — Configuration Registry
- **Why fragile**: This is the single source of truth for every config variable. Adding/modifying a key here requires running `npm run gen:env` (regenerates `.env.example`) AND `npm run gen:env:check` (CI gate). Missing either step breaks CI.
- **What to verify after changes**: Run `npm run gen:env:check` before pushing.

### `db/migrations/` + `db/migrations-sqlite/` — Database Migrations
- **Why fragile**: These two directories must stay in lockstep. A migration added to one backend and not the other causes silent schema drift that may only surface at runtime.
- **Rule**: Every migration must have a mirror in the other directory. If you add `002_foo.sql` to `migrations/`, add an equivalent `002_foo.sql` to `migrations-sqlite/`.

### `lib/context/` — System Prompt & Context Assembly
- **Why fragile**: Changes here affect the system prompt for ALL providers. A small wording change can alter agent behavior across every model. Token budget issues here cascade to every conversation.
- **What to verify after changes**: Run conversations through multiple providers (at minimum: Ollama + one cloud provider) and check token usage.

### `lib/routes/paths.js` — Path Validation
- **Why fragile**: Every file operation in the system gates through this module. A bug here is a security bug — path traversal, read outside allowed directories, write in unexpected locations.
- **What to verify after changes**: Run path-related tests AND manually test path normalization with `..` segments, symlinks, and absolute paths.

### `mcp/index.js` — MCP Tool Context (`ctx`)
- **Why fragile**: The `ctx` object shape is shared by every tool registration. Adding a field to `ctx` (in `createContext()`) touches all tool files in `mcp/tools/`. Removing or renaming a field silently breaks tools that depend on it.
- **What to verify after changes**: Run `npm run test:memory` + the relevant tool tests for any ctx field you touch.

---

## Known Tech Debt

These are intentional deferrals. Do not "fix" them without discussion.

| Item | Status | Blocked on |
|------|--------|------------|
| CSP headers disabled | `Helmet` CSP is off pending inline-script refactor in the Web UI (`public/index.html`) | SPA script refactor |
| `tree-sitter` pinned at `^0.24.7` | Cannot upgrade to 0.25+ (ABI 15) | `tree-sitter-wasms` must ship ABI-15 grammar builds |
| `coding-examples` skill stub | Merged into `coding-standards`, but the old `SKILL.md` still exists as a "do not load" redirect | Cleanup pass on skills directory |

---

## Module Coupling Map

Not every directory boundary is a clean module boundary. These implicit couplings are load-bearing — changing one side without the other breaks things in non-obvious ways.

| Coupling | Why it matters |
|----------|----------------|
| `lib/agent/index.js` ↔ `lib/context/` | The orchestrator assembles context (system prompt, memories, skills). Context assembly defines the prompt shape used by all providers — a change here changes agent behavior everywhere. |
| `lib/agent/index.js` ↔ `lib/agent/providers/*` | One orchestrator drives six provider loops (Anthropic, Ollama, DeepSeek, Gemini, Claude Code, Codex). Each loop expects the same tool schema format and message structure from the orchestrator. |
| `mcp/tools/*` all depend on `mcp/index.js` ctx | Every tool registration file receives the same `ctx` object. Adding/removing/renaming a field in `createContext()` silently breaks any tool that uses it. |
| `lib/routes/paths.js` → all file operations | Every `read_file`, `write_file`, `edit_file`, and shell tool gates through `paths.js`. A path traversal bug here is a security bug everywhere. |
| `db/migrations/` ↔ `db/migrations-sqlite/` | Must stay in lockstep. A migration in one but not the other causes silent schema drift between backends. |
| `lib/config.js` → `scripts/gen-env-example.js` | The config registry is the single source of truth; `gen-env-example.js` walks it to regenerate `.env.example`. Adding a config key without running the generator breaks CI. |
| `lib/agent/index.js` ↔ `lib/workers/skills.js` | Skill matching and injection is called during context assembly. Skill behavior changes propagate to every conversation. |
| `server.js` → `lib/handlers/` → `lib/agent/index.js` | The Express/WS server routes messages through handlers into the agent orchestrator. The WebSocket message protocol between `public/index.js` and `lib/handlers/` has no formal schema — both sides must agree on message shapes. |

---

## Key Commands

```bash
# Web UI (dev)
npm run start:local           # AI_PROVIDER=ollama PORT=31337
npm run start:lite            # + SQLite + transformers embeddings
npm run start:cloud           # PORT=1701 (uses .env provider)

# Terminal chat
npm run chat:local            # AI_PROVIDER=ollama PORT=31337
npm run chat:cloud            # PORT=1701

# Database
npm run migrate               # Postgres migrations
npm run migrate:sqlite        # SQLite migrations

# Configuration
npm run config:sync           # Import .env vars into DB panel
npm run gen:env               # Regenerate .env.example from config registry
npm run gen:env:check         # Check .env.example is up to date (CI gate)

# Testing
npm test                      # Full suite: node --test 'tests/**/*.test.js'
npm run test:skills           # Skills tests only
npm run test:store            # Store tests only
npm run test:memory           # Memory tool tests only
npm run test:execution        # Skill execution tests only
npm run test:backfill         # Embedding backfill tests only
npm run test:e2e              # End-to-end tests
npm run test:ci               # CI mode (with coverage via --experimental-test-coverage)
npm run test:only -- --test-name-pattern="pattern"  # Run specific test
npm run coverage              # Generate lcov report from c8

# MCP
npm run mcp                   # Start MCP stdio server standalone
```

---

## Configuration System

Configuration has three sources, resolved by precedence (`APERIO_CONFIG_PRECEDENCE`):

1. **`.env` file** — highest by default (`env` mode)
2. **Database** (Settings UI panel) — wins when precedence is `db`
3. **Built-in defaults** (in `lib/config.js`)

The config registry in `lib/config.js` defines every variable with type, default, and metadata. Run `npm run gen:env` to regenerate `.env.example` from it. Most settings are also editable from the Web UI Configuration panel.

Key env vars:
- `AI_PROVIDER` — `ollama` | `anthropic` | `deepseek` | `gemini` | `claude-code` | `codex`
- `CODEX_MODEL`, `CODEX_API_KEY`, `CODEX_SANDBOX`, `CODEX_APPROVAL_POLICY` — Codex CLI provider settings
- `DB_BACKEND` — auto-detected; force with `sqlite` or `postgres`
- `EMBEDDING_PROVIDER` — `transformers` (local) | `voyage` (cloud)
- `PORT` — default 31337
- `APERIO_ENABLE_SHELL` — opt-in shell execution (off by default)
- `APERIO_DB_ENCRYPT` — AES-256-GCM DB encryption
- `APERIO_CODEGRAPH` — symbol index (`on` to enable)
- `APERIO_DOCGRAPH` — document index (`on` to enable)

---

## Database

Two backends, auto-detected:

| Backend | Vector | Full-text | When |
|---------|--------|-----------|------|
| **SQLite** (default) | `sqlite-vec` | FTS5 | No Docker, single user, zero config |
| **Postgres** | `pgvector` | tsvector | Multi-agent, production-like, Docker |

Factory in `db/index.js` auto-picks when `DB_BACKEND` is unset: Postgres if Docker is running, SQLite otherwise.

### Key tables
- `memories` — vector + full-text indexed knowledge store
- `self_memories` — agent-private memory store (self_* tools), with FTS + vector side tables
- `wiki` — structured articles with versioning
- `self_wiki_articles` — agent-private wiki (+ `_sources`, `_revisions`)
- `agent_jobs` / `agent_runs` — background agent job tracking
- `conversations` — chat history
- `messages` — individual messages within conversations
- `settings` — key-value configuration store
- `code_symbols` / `code_references` — code graph index
- `doc_chunks` — document graph index

---

## MCP Tools

All tools registered in `mcp/index.js`. Each tool file in `mcp/tools/` exports a `register(server, ctx)` function.

| Category | Tools | File |
|----------|-------|------|
| Memory | `remember`, `recall`, `forget`, `update_memory`, `backfill_embeddings`, `deduplicate_memories` | `memory.js` |
| Self-memory | `self_remember`, `self_recall`, `self_update`, `self_forget` | `self-memory.js` |
| Self-wiki | `self_wiki_get`, `self_wiki_write` | `self-wiki.js` |
| Files | `read_file`, `write_file`, `edit_file`, `append_file`, `delete_file`, `read_docx`, `scan_project`, `generate_xlsx`, `generate_docx` | `files.js` |
| Web | `fetch_url`, `web_search` | `web.js` |
| Image | `read_image`, `preprocess_image`, `describe_image` | `image.js` |
| Shell | `run_shell`, `run_node_script`, `run_python_script`, `syntax_check` | `shell.js` |
| Wiki | `wiki_get`, `wiki_write`, `wiki_list`, `wiki_search` | `wiki.js` |
| Code graph | `code_search`, `code_context`, `code_outline`, `code_callers`, `code_callees`, `code_repos` | `codegraph.js` |
| Doc graph | `doc_search`, `doc_context`, `doc_outline`, `doc_refs`, `doc_repos` | `docgraph.js` |
| GitHub | `fetch_github_issue`, `create_github_issue`, `update_github_issue`, `list_github_issues`, `record_issue_triage` | `github.js` |
| Data | `export_data`, `import_data` | `data.js` |
| Database | `db_query`, `db_execute`, `db_schema`, `db_connections` (external DB connections) | `database.js` |

### Tool context (`ctx`)
Passed to every tool registration. Contains:
- `store` — DB instance (SQLite or Postgres)
- `generateEmbedding` — vector embedding function
- `vectorEnabled()` — whether vector search is active
- `embeddingQueue` — batched background embedding processor
- `providerIsLocal` — whether the current model runs locally (privacy gate)

---

## Skills System

Skills are modular agent instructions stored in `skills/<name>/SKILL.md`. ~30+ skills covering:
- **Agent behavior**: agent-conduct, reasoning-planning, conversation-lifecycle, memory-protocol, memory-learning, tool-integration, debugging-and-error-recovery, handoff
- **Code**: coding-standards, coding-examples, code-review-and-quality, code-simplification, test-driven-development, security-and-hardening, codegraph
- **Documents/Files**: pdf, docx, docx-advanced, pptx, xlsx, doc-coauthoring, docgraph, preprocess-pdf, preprocess-image, working-with-files
- **UI/Design**: canvas-design, design-randomizer, theme-factory, webapp-testing
- **Meta**: skill-creator, autotune, mcp-builder, prompt-optimizer, wiki

Skills are loaded on demand. The `skills/` directory is a flat list; test files live in `tests/skills/`.

---

## Testing

Uses Node.js native test runner (`node --test`). Tests mirror the source structure under `tests/`.

```bash
npm test                       # All tests
npm run test:skills            # skills/*.test.js
npm run test:store             # store/*.test.js
npm run test:memory            # tools/memory.test.js
npm run test:e2e               # e2e/*.test.js
npm run test:ci                # CI mode with coverage
npm run test:only -- --test-name-pattern="my test"  # Filter by name
```

Test helpers:
- `tests/mockDB.js` — in-memory SQLite store for tests
- `tests/mockStore.js` — mock store factory
- `tests/reporters/quiet.js` — CI reporter (used when `APERIO_AGENT_RUN` is set)
- `tests/e2e/helpers/ws-helper.js` — shared buffered-connect helpers for WebSocket E2E tests. `connectBuffered()` attaches the message listener before `open` resolves, eliminating the handshake race. `collectUntil(endType)` replaces fixed-sleep collection with event-driven termination. Always use this helper for new E2E tests.

Environment: `NODE_ENV=test` must be set for tests.

---

## Security Model

- **Path safety**: All file ops go through `lib/routes/paths.js`. Read/write are gated separately via `APERIO_ALLOWED_PATHS_TO_READ` / `APERIO_ALLOWED_PATHS_TO_WRITE`. Default: project root only.
- **Network guard**: `lib/helpers/netGuard.js` — DNS rebinding protection, host header/Origin validation
- **Auth guard**: `lib/helpers/authGuard.js` — optional shared-secret token (`APERIO_AUTH_TOKEN`)
- **Static auth**: `lib/helpers/staticAuth.js` — per-session cookie for `/uploads` / `/scratch`
- **Rate limiting**: `lib/helpers/rateLimit.js` — Express middleware
- **Shell sandbox**: `mcp/tools/shell.js` — allowlisted binaries, no operators, 60s timeout, off by default
- **DB encryption**: `db/encrypt.js` — AES-256-GCM, key stored in OS keychain
- **Helmet**: Security headers (CSP disabled pending inline-script refactor)
- **Crash breaker**: `lib/helpers/crashBreaker.js` — exits on repeated fatal errors to trigger supervisor restart

---

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

---

## Code Conventions

- **ESM only** — `import`/`export`, no `require`. `createRequire` only where unavoidable.
- **Node.js native test runner** — `node --test`, assert via `import assert from "node:assert/strict"`
- **No TypeScript** — plain JavaScript with JSDoc annotations
- **Config-driven** — all tunables go through `lib/config.js` registry, never hardcoded
- **Defensive error handling** — `server.js` has global `uncaughtException`/`unhandledRejection` guards with crash breaker
- **Path operations** — always use `lib/routes/paths.js` for path validation, never raw `fs` access

---

## CI/CD

GitHub Actions workflows in `.github/workflows/`:
- `ci.codeql.yml` — CodeQL analysis
- `ci.codecov.yml` — test coverage upload
- `ci.codacy.yml` — Codacy quality
- `ci.sonarqube.yml` — SonarQube
- `ci.npm-audit.yml` — dependency audit
- `ci.pr-guard.yml` / `ci.pr-lint-feedback.yml` — PR validation
- `cd.release.yml` — release automation
- `cd.gh-pages.yml` — docs site deployment
- Bot workflows for issue claims, moderation, stale claims

---

## Contribution Conventions

### Branch naming

AI agent commits use signed branches to distinguish them from human-authored work:

```
feature: <description> signed by <model-name>
fix: <description> signed by <model-name>
refactor: <description> signed by <model-name>
chore: <description> signed by <model-name>
```

Examples: `feature: llamacpp provider loop swap signed by DeepSeek-V4`, `fix: shell timeout hardened signed by Claude-Sonnet-4.6`, `refactor: config precedence cleanup signed by deepseek-v4-pro`.

Human-authored branches follow the same prefix convention without the signature: `feature: …`, `fix: …`, `chore: …`.

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`.

- `feat:` — new feature or capability
- `fix:` — bug fix
- `chore:` — maintenance, tooling, CI, deps
- `docs:` — documentation only
- `test:` — test changes only
- `refactor:` — code change that neither fixes a bug nor adds a feature

The scope is optional but encouraged for non-trivial changes (e.g., `feat(llamacpp):`, `fix(ci):`).

### Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Add entries under `## Unreleased` in the appropriate category (`Added`, `Changed`, `Fixed`, `Removed`). The release workflow (`cd.release.yml`) handles version bumping and moving unreleased entries to a dated release section.

### Versioning

Follows [Semantic Versioning](https://semver.org/). Version bumps are automated by `cd.release.yml` on merge to `master`. Do not manually bump `package.json` version — the release workflow reads conventional commit messages to determine the bump level.