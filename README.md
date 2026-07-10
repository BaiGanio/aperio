<a id="top"></a>
<div align="center">
<h1>✨ Aperio</h1>

**One brain. Every agent. Nothing forgotten.**     
A self-hosted personal memory layer for AI agents. SQLite (or Postgres) + MCP + llama.cpp.   
Zero-config by default; one file holds your memories, wiki, and code graph.  
Your context, always available.  
##### • Download 👉 [Aperio-lite](https://github.com/BaiGanio/aperio/releases/latest/download/aperio-lite.zip) for non-code users. • Small tool for big ideas • [How to Install & Use?](https://github.com/BaiGanio/aperio/wiki/How-to-Install-&-Use-Aperio%E2%80%90lite%3F) •      
</div>

<!-- HEADER --> 
<p align="center">
  • 
  <a href="#getting-started">Getting Started</a>
  • 
  <a href="#architecture">Architecture</a>
  • 
  <a href="#philosophy">Philosophy</a>
  • 
  <a href="#ai-providers">AI Providers</a>
  • 
  <a href="https://github.com/BaiGanio/aperio/wiki/MCP-Tools-Guide" target="_blank">How To Use?</a> 
  •  
  <a href="#privacy">Privacy</a> 
  • 
  <a href="#security">Security</a>
  •  
  <a href="https://github.com/BaiGanio/aperio/discussions/24">Design Decisions</a>
  • 
</p>
<div align="center">   

