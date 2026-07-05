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
- **Code graph**: `web-tree-sitter` + `tree-sitter-wasms`
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