#### • 🌐 Site: [https://baiganio.github.io/aperio](https://baiganio.github.io/aperio) •
<!-- [![Bounties Available](https://img.shields.io/badge/bounties-active-brightgreen)](./PAYMENT.md) --> 
[![Downloads](https://img.shields.io/github/downloads/baiganio/aperio/total?style=flat-square)](https://github.com/baiganio/aperio/releases)
![Latest Release](https://img.shields.io/github/v/release/BaiGanio/aperio) 
![GitHub contributors](https://img.shields.io/github/contributors/baiganio/aperio)
[![Last Commit](https://img.shields.io/github/last-commit/baiganio/aperio)](https://github.com/baiganio/aperio)
[![CodeQL](https://github.com/baiganio/aperio/actions/workflows/ci.codeql.yml/badge.svg)](https://github.com/baiganio/aperio/actions/workflows/ci.codeql.yml)
[![codecov](https://codecov.io/github/BaiGanio/aperio/graph/badge.svg?token=WUIXIYJBR2)](https://codecov.io/github/BaiGanio/aperio)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=BaiGanio_aperio&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=BaiGanio_aperio)
[![Codacy Badge](https://app.codacy.com/project/badge/Grade/989578993b87414db9ff64a2b3c22989)](https://app.codacy.com/gh/BaiGanio/aperio/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_grade)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot)](https://github.com/baiganio/aperio/security/dependabot)
[![Security Policy](https://img.shields.io/badge/security-policy-green?logo=github)](https://github.com/baiganio/aperio/security/policy)

</div>

<p align="center">
  <!-- <sub>💡 <b>Pro Tip:</b> Visit <a href="https://github.com/BaiGanio/aperio/wiki/How-to-Install-&-Use-Aperio%E2%80%90lite%3F">How to Install & Use Aperio‐lite?</a> for extensive installation instructions.<br> -->
  💡 <b>Pro Tip:</b> Visit the <a href="https://github.com/BaiGanio/aperio/wiki">Aperio Wiki</a> or <a href="https://github.com/BaiGanio/aperio/discussions">Discussions</a> for extensive documentation on advanced topics.<br>
   🔍 <b>Explore more:</b> <a href="https://github.com/BaiGanio/aperio/issues/3">Early Testing Contributors</a> • <a href="https://github.com/BaiGanio/aperio/discussions/14">FAQ</a> • <a href="https://github.com/BaiGanio/aperio/wiki/Troubleshooting">Troubleshooting</a>
</p>

---
## 🏗️ (Quick) Project Structure 
```txt
📂 aperio/          <---=  You are here if You are Developer. He-he ;/
├── 📂 db/
│   ├── index.js                  # Store factory — auto-selects Postgres or SQLite
│   ├── sqlite.js                 # SQLite + sqlite-vec + FTS5 adapter (zero config, default)
│   ├── postgres.js               # Postgres + pgvector adapter (Docker)
│   ├── types.js                  # Shared DB types
│   ├── 📂 migrations/            # Postgres SQL (memories + wiki + codegraph)
│   └── 📂 migrations-sqlite/     # SQLite SQL (same schemas, FTS5 + vec0)
├── 📂 docker/
│   └── docker-compose.yml        # pgvector/pgvector:pg16
├── 📂 docs/
│   └── index.html                # Landing page for GitHub Pages
├── 📂 id/
│   └── whoami.md                 # Instructions for AI agent identity (edit this!)
├── 📂 lib/
│   ├── agent.js                  # Agent entry point — provider loops live in lib/agent/providers/
│   ├── 📂 agent/                 # Provider loops, tool hooks, profiles, lifecycle middleware
│   ├── terminal.js               # Terminal chat client
│   ├── 📂 emitters/              # CLI and WebSocket stream emitters
│   ├── 📂 handlers/              # Attachment and memory handlers
│   ├── 📂 helpers/               # Embeddings, logger, port, shutdown, llama.cpp health
│   ├── 📂 context/               # Context trimming + private large-result artifact storage
│   ├── 📂 security/              # Durable interrupt service for resumable sensitive actions
│   ├── 📂 routes/                # Express API routes + path safety guards
│   ├── 📂 utils/                 # Chat utilities
│   └── 📂 workers/               # Deduplication, reasoning adapters, skill loader
├── 📂 lib/codegraph/             # Pre-indexed code knowledge graph (symbols, calls, imports)
│   ├── indexer.js                # Backend dispatcher (Postgres or SQLite)
│   ├── watcher.js                # chokidar-backed live reindex
│   ├── extract-ts.js             # tree-sitter JS/TS/JSX/TSX extractor
│   └── 📂 backends/              # postgres.js · sqlite.js
├── 📂 mcp/
│   ├── index.js                  # MCP server entry point
│   └── 📂 tools/
│       ├── memory.js             # remember · recall · update_memory · forget · backfill_embeddings · deduplicate_memories (6)
│       ├── self-memory.js         # self_remember · self_recall · self_update · self_forget (4)
│       ├── files.js              # read_file · write_file · append_file · edit_file · read_docx · scan_project · delete_file · generate_xlsx · generate_docx (9)
│       ├── wiki.js               # wiki_write · wiki_search · wiki_list · wiki_get (4)
│       ├── codegraph.js          # code_search · code_outline · code_context · code_callers · code_callees · code_repos (6)
│       ├── docgraph.js           # doc_search · doc_repos · doc_outline · doc_context · doc_refs (5)
│       ├── shell.js              # run_node_script · run_python_script · run_shell · syntax_check (4)
│       ├── web.js                # fetch_url · web_search (2)
│       ├── image.js              # read_image · preprocess_image · describe_image (3)
│       ├── github.js             # fetch_github_issue · create_github_issue · update_github_issue · list_github_issues · record_issue_triage (5)
│       ├── data.js               # export_data · import_data (2)
│       └── database.js           # db_connections · db_schema · db_query · db_execute (4)
├── 📂 public/
│   └── index.html                # Web UI — themes, streaming, sidebar
├── 📂 skills/                    # Memory, reasoning, tools, coding standards, etc.
├── 📂 tests/      
├── .env.example                  # Essentials + bootstrap only (everything else → Configuration panel)
├── package.json                  # Dependencies
└── server.js                     # Express + WebSocket + agent loop
 
```

> **💡 Tip:** **`whoami.md`** controls the identity of the AI agent.    
> - It is the most impactful file to customize.

---

## Getting Started 

### Three ways to install

| | For whom | How |
|---|---|---|
| **1 · Aperio-lite** | Non-coders — no terminal, ever | [Download the zip](https://github.com/BaiGanio/aperio/releases/latest/download/aperio-lite.zip), unzip, double-click `START` — a browser wizard installs everything and picks a model for your machine. See the [lite guide](https://github.com/BaiGanio/aperio/wiki/How-to-Install-&-Use-Aperio%E2%80%90lite%3F). |
| **2 · One command** | Terminal users who want painless updates | `curl -fsSL https://raw.githubusercontent.com/BaiGanio/aperio/release/.github/lite/install.sh \| bash` — clones the `release` branch and starts Aperio. Re-run anytime to update in place; your memory database is preserved. |
| **3 · From source** | Contributors / full control | `git clone -b dev` + `npm install` — the steps below. |

> Methods 1–2 install from the `release` branch (and the release zip), published on each release. The steps below cover method 3.

### Prerequisites
- Node.js 18+ — download from [https://nodejs.org/en/download](https://nodejs.org/en/download)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — (optional, for Postgres mode)
- *(nothing to install for local AI — Aperio vendors and manages its own llama.cpp engine)*
- [Anthropic API key](https://console.anthropic.com) — (optional, for cloud AI)
- [DeepSeek API key](https://platform.deepseek.com) — (optional, for cloud AI)
- [Google Gemini API key](https://aistudio.google.com/apikey) — (optional, for cloud AI)
- [OpenAI Codex CLI](https://developers.openai.com/codex/cli/) — (optional; use cached login or `CODEX_API_KEY`)
- [Voyage AI API key](https://www.voyageai.com/) — (optional, for cloud embeddings)

### Step 1. Clone & Configure Environment Variables
Dedicated `dev` branch stripped from the file/folder noise. Only what's needed.
```bash
# dedicated developer branch - no extra files
git clone --depth 1 -b dev https://github.com/BaiGanio/aperio.git
cd aperio

# restore dependencies
npm install
```
> Ready to use `.env.example` for a fully local setup. The template is tiny —
> just the essentials plus bootstrap plumbing; **everything else is configured
> in the app's Configuration panel** (see below), not in `.env`:
```env
# cp .env.example .env

AI_PROVIDER=llamacpp
LLAMACPP_MODEL=Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M
# DB_BACKEND=sqlite               # default (auto-detected); uncomment to force
# SQLITE_PATH=./sqlite/aperio.db  # default location for the single-file DB
```
> Embeddings default to local `transformers` (no key) — switch to Voyage, or
> change any other setting, in the Configuration panel.

### Step 2. Databases & Migrations

Aperio supports two storage backends. **You don't need to choose** — auto-detect picks
the right one based on whether Docker is running:

| Backend | When to use | Requires |
|---------|-------------|----------|
| **SQLite + sqlite-vec** (default) | No Docker, quick start, single user. Single file at `var/aperio.db`. | Nothing extra |
| **Postgres + pgvector** | Multi-agent, persistent, production-like | Docker |

```bash
# SQLite is the default — no extra steps needed.
# Skip the Docker commands below and go directly to Step 3.
```

> **💡 Tip:** Set `DB_BACKEND=sqlite` in `.env` to force SQLite, or `DB_BACKEND=postgres` for Postgres.   
> If not set, Aperio auto-detects: uses Postgres when Docker is running, SQLite otherwise.

```bash
# POSTGRES MODE — start the database and run migrations (run from the repo root)
# --env-file .env is required: the compose file lives in docker/ but .env is at
# the repo root, and Compose only looks for .env next to the compose file.
docker compose -f docker/docker-compose.yml --env-file .env up -d
npm run migrate

# PRODUCTION — full stack (app + Postgres) in one go. Same --env-file rule applies.
docker compose -f docker/docker-compose.prod.yml --env-file .env up -d
```
### Step 3. Local AI Engine — Nothing to Install
> **💡 Tip:** Skip this step entirely when using a cloud or CLI-backed `AI_PROVIDER`.
> For `AI_PROVIDER=llamacpp`, there is no separate engine to install or run —
> Aperio vendors and manages `llama-server` itself: it downloads the pinned
> binary on first run, spawns and monitors it, and downloads the GGUF model
> you pick (or the one `LLAMACPP_MODEL` names) the first time it's needed.
```env
LLAMACPP_MODEL=Qwen/Qwen3-30B-A3B-GGUF:Q4_K_M     # strong reasoning, MoE, best tool-calling
# LLAMACPP_MODEL=ggml-org/gemma-4-12B-it-GGUF:Q4_K_M   # general-purpose, dense
# LLAMACPP_MODEL=Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M  # lightweight fallback, runs anywhere
```
### Step 4. Start Aperio Web UI
```bash
npm run start:local              # localhost:31337 → browser opens automatically
```

> The Web UI includes a flag-based switcher for all 24 official EU languages, plus
> Chinese (中文) and Japanese (日本語). Every locale ships with the complete
> 304-key interface catalog, and your selection persists across restarts.
> Contributors can verify locale parity, placeholders, HTML tags, and statically
> referenced UI keys with `npm run i18n:check`.

### Step 5. Start Aperio terminal chat
```bash
npm run chat:local               # runs as proxy or standalone
```

> That's it. No API keys. No cloud. Full semantic memory on your machine.

> **💡 New to the chat?** Type `help` for a guided tour — every command comes
> with a runnable `try:` example. Type `help <command>` (e.g. `help attach`) for
> focused docs, or `examples` to hide/show the example lines (your choice sticks).
> Prefer another language? `lang de` (or set `APERIO_UI_LANG` in `.env`) localizes
> the welcome/help text — English is the default and per-string fallback. Want a
> clean slate? `restart` starts a fresh conversation; `restart --hard` relaunches.

> **💡 Configure from the Web UI — no `.env` editing required.** The sidebar
> **Configuration** panel exposes every setting as a typed control (toggle /
> select / number / text / chips / secret): pick your `AI_PROVIDER`, paste API
> keys, switch embeddings, toggle the code/doc graph, and more. Values are saved
> to the database (precedence: `.env` > DB > default by default; set
> `APERIO_CONFIG_PRECEDENCE=db` — or flip it in the panel — to let the UI win)
> and apply after a restart
> (a banner reminds you). Bootstrap/security plumbing (ports, DB creds, TLS,
> auth token) stays read-only here — those live in `.env`. Editing `.env`
> directly still works for developers; run `npm run config:sync` to import any
> hand-added vars into the panel.

### Q: Now what?

>💡 Stuck on the installation steps? — check [Troubleshooting](https://github.com/BaiGanio/aperio/wiki/Troubleshooting) wiki.

>💡 Check [Aperio MCP Tools Guide](https://github.com/BaiGanio/aperio/wiki/MCP-Tools-Guide) wiki for extended examples.   
>💡 Check [Commands](https://github.com/BaiGanio/aperio/wiki/Commands) wiki for the available options to run the app.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Architecture
<img alt="Aperio architecture" src="https://raw.githubusercontent.com/BaiGanio/aperio/master/.github/images/aperio-architecture.png" />

#### Q: Feel a need to read?
> **💡 Tip:** Visit [Architecture & Design](https://github.com/BaiGanio/aperio/discussions/24) for **in-depth** explanations.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Round-table mode (two-agent cross-review)

Aperio can boot a **second agent** alongside the primary so that any chat turn
can be cross-reviewed before it reaches you. Two agents take turns: **Agent A**
answers, **Agent B** reviews, A revises, B re-reviews — until they reach
explicit `AGREED` or a hard round cap is hit. A single consensus bubble is
rendered when they agree; otherwise both positions are shown side-by-side.

**Enable it** in the **Configuration panel** (Round-table section), or with `ROUNDTABLE_AGENTS` in `.env`:

```env
# Format: provider:model,provider:model
ROUNDTABLE_AGENTS=anthropic:claude-haiku-4-5-20251001,deepseek:deepseek-chat
ROUNDTABLE_MAX_ROUNDS=3
```

When set, the chat UI gains a **Discuss** toggle next to the send button.
Toggle it ON to route the next turn through the round-table; OFF behaves
identically to single-agent chat. If `ROUNDTABLE_AGENTS` is unset or only one
pair parses, the toggle stays disabled and the app behaves exactly as before.
Internally, each round-table participant is created from the same validated
`AgentSpec` contract used by the main agent, preserving provider/model and
character behavior while keeping the runtime contract explicit.

Personas live in `id/whoami-primary.md` and `id/whoami-verifier.md` — edit them
to tune how each agent answers or critiques.

**Domain characters** layer expertise on top of each agent's role. Set
`ROUNDTABLE_CHARACTERS` to a comma-separated pair of slugs (first → Agent A,
second → Agent B). Each slug resolves to `id/characters/<slug>.md`.

| When you want… | Set `ROUNDTABLE_CHARACTERS` to |
|---|---|
| Code review | `software-architect,code-reviewer` |
| Security audit | `software-architect,security-engineer` |
| Product decision | `product-thinker,software-architect` |
| Open-ended question | `socratic-questioner,software-architect` |
| Domain-specific | `space-engineer,doctor` |

Available characters: `software-architect`, `code-reviewer`, `security-engineer`,
`product-thinker`, `socratic-questioner`, `doctor`, `space-engineer`. Add your own
by dropping a `.md` file into `id/characters/`.

**Manifestos.** After each round-table concludes (consensus or not), each agent
writes a personal manifesto — a short, opinionated final statement. Both are saved
to `var/roundtables/aperio-manifesto-{sessionId}.md` and served at `/roundtables/`
for preview and download. Manifesto generation is best-effort; it never blocks the
round-table result from reaching you.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Code Graph

Aperio ships a **pre-indexed code knowledge graph** so an agent can query
your codebase instead of reading 50 files to answer "who calls X?" or
"where is Y defined?". Symbols, calls, imports, and `extends` edges are
extracted with tree-sitter (JS / TS / JSX / TSX) and stored alongside
your memories.

Two ways to use it:

```bash
# 1. One-shot index of the current directory
node lib/codegraph/indexer.js .

# 2. Live mode — start the server with a file watcher that reindexes on save
APERIO_CODEGRAPH=on npm run start:local
```

The graph respects `APERIO_ALLOWED_PATHS_TO_READ`, so you can index
multiple repos at once (e.g. Aperio + a side project). The sidebar in
the web UI has a "Code" panel for searching symbols and walking
callers / callees visually; the model uses the same data via the
`code_*` MCP tools listed below.

**Backend support:** Postgres and SQLite both work. With SQLite (the
default), the graph lives in the same `var/aperio.db` file as your
memories.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## MCP Tools

Aperio exposes **54 tools** across 12 categories over MCP. Any MCP-compatible agent (Cursor, Windsurf, Claude, etc.) can call them.

| Category | Tool | What it does |
|----------|------|-------------|
| **Memory** | `remember` | Save a memory with type (`fact`, `preference`, `workflow`, …), title, tags, importance, and optional expiry |
| | `recall` | Semantic or full-text search across all memories |
| | `update_memory` | Update an existing memory by ID; tombstones the old version, re-generates its embedding |
| | `forget` | Delete a memory by ID |
| | `backfill_embeddings` | Generate embeddings for memories that are missing one |
| | `deduplicate_memories` | Find and merge near-duplicate memories by cosine similarity |
| **Self-Memory** | `self_remember` | Save a note to the agent's own walled-off store — separate from user memory |
| | `self_recall` | Search the agent's own notes semantically or by full-text |
| | `self_update` | Revise one of the agent's own notes in-place by ID |
| | `self_forget` | Delete one of the agent's own notes by ID |
| **Wiki** | `wiki_write` | Create or update a wiki article (LLM-authored, cited synthesis); upserts by slug, bumps revision |
| | `wiki_search` | Hybrid full-text + semantic search over articles — call before `wiki_write` |
| | `wiki_list` | Browse articles newest-first by tag / status / `updated_since` |
| | `wiki_get` | Fetch a full article by slug, with breadcrumb and optional stale-refresh |
| **Code Graph** | `code_search` | Hybrid FTS + semantic search over pre-indexed symbols (functions, classes, methods, consts) |
| | `code_outline` | List every symbol in a file by line — cheap map before reading |
| | `code_context` | Fetch the source slice for a qualified symbol, with leading doc and line padding |
| | `code_callers` | Walk the reverse call graph (depth-capped) — who calls this? |
| | `code_callees` | Walk the forward call graph (depth-capped) — what does this call? |
| | `code_repos` | List indexed repos with file / symbol counts and last-indexed timestamp |
| **Doc Graph** | `doc_search` | Semantic + FTS search over pre-indexed document passages |
| | `doc_repos` | List indexed doc folders with chunk counts and by-mime breakdown |
| | `doc_outline` | Section tree (TOC) for one document — cheap map before fetching |
| | `doc_context` | Fetch text of one section or chunk by id |
| | `doc_refs` | Cross-document reference lookup (IDs, URLs, citations) |
| **Files** | `read_file` | Read a code or text file (max 500 lines per call, paginated via `offset`) |
| | `write_file` | Create or overwrite a file (subject to write-path guard) |
| | `append_file` | Append content to an existing file without touching the rest |
| | `edit_file` | Replace an exact string in a file (`replace_all` for multiple occurrences) |
| | `read_docx` | Read and extract text from `.docx` files |
| | `scan_project` | Traverse a project folder — returns a file tree and reads key files |
| | `delete_file` | Delete a file by path (subject to write-path guard) |
| | `generate_xlsx` | Generate a multi-sheet `.xlsx` workbook, served for download |
| | `generate_docx` | Create `.docx` Word documents programmatically |
| **Shell** | `run_node_script` | Run a `.js` script inside an allowed write path; returns its output |
| | `run_python_script` | Run a `.py` script inside an allowed write path; returns its output |
| | `syntax_check` | Check a JavaScript file for syntax errors without executing it |
| | `run_shell` | Execute a shell command with output capture |
| **Web** | `fetch_url` | Fetch a URL, strip HTML, truncate at 15 000 characters |
| | `web_search` | Search the web via DuckDuckGo, return ranked results |
| **Image** | `read_image` | Load an image (file path or base64) for the agent to analyze |
| | `preprocess_image` | Normalize an image to RGB PNG before sending to a local VLM (strips alpha, letterboxes to 896×896) |
| | `describe_image` | Send an image to a local llama.cpp vision model (VLM) and return a text description |
| **GitHub** | `fetch_github_issue` | Read a GitHub issue with comments and metadata |
| | `create_github_issue` | Open a new issue on a GitHub repository |
| | `update_github_issue` | Edit an existing GitHub issue |
| | `list_github_issues` | List open issues for triage across repos |
| | `record_issue_triage` | Record a triage verdict for an issue |
| **Data** | `export_data` | Export memories & wiki to a portable JSON file |
| | `import_data` | Import memories & wiki from a previously-exported JSON file |
| **Database** | `db_connections` | List available external database connections (never exposes credentials) |
| | `db_schema` | Introspect tables, columns, indexes, and foreign keys |
| | `db_query` | Run ONE read-only SQL statement with parameterized bindings |
| | `db_execute` | Propose a write/DDL statement — confirm-before-write flow |

> `.docx` and `.xlsx` files can also be generated via the `skills/docx/` and `skills/xlsx/` skill scripts. PowerPoint files are generated by writing a script (see `skills/pptx/`) and running it via `run_node_script` — there is no dedicated `pptx` tool.

> **💡 Tip:** Check [Aperio MCP Tools Guide](https://github.com/BaiGanio/aperio/wiki/MCP-Tools-Guide) for call examples.

### Large tool results

When a shell command, file read, or other tool returns more content than the
model can safely keep in context, Aperio stores the complete redacted result in
a private session/run artifact and gives the model a bounded head/tail preview
with its artifact ID. This prevents a single large result from displacing the
conversation while preserving the full local output. After the first offload in
a run, Aperio attaches the read-only `read_artifact` tool. It reads the stored
result by byte `offset` and `limit`, reports `next_offset`, and never accepts a
session or run owner from the model.

The effective token threshold is capped at 25% of the active model's context
window. Retrieval defaults to 8,192 content bytes per call, accepts at most
24,000 content bytes, and caps the complete response at 32,000 bytes. Both
offload thresholds are editable in the Configuration panel:

```env
APERIO_TOOL_RESULT_OFFLOAD_TOKENS=20000
APERIO_TOOL_RESULT_OFFLOAD_BYTES=80000
```

Artifacts are private files under `var/agent-artifacts/`. Session artifacts
follow `SESSION_RETENTION_DAYS` (14 days in the default configuration) and are
removed immediately when their session is deleted. Run artifacts follow
`AGENT_RUN_RETENTION_DAYS`; unset or `0` retains run history and artifacts
indefinitely. Logs and background-run history record only artifact count, byte
count, ID/scope, and source tool—not stored content.

To test result offloading, retrieval, observability, and retention:

```bash
# Focused automated coverage
NODE_ENV=test node --test \
  tests/lib/context/artifactStore.test.js \
  tests/lib/context/toolResultOffload.test.js \
  tests/lib/context/artifactRetrieval.test.js \
  tests/lib/agent/tool-hooks.test.js \
  tests/lib/helpers/sessions.test.js \
  tests/lib/workers/agent-run-prune.test.js \
  tests/lib/workers/agent-scheduler.test.js

# Database migration/history coverage
NODE_ENV=test node --test tests/db/sqlite.test.js tests/db/postgres.test.js
```

For a manual check, temporarily set
`APERIO_TOOL_RESULT_OFFLOAD_BYTES=1000`, restart Aperio, and ask a capable model
to read a text file larger than 1 KB. Confirm the preview contains an artifact
ID, a subsequent model iteration offers `read_artifact`, and the server log
contains `[tool-result-offload]` metadata without the file contents. Delete the
chat from History and confirm its directory under
`var/agent-artifacts/sessions/` is removed. Restore the normal threshold after
the check.

### Agent lifecycle middleware

`lib/agent/middleware.js` defines Aperio's provider-neutral orchestration
contract: `beforeModel`, `selectTools`, `beforeTool`, `afterTool`, `afterModel`,
`onInterrupt`, and `onError`. Named middleware runs in registration order
against immutable request snapshots. Hooks may return a shallow update or
explicitly stop the chain; failures retain hook and middleware identity while
notifying every error observer.

Tool calls now pass through named safety middleware for failure-budget gating,
repeated-call detection, untrusted-content fencing, taint propagation, and the
taint-to-confirm signal on writes. Existing event payloads and safety limits are
preserved.

The native Anthropic, llama.cpp, Gemini, and DeepSeek loops also receive one
canonical context composed by named middleware: bounded/trimmed messages,
memory pointers, matched skill prompts, selected canonical MCP tools, and
losslessly offloaded large results. Each provider adapter still owns its wire
format and secret-redaction boundary. Claude Code and Codex retain their
SDK/CLI-managed context paths.

Each native run keeps a bounded in-memory lifecycle trace for diagnostics.
`agent.getLifecycleTrace()` returns the latest run's read-only entries and
retention statistics. Entries include only hook/middleware identity, relative
timing, decision (`continue`, `update`, `stop`, or `error`), and error class.
The trace retains at most 200 entries and never stores prompts, tool arguments,
tool results, exception messages, secrets, or artifact contents.

`lib/security/interruptService.js` provides the durable foundation for
resumable sensitive actions. Pending action descriptors are stored in the same
SQLite/Postgres backend as sessions and background runs with tool name,
canonical arguments or a protected payload reference, digest, allowed decisions,
status, timestamps, expiry, and claim/completion metadata. The service supports
approve, edit, reject, and respond decisions; repeated identical decisions are
idempotent, conflicting replays are rejected, and approved/edited actions must
be atomically claimed before execution so they cannot run twice. File
write/append/edit/delete confirmations now use this service while preserving
the existing `wr_...` / `del_...` token UX, capped edit diffs, tainted-turn
confirmation, and clean scratch-workspace auto-writes. Database writes through
`db_execute` use the same durable service with JSON-stored connection name,
normalized SQL, bound params, statement class, and commit-time revalidation of
SQL classification plus connection write permissions. The Web UI and
`/api/interrupts` surface pending descriptors after reconnect and support
approve, safe JSON argument editing, reject with optional feedback, and respond
without execution; approve/edit still atomically claim and revalidate before any
file or database change runs.

Fresh SQLite and Postgres stores also seed a disabled `nightly-maintenance`
background-agent example. It runs `backfill_embeddings` followed by dry-run
`deduplicate_memories` when the user explicitly enables the job and background
agent scheduler. Freeform background jobs persist their provider/model,
persona, character, timeout, and tool policy through validated `AgentSpec`
definitions; older job records are normalized on read/write.

Advanced agent setups can also be packaged as a portable bundle directory and
passed to `createAgent({ bundleDir })`. A bundle may contain `AGENT.md`,
`permissions.json`, `memory-scopes.json`, `output.schema.json`, and local
`skills/`; explicit administrator specs still bound tools, filesystem/memory
permissions, interrupts, recursion, concurrency, and timeouts.

```bash
NODE_ENV=test node --test \
  tests/lib/agent/middleware.test.js \
  tests/lib/agent/model-context-middleware.test.js \
  tests/lib/agent/tool-hooks.test.js
```

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Philosophy
Aperio is open source and self-hosted because **your memories is yours**.
- It runs entirely on your machine - no API keys, no data leaving your network, no cloud dependency.   
- Default is local and private. The option - self-hosted. The price - free forever.   
- Cloud AI is available as a power upgrade, but you will be never forced to use it.    

| | |
|---|---|
| 🔒 **Local by default** | ☁️ **Cloud as upgrade** |
| llama.cpp + local embeddings — zero external calls | Claude / DeepSeek for deep research & heavy tasks |

| | |
|---|---|
| 🗄️ **Your brain, your data** | 🖥️ **MCP-native** |
| Postgres or SQLite lives on your machine. You own it. | Any MCP agent plugs in — Cursor, Windsurf, etc. |

| |
|---|
| ✅ **Free to run** | |
| No subscription. No per-message cost. Just your hardware. | |

> #### ‼️ What Aperio Is Not

**Deployment model:**

| | |
|---|---|
| 🚫 **Not a cloud service** | 🚫 **Not a managed product** |
| No hosted version, no SaaS, no managed infra | No support contracts, SLAs, or guaranteed uptime |

| | |
|---|---|
| 🚫 **Not plug-and-play** | 🚫 **Not production-hardened** |
| Needs Node.js and basic terminal comfort | Early software, built in the open, improving fast |

**Feature scope — what Aperio will never become:**

| | |
|---|---|
| 🚫 **Not a chat app** | 🚫 **Not a general-purpose AI agent** |
| The bundled Web UI and terminal client are conveniences for setup and inspection — not the product. Aperio is an MCP server first. | Aperio provides memory, wiki, and code-graph tools TO agents. It does not replace the agent itself. |

| | |
|---|---|
| 🚫 **Not a replacement for Claude, Cursor, or Windsurf** | 🚫 **Not a multi-tenant SaaS platform** |
| Aperio is a memory layer that sits alongside your existing AI tools. It augments them — it does not compete with them. | Single-user, single-machine by design. No accounts, no organizations, no billing system. Will stay that way. |

| | |
|---|---|
| 🚫 **Not a plugin or extension** | 🚫 **Not a "build everything" platform** |
| It's a self-hosted server you run yourself — not something you install into another app. | Aperio says no to feature ideas that dilute the core: memory + code graph for MCP agents. If a feature doesn't serve that sentence, it doesn't ship. |

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## AI Providers

Switch in the **Configuration panel** (`AI_PROVIDER`), or with a single line in `.env`. Everything else — memories, tools, UI — stays identical.

```env
AI_PROVIDER=llamacpp     # "llamacpp" | "anthropic" | "deepseek" | "gemini" | "claude-code" | "codex"
```

### ⬡ llama.cpp (Default — Local, Free, Private)

No API keys, no data leaving your machine. Aperio vendors and fully manages the
`llama-server` engine itself — no separate install, no daemon to run.

```env
AI_PROVIDER=llamacpp
LLAMACPP_MODEL=Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M
LLAMACPP_BASE_URL=http://127.0.0.1:8080
```

Recommended models (an HF repo[:quant] string — downloaded automatically on first use):

| Model | Best for |
|-------|----------|
| `Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M` | **Default** — lightweight, runs anywhere (≥ 8 GB RAM) |
| `ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M` | General-purpose, good tool-calling (≥ 8 GB RAM) |
| `ggml-org/gemma-4-12B-it-GGUF:Q4_K_M` | Stronger general-purpose (≥ 24 GB RAM) |
| `Qwen/Qwen3-30B-A3B-GGUF:Q4_K_M` | Heavy reasoning, MoE — fast even on modest hardware via expert offload (≥ 48 GB RAM, or use the `fast-low-vram` perf profile) |

> **💡 Tip:** Aperio detects your RAM and flags the best-fitting model as **(recommended)** — in the setup wizard and in the terminal model picker — so you don't have to guess. `APERIO_LOCAL_PERF_PROFILE` (`balanced` | `fast-low-vram` | `long-context` | `quality`) tunes the pick and the engine's launch flags for your hardware.

### ✦ Anthropic Claude (Optional — Cloud Upgrade)

For heavy research, complex multi-step reasoning, or the strongest tool-calling available.

```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

Available models (set via `ANTHROPIC_MODEL`):

| Model | Notes |
|-------|-------|
| `claude-haiku-4-5-20251001` | Fast and cost-efficient — good default |
| `claude-sonnet-4-6` | Balanced performance and cost |
| `claude-opus-4-7` | Most capable, highest cost |

### ◈ DeepSeek (Optional — Cloud Upgrade)

Cost-effective cloud alternative with strong reasoning capabilities.

```env
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-chat
```

Sign up at [platform.deepseek.com](https://platform.deepseek.com). No vision support — image tools are disabled in DeepSeek mode.

### ◆ Google Gemini (Optional — Cloud Upgrade)

Large context window with native vision support.

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash
```

Get a key from [aistudio.google.com](https://aistudio.google.com/apikey).

### OpenAI Codex CLI (Optional — Coding Agent)

Install a current Codex CLI, authenticate it, and select the provider:

```bash
codex login
codex login status
```

```env
AI_PROVIDER=codex
CODEX_MODEL=gpt-5.5
CODEX_SANDBOX=workspace-write
CODEX_APPROVAL_POLICY=never
```

For usage-based API authentication, set `CODEX_API_KEY` instead of relying on
cached CLI login. Codex runs non-interactively and connects to Aperio's MCP
server. The configured Aperio MCP server is approved automatically because
there is no interactive approval bridge in the chat UI.

Use this provider only in a trusted workspace. The sandbox limits writes, but
does not make readable project files or process credentials secret from code
the agent runs. `danger-full-access` should only be used inside an externally
isolated environment.

Codex threads are stored per Aperio session, so continuing a saved session can
resume the matching Codex transcript after an Aperio restart.

---

## Embeddings

Embeddings power semantic search across your memories. Aperio supports two providers:

```env
EMBEDDING_PROVIDER=transformers   # "transformers" | "voyage"
```

### HuggingFace Transformers (Default — Fully Local)

Downloads `mixedbread-ai/mxbai-embed-large-v1` (ONNX, quantized) on first run. No daemon, no API key, no network calls after the initial download.

```env
EMBEDDING_PROVIDER=transformers
```

### Voyage AI (Optional — Cloud)

Higher-quality embeddings, free tier: 50M tokens/month.

```env
EMBEDDING_PROVIDER=voyage
VOYAGE_API_KEY=pa-...
```

Sign up at [dash.voyageai.com](https://dash.voyageai.com).

#### Q: Is that all?
> **💡 Tip:** Check out our wiki pages [AI Agents Comparison](https://github.com/BaiGanio/aperio/wiki/AI-Agents-Comparison) & [Embeddings](https://github.com/BaiGanio/aperio/wiki/Embeddings) for more details.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Privacy

### Reading Files with Local AI

llama.cpp itself has no file system access — it's purely an inference engine.
Aperio's MCP layer bridges the gap.

When you ask the AI to read a file, here's what actually happens:
```
You         →  "read /path/to/server.js and explain the WebSocket handler"
MCP Server  →  calls read_file tool, loads the file from disk
llama.cpp   →  receives the file contents as context, reasons over it
You         ←  answer based on your actual code
```

The model never touches your file system directly.
Aperio reads the file and injects the content into the conversation.

#### Q: You call this privacy?
> 💡 Check out our wiki page [MPC Tools](https://github.com/BaiGanio/aperio/wiki/MPC-Tools) for more details.  

### Memory Sensitivity Tiers

Every memory has a `tier` that controls how it's handled when the model is a
cloud provider (Anthropic, DeepSeek, Gemini, Claude Code, Codex):

| Tier | Label | On cloud |
|:---:|-------|----------|
| **1** | Normal (default) | Always shared as-is |
| **2** | Sensitive | Withheld or PII-redacted per `APERIO_CLOUD_SENSITIVE_MODE` |
| **3** | Private | Never leaves the machine — hard-blocked |

The legacy `local-only` tag still works and automatically maps to **tier 2**.

**`APERIO_CLOUD_SENSITIVE_MODE`** (default: `withhold`):
- `withhold` — tier-2 memories are filtered out of recall on cloud providers
- `redact` — tier-2 memories are sent with PII scrubbed (EMAIL, PHONE, CARD,
  IBAN patterns), then restored in the model's response. Set in your
  Configuration panel or `.env`.

On a **local llama.cpp** provider all tiers are shown regardless — nothing leaves
your machine.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Security
Aperio runs on your machine and has access to your file system through the `scan_project`, `write_file`, `append_file`, and `read_file` tools. File operations are gated by a path safety system — read and write access are controlled independently.

Sensitive actions also have a durable interrupt service underneath the agent
runtime. It persists pending action descriptors, validates decisions, expires
stale requests, and uses atomic claim/completion state so a committed action is
not replayed after reconnect or restart. File write/delete approvals are backed
by that layer now and re-check write permissions plus target file state before
execution. `db_execute` database-write approvals are also backed by that layer
and re-check statement classification plus connection writability before
execution. Pending file/database actions are listed through `/api/interrupts`
and reappear in the chat UI after reconnect so they can be approved, edited,
rejected, or answered without execution.

### File System Access

All file operations go through `lib/routes/paths.js`, which resolves and validates every path before it reaches the disk.

Two environment variables control what is accessible:

```env
# Allow read operations only inside these directories (comma-separated absolute paths)
APERIO_ALLOWED_PATHS_TO_READ=/Users/yourname/projects,/Users/yourname/documents

# Allow write operations only inside these directories (comma-separated absolute paths)
APERIO_ALLOWED_PATHS_TO_WRITE=/Users/yourname/projects
```

**How path resolution works:**

1. Both values default to the current working directory (`process.cwd()`) when not set — which is the Aperio project root when you run `npm run start:local`.
2. Paths are resolved to absolute form at startup. `~` is expanded to the working directory.
3. A request to read or write `/some/path/file.txt` is allowed only if its resolved absolute path starts with one of the permitted directories. Paths outside the allow-list are rejected with a clear error message before any I/O occurs.
4. Read and write guards are separate. You can grant broad read access while keeping write access narrow — for example, read your entire `~/projects` tree but only write inside the Aperio project root.

**What the model can and cannot do:**

| Operation | Guard | Default scope |
|-----------|-------|---------------|
| `read_file` | `APERIO_ALLOWED_PATHS_TO_READ` | Project root |
| `write_file` | `APERIO_ALLOWED_PATHS_TO_WRITE` | Project root |
| `append_file` | `APERIO_ALLOWED_PATHS_TO_WRITE` | Project root |
| `scan_project` | `APERIO_ALLOWED_PATHS_TO_READ` | Project root |

Additionally, `read_file` enforces:
- **Extension allow-list** — only code and text files (`.js`, `.ts`, `.py`, `.md`, `.json`, `.sql`, `.sh`, etc.)
- **Size cap** — files larger than 500 KB are rejected
- **Pagination** — reads at most 500 lines per call; use the `offset` parameter to page through larger files

### Shell Execution (`run_shell`)

By default the model can only execute `.js` files (the `run_node_script` tool). The optional `run_shell` tool widens this to a fixed allow-list of real binaries — used for QA steps that need them, such as pptx visual QA (`soffice` → `pdftoppm`) or grepping extracted text for leftover placeholders. It is **off by default** and gated by two environment variables.

> **⚠️ Trust level:** enabling `run_shell` grants the model **full host-level command execution as your user — it is not a sandbox.** The allow-list constrains *which* programs run and their arguments (no interpreter inline-eval like `node -e`/`python3 -c`, no `find -exec`, read-only `git`, file arguments confined to allowed paths, `curl` removed in favour of the SSRF-guarded `fetch_url`), but a determined model with shell access still operates with your privileges. Only enable it for models and content you trust.

```env
# Master switch — enables run_shell at all. When unset, the tool refuses every call.
APERIO_ENABLE_SHELL=1

# Opt-in for LOCAL llama.cpp models. Cloud providers (Anthropic/Gemini/DeepSeek/
# Claude Code/Codex) get
# run_shell as soon as the master switch is on; local models stay node-only unless
# you also set this, since smaller local models are prone to tool-call thrashing.
APERIO_SHELL_LOCAL=1
```

Constraints, enforced in `mcp/tools/shell.js`:

| Guard | Behavior |
|-------|----------|
| Allow-list | Only `node, npm, git, ls, cat, grep, rg, find, head, tail, python3, soffice, pdftoppm` run |
| Operators | `;`, `&&`, `\|\|`, `&`, `<`, `>`, backticks, `$()` are rejected; a single `\|` pipe is permitted |
| Working dir | Commands run in the active session workspace (or an explicit `cwd` within an allowed write path) |
| Limits | 60 s timeout, 200 KB output cap (shared with `run_node_script`) |
| Per-model gate | Disabled providers/models never see the tool at all (see `isShellAllowedFor` in `lib/agent/index.js`) |

### Database Encryption

Your memories, wiki, and agent knowledge live in a single SQLite database file. When `APERIO_DB_ENCRYPT=1`, that file is encrypted on disk with AES-256-GCM — **unreadable without the key.**

The encryption key is generated on your machine on first run and stored in your OS keychain: **macOS Keychain**, **Linux libsecret**, or **Windows DPAPI**. The key never touches disk — it's retrieved at startup and held only in memory.

**What this means for you:**
- **File theft is harmless.** If someone copies your database file, they get ciphertext — not your memories, not your wiki, not your settings.
- The plaintext database only exists in a temporary location while Aperio is running. It's re-encrypted on shutdown.
- **Zero-friction upgrade.** Existing plaintext databases are automatically migrated the first time you enable encryption — you don't lose anything.
- **Crash-safe.** If Aperio stops unexpectedly, the next startup recovers any writes from the leftover temp data.

**How to enable:**
```env
# APERIO_DB_ENCRYPT=1
```

> 💡 Check out [SECURITY.md](SECURITY.md) for the full threat model and platform details.

### Browser Launch

On startup Aperio opens the UI in a **private/incognito window**, falling back to your OS default browser if the chosen browser isn't installed. Pick one with `APERIO_BROWSER`:

```env
# firefox (default), firefox-dev, librewolf, mullvad, chrome, chromium, brave, edge, tor, ddg
# Use `default` (or `system`) to just open the OS default browser.
APERIO_BROWSER=firefox
```

For defense-in-depth, `APERIO_BROWSER_ISOLATED=1` launches that browser with a **dedicated profile** under `var/browser-profiles/<browser>`, keeping Aperio's cookies, storage, and extensions separate from your everyday browsing:

```env
APERIO_BROWSER_ISOLATED=1
```

> 💡 The browser sandbox already prevents any web page — even a compromised Aperio — from reading your bookmarks, history, or other tabs. Private mode + an isolated profile harden the surfaces that *do* matter: session state and extensions. `tor`/`ddg` are private-by-default apps launched best-effort, so profile isolation doesn't apply to them.

### Data Portability

Your memories and wiki are yours — take them with you. Two tools make migration and backup simple:

| Tool | What it does |
|------|-------------|
| `export_data` | Writes all memories + wiki articles to a portable JSON file. Defaults to `~/aperio-export-<timestamp>.json`. |
| `import_data` | Restores from an export file. Idempotent — memories match by ID, wiki articles by slug, so running it twice doesn't create duplicates. |

**Cross-machine migration:** export on your old machine, copy the JSON file to the new one, run `import_data`. Embeddings are queued for backfill automatically — semantic search works after `backfill_embeddings` completes. Works regardless of whether either machine has encryption enabled.

📄 Take a notes:
- Only run Aperio on a machine you trust
- Do not expose the MCP server or web UI to the public internet without authentication
- Review any file write operations before confirming them — `write_file` overwrites completely with no undo
- The AI model can be prompted (or hallucinate) to write to sensitive paths — always review before confirming
- Never commit your `.env` file — it contains your database URL and API keys
- Write paths should be equal to or a strict subset of read paths

#### Q: And this is it?
> 💡 Check out our wiki page [Path safety](https://github.com/BaiGanio/aperio/wiki/Path-Safety) for more details.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

<div align="center">

**One brain. Every agent. Nothing forgotten.**

*From Latin* aperire *— to open, to reveal, to bring into the light.*

</div>
