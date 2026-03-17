<a id="top"></a>
<!-- HEADER --> 
<p align="center">
  · · ·
  [ <a href="#philosophy">Philosophy</a> ] 
  · · ·
  [ <a href="#architecture">Architecture</a> ] 
  · · ·
  [ <a href="#getting-started">Getting Started</a> ]  
  · · ·
  [ <a href="#features">Features</a> ]  
  · · ·
  <br>
  <br>
  · · ·
  [ <a href="#ai-providers">AI Providers</a> ]
   · · ·
  [ <a href="#commands">Commands</a> ]
  · · ·
  [ <a href="#mcp-tools-11">MCP Tools</a> ]  
  · · ·
  [ <a href="#how-to-use">How to Use?</a> ]
  · · ·
  [ <a href="#privacy">Privacy</a> ]  
  · · ·
  [ <a href="#security-notes">Security Notes</a> ]  
  · · ·
  <br>
  <br>
  · · · 
   [ <a href="#build-on-top">Build On Top</a> ] 
  · · ·
  [ <a href="https://github.com/BaiGanio/aperio/issues/3">Early Testing Contributors Note</a> ]
   · · ·
   [ <a href="#troubleshooting">Troubleshooting</a> ]
   · · ·
</p>

---

<div align="center">
<h1>✨ Aperio</h1>

**One brain. Every agent. Nothing forgotten.**

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)
![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-16-336791?style=flat-square&logo=postgresql&logoColor=white)
![pgvector](https://img.shields.io/badge/pgvector-semantic_search-green?style=flat-square)
![Ollama](https://img.shields.io/badge/Ollama-local_AI-black?style=flat-square)
![MCP](https://img.shields.io/badge/MCP-v1-blue?style=flat-square)
![Claude](https://img.shields.io/badge/Claude-Haiku-orange?style=flat-square)
![GitHub contributors](https://img.shields.io/github/contributors/baiganio/aperio)

A self-hosted personal memory layer for AI agents.  
Postgres + pgvector + MCP. Your context, always available.

🌐 **[aperio.dev](https://baiganio.github.io/aperio)** 
</div>

---

## 🏗️ Project Structure
```txt
📂 aperio/          <---=  You are here 
├── 📂 docker/
│   └── docker-compose.yml        # pgvector/pgvector:pg16
├── 📂 db/
│   └── 📂 migrations/            # 001_init · 002_pgvector
├── 📂 mcp/
│   └── index.js                  # MCP server — 11 tools
├── 📂 prompts/
│   └── system_prompt.md          # ← AI agents instructions (edit this!)
├── 📂 scripts/
│   └── chat.js                   # Terminal chat client
├── 📂 public/
│   └── index.html                # Web UI — themes, streaming, sidebar
├── server.js                     # Express + WebSocket + agent loop
├── package.json
└── .env                          # Your keys — never commit this
```

> **💡 Tip:** `prompts/system_prompt.md` controls how AI agents handles memories. It's the most impactful file to customize.

---

## Philosophy

Aperio is open source and self-hosted because **your memory is yours.**

It runs entirely on your machine by default — no API keys, no data leaving your network, no cloud dependency. We believe the default should always be private. Cloud AI (Claude, Voyage AI) is available as a power upgrade for heavy lifting — but you should never be forced to use it.

| | |
|---|---|
| 🔒 **Local by default** | Ollama + local embeddings — zero external calls |
| ☁️ **Cloud as upgrade** | Claude + Voyage AI for deep research & heavy tasks |
| 🧠 **Your brain, your data** | Postgres lives on your machine. You own it. |
| 🔌 **MCP-native** | Any MCP-compatible agent plugs in — Cursor, Windsurf, etc. |
| 🆓 **Free to run** | No subscription. No per-message cost. Just your hardware. |

### What Aperio is NOT

- ❌ **Not a cloud service** — there is no hosted version, no SaaS, no managed infrastructure
- ❌ **Not a managed product** — no support contracts, no SLAs, no guaranteed uptime
- ❌ **Not a plugin or extension** — it's a self-hosted server you run yourself
- ❌ **Not a replacement for your AI tool** — it's a memory layer that sits alongside Claude, Cursor, Windsurf etc.
- ❌ **Not plug-and-play for non-developers** — you need Node.js, Docker, and basic terminal comfort
- ❌ **Not production-hardened** — it's early software, built in the open, improving fast

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Architecture
```
Browser (localhost:3001 local / 3000 cloud)
    ↕  WebSocket (streaming)
Express Server (server.js)
    ↕  stdio
MCP Server (mcp/index.js)       — 11 tools
    ↕
Postgres 16 + pgvector          — your permanent brain
    ↕
Ollama (default)                — local AI + local embeddings
Anthropic + Voyage AI           — optional cloud upgrade
```

| Component | Why |
|---|---|
| **Postgres + pgvector** | Battle-tested, self-hosted, semantic search built in |
| **Ollama** | Local LLM inference — llama3.1, qwen3, deepseek-r1 and more |
| **mxbai-embed-large** | Local embeddings via Ollama — no external calls |
| **MCP** | Any MCP-compatible agent shares the same brain |
| **Node ESM** | Single runtime, clean imports, no build step |
| **Claude** *(optional)* | Anthropic API for complex reasoning tasks |
| **Voyage AI** *(optional)* | Highest embedding quality for power users |

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Getting Started 

The fastest path. Runs 100% on your machine. No API Keys.

### 1. Prerequisites
- Node.js 18+
- Docker Desktop
- [Ollama](https://ollama.ai)
- [Anthropic API key](https://console.anthropic.com) — (optional) or Ollama for local AI
- [Voyage AI API key](https://dash.voyageai.com) — (optional) free, 50M tokens/month or `nomic-embed-text` for local embeddings

### 2. Clone & install
```bash
git clone https://github.com/BaiGanio/aperio
cd aperio
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
```

Minimum `.env` for a fully local setup:
```env
DATABASE_URL=postgresql://aperio:aperio_secret@localhost:5432/aperio
AI_PROVIDER=ollama
OLLAMA_MODEL=llama3.1
EMBEDDING_PROVIDER=ollama
OLLAMA_EMBED_MODEL=mxbai-embed-large
```

### 4. Pull Ollama models
```bash
ollama pull llama3.1           # LLM — best tool-calling support
ollama pull mxbai-embed-large   # embeddings — local semantic search
```

### 5. Start the database
```bash
cd docker && docker compose up -d && cd ..
```

### 6. Run migrations
- MacOS/Linux
```bash
docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/001_init.sql
docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/002_pgvector.sql
```
- Windows
```powershell
cmd /c "docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/001_init.sql"
cmd /c "docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/002_pgvector.sql"
```

### 7. Start Aperio
```bash
ollama serve            # terminal 1
npm run start:local     # terminal 2  →  localhost:3000
```

### 8. Backfill embeddings (first run only)
Once Aperio is running, open the chat and type:

```text
backfill my embeddings
```

This generates semantic vectors for all your memories. Without this step, search falls back to full-text only. You only need to do this once — new memories are embedded automatically.

### 9. Seed your brain

Tell Aperio what it should know about you:

```
Remember that I prefer TypeScript over JavaScript
Remember I'm building a SaaS with Next.js and Supabase
Scan my project at ~/projects/myapp
```


That's it. No API keys. No cloud. Full semantic memory on your machine.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Features

### 🧠 Persistent Memory
7 structured types survive every conversation, every tool, every session:
`fact` `preference` `project` `decision` `solution` `source` `person`

### 🔍 Semantic Search
Powered by pgvector + embeddings. Ask for *"my TypeScript projects"* and get results by meaning, not keywords. Full-text search as fallback when no embeddings exist.

### ⚡ Real-time Streaming
Responses stream live. Reasoning models (`qwen3`, `deepseek-r1`) show a collapsible thinking bubble — toggle it on/off in the header.

### 🎨 4 Themes
Light · Dark · Aurora (indigo-pink) · System. Persisted in localStorage.

### 🧹 Auto-Deduplication
Background job every 10 minutes finds near-duplicate memories via cosine similarity (97% threshold). Dry-run by default.

### 📤 Brain Export
One-click JSON export of all your memories. Confirmation before download.

### 🗑️ Delete Memories
Hover any memory card to reveal a trash icon. No page reload needed.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## AI Providers

Switch with a single line in `.env`. Everything else — memories, tools, UI — stays identical.

### ⬡ Ollama (Default — Local, Free, Private)
```env
AI_PROVIDER=ollama
OLLAMA_MODEL=llama3.1
```

| Model | RAM | Notes |
|---|---|---|
| `llama3.1` (8B) | 8 GB | Best tool-calling — recommended default |
| `llama3.1` (70B) | 48 GB | Excellent — for high-end machines |
| `qwen3` | 8 GB | Strong reasoning, thinking mode support |
| `deepseek-r1:14b` | 16 GB | Deep reasoning with visible thought process |
| `mistral` (7B) | 8 GB | Lightweight alternative |
| `phi3` (3.8B) | 6 GB | Ultra-fast, minimal hardware |

> **💡 Tip:** Start with `llama3.1`. Upgrade to `qwen3` or `deepseek-r1` when you want reasoning transparency.

### ✦ Anthropic Claude (Optional — Cloud Upgrade)

For heavy research, complex multi-step reasoning, or the strongest tool-calling available.
```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

| Model | Cost | Best for |
|---|---|---|
| `claude-haiku-4-5-20251001` | ~$0.01/session | Fast, cheap, daily use |
| `claude-sonnet-4-6` | ~$0.05/session | Complex coding & research |
| `claude-opus-4-6` | ~$0.20/session | Maximum capability, deep work |

### Embeddings
```env
# Local (default) - comment both lines if choose of Voyage AI
EMBEDDING_PROVIDER=ollama
OLLAMA_EMBED_MODEL=mxbai-embed-large

# Cloud upgrade
VOYAGE_API_KEY=pa-...
```

| Provider | Details |
|---|---|
| **Ollama** *(default)* | `mxbai-embed-large` — zero external calls, 1024 dims |
| **Voyage AI** *(optional)* | `voyage-3` — 1024 dims, highest quality, 50M free tokens/month |

### Local vs Cloud

| | ⬡ Ollama (Local) | ✦ Claude (Cloud) |
|---|---|---|
| **Cost** | Free | ~$0.01–0.20/session |
| **Privacy** | 100% local | Data sent to Anthropic |
| **Tool calling** | Good (model dependent) | Excellent |
| **Reasoning** | qwen3 / deepseek thinking mode | Claude Sonnet / Opus |
| **Speed** | Depends on hardware | Fast |
| **Offline** | ✅ Yes | ❌ No |
| **Best for** | Daily use, privacy, experiments | Heavy research, complex agents |


### Model selection guide

| Model | Best for | Avoid |
|---|---|---|
| `llama3.1` | Quick questions, tool calling, short answers | Long documents, reasoning, code generation |
| `qwen2.5` | Code generation, structured output, markdown | Deep reasoning, complex multi-step tasks |
| `qwen3` | Everything — reasoning + tools + code + docs | Nothing major, just slower than llama3.1 |
| `deepseek-r1:7b` | Reasoning, analysis, debugging, decisions | Document generation, long code blocks |
| `deepseek-r1:14b` | Complex reasoning, architecture decisions | Same limitations, needs 16GB RAM |

#### Examples

- **"Remember that I prefer tabs"** → `llama3.1` or `qwen3`
- **"Give me a C# hello world"** → `qwen2.5` or `qwen3`
- **"What are the tradeoffs between Postgres and MongoDB?"** → `deepseek-r1` or `qwen3`
- **"Output this file as copy-paste markdown"** → `qwen3` only
- **"Scan my project and summarize it"** → `qwen3` or `llama3.1`
- **"Why is my pgvector query slow?"** → `deepseek-r1:14b` or `qwen3`

> **TL;DR:** Use `qwen3` as your daily driver. Switch to `deepseek-r1:14b` for deep reasoning. `llama3.1` for fast responses when reasoning isn't needed.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Commands

| Command | Provider | Port |
|---|---|---|
| `npm start` | whatever `.env` says | 3000 |
| `npm run start:cloud` | Anthropic (Claude) | 3000 |
| `npm run start:local` | Ollama | 3001 |
| `npm run chat:cloud` | Anthropic — terminal only | — |
| `npm run chat:local` | Ollama — terminal only | — |

> **💡 Tip:** Both instances can run simultaneously and share the same memory database.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## MCP Tools (11)

The same tools are available to the chat UI, Cursor, Windsurf, or any MCP-compatible agent.

| Tool | Description |
|---|---|
| `remember` | Save a memory + auto-generate embedding |
| `recall` | Semantic search with similarity scores, full-text fallback |
| `update_memory` | Edit by UUID — regenerates embedding if content changes |
| `forget` | Delete by UUID |
| `backfill_embeddings` | Generate embeddings for memories that don't have one |
| `dedup_memories` | Find near-duplicates via cosine similarity — merge or report |
| `read_file` | Read any file from disk (max 500 lines, safe extensions only) |
| `scan_project` | Scan a folder tree, read key files, infer project context |
| `fetch_url` | Fetch a URL, strip HTML, truncate at 15k chars |
| `get_stats` | Memory count, type distribution, embedding coverage |
| `search_by_tag` | Filter memories by one or more tags |

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## How to Use?
### 🛠️ Aperio MCP Tools Guide
Aperio exposes 11 tools for memory management, file operations, and web fetching.
Just type naturally in the chat — no commands, no syntax to remember.

#### `remember` — Save a memory

Saves structured context about you — facts, decisions, preferences, projects, people, solutions, sources.
```
Remember that I'm building a SaaS called Launchpad using Next.js, Supabase, and Stripe
```
```
Remember that I prefer tabs over spaces and always use TypeScript strict mode
```
```
Remember that I decided to use Fly.io over Railway — better pricing for always-on workloads
```

#### `recall` — Search memories

Searches your memory by meaning. Called automatically on every startup — you rarely need to trigger this manually.
```
What do you know about my projects?
```
```
What stack am I using for Launchpad?
```
```
Do you remember any infrastructure decisions I made?
```

#### `update_memory` — Update an existing memory

Use when something has changed and a memory is outdated.
```
Update my Launchpad memory — we switched from Supabase to PlanetScale
```
```
The Fly.io memory is wrong — update it, we moved to Railway after all
```
```
Update my name memory, I go by Lyu not Lyuben
```

#### `forget` — Delete a memory

Deletes a memory permanently. You can also use the trash icon in the sidebar.
```
Forget everything about the old Stripe integration
```
```
Delete the memory about project Alpha — it's cancelled
```
```
Remove the memory about John from accounting
```

#### `backfill_embeddings` — Generate missing embeddings

Run this once after first setup or if semantic search isn't returning relevant results.
```
Backfill embeddings for all my memories
```
```
Run backfill — semantic search isn't finding things correctly
```

#### `dedup_memories` — Find and remove duplicates

Finds near-duplicate memories using cosine similarity. Dry run by default — safe to run anytime.
```
Run dedup and show me what duplicates exist
```
```
Check for duplicate memories — dry run only
```
```
Run dedup with dry_run false and merge the duplicates
```

### 📁 File Tools

#### `read_file` — Read a file from disk

Reads any file up to 500 lines. Use absolute paths.
```
Read ~/Projects/launchpad/README.md
```
```
Read /Users/lk/Projects/aperio/mcp/index.js and explain what it does
```
```
Read ~/Projects/myapp/.env.example
```

#### `scan_project` — Scan a project folder

Scans a directory tree, reads key files, and infers project context. Great for onboarding Aperio to a new codebase.
```
Scan my project at ~/Projects/launchpad and remember the stack
```
```
Scan ~/Projects/aperio and save a memory about the architecture
```
```
Scan ~/Projects/myapp — what tech stack is it using?
```

#### `write_file` — Write to a file

Writes content to a file on disk. Always asks for confirmation before writing.
```
Write a basic .gitignore for a Node.js project to ~/Projects/launchpad/.gitignore
```
```
Save this SQL migration to ~/Projects/myapp/db/migrations/004_add_tags.sql
```
```
Write the updated README content to ~/Projects/aperio/README.md
```

### 🌐 Web Tools

#### `fetch_url` — Fetch a webpage

Fetches a URL, strips HTML, and returns clean text. Useful for summarizing docs, articles, or repos.
```
Fetch https://docs.supabase.com/guides/auth and summarize the auth options
```
```
Fetch https://github.com/BaiGanio/aperio and tell me what the project does
```
```
Fetch https://fly.io/docs/pricing and compare their plans
```

### 💡 Tips

- **Be explicit when saving** — say "remember that..." or "save this as a memory" to trigger `remember` immediately
- **Semantic search is powerful** — ask about topics, not exact titles. "my database decisions" finds more than "postgres"
- **Scan before you ask** — run `scan_project` on a new codebase before asking questions about it
- **Dedup regularly** — run `dedup_memories` after a few sessions to keep your brain clean
- **Embeddings matter** — if recall feels off, run `backfill_embeddings` to fix semantic search -AZ

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Privacy

### Reading Files with Local AI

Ollama itself has no file system access — it's purely an inference engine.
Aperio's MCP layer bridges the gap.

When you ask the AI to read a file, here's what actually happens:
```
You       →  "read /path/to/server.js and explain the WebSocket handler"
MCP Server →  calls read_file tool, loads the file from disk
Ollama    →  receives the file contents as context, reasons over it
You       ←  answer based on your actual code
```

The model never touches your file system directly.
Aperio reads the file and injects the content into the conversation.

#### Available file tools

| Tool | What it does |
|---|---|
| `read_file` | Read any file from disk (max 500 lines by default) |
| `write_file` | Overwrite a file completely |
| `append_file` | Add content to the end of a file |
| `scan_project` | Scan a folder tree up to 3 levels deep |

#### Raising the line limit

The default cap is 500 lines. To increase it, find this in `mcp/index.js`:
```js
const MAX_LINES = 500;
```

> **NOTE**: If you ask it to read a large file it'll truncate. For big files you'd either need to raise that limit or use `scan_project` first to find the right file, then `read_file` on the specific section you need.

Change it to whatever your use case needs.

#### Example prompts that just work

- *"Read my server.js and tell me what the WebSocket handler does"*
- *"Scan my project and give me an overview of the structure"*
- *"Read my .env.example and tell me which variables I still need to fill in"*
- *"Append a TODO comment to the bottom of mcp/index.js"*

### Embeddings

#### What an embedding actually is

An embedding converts your text into a list of numbers that represent its meaning:

```text
"I chose Postgres because of pgvector" → [0.023, -0.847, 0.331, ... ×768]
```

Two semantically similar sentences produce vectors that are mathematically close — that's how `recall` finds the right memory even when you phrase the question differently.

#### Aperio is fully air-gapped — zero data leaves your machine

Complete privacy with no external API calls at all - thanks to the local embedding model:

`mxbai-embed-large` runs fully locally, produces 1024-dimensional vectors, works natively with pgvector, and generates embeddings in ~15–50ms. No API key. No data leaving your machine. Ever.

#### What leaves your machine if choose Voyage AI

If Aperio uses **Voyage AI** to generate embeddings, here's exactly what happens:

```
You save a memory 
  → text is sent to Voyage AI API
  → Voyage returns a vector (1024 numbers)
  → vector + original text stored in YOUR Postgres
  → nothing else ever leaves your machine
```

**What Voyage AI receives:** only the raw text of the memory being saved.

**What Voyage AI never receives:**
- Your conversations with the AI
- Your other memories
- Any personal files or system information

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Security Notes
Aperio runs on your machine and has access to your file system through the `write_file`, `append_file`, and `read_file` tools. By default, file operations are restricted to the directory where the process was started from — which will be the Aperio project root when you run `npm run start:local`.

**File system access**
The `write_file`, `append_file`, and `read_file` tools can access any absolute path on your machine that the Node.js process has permission to read or write. This is intentional for power users but means:

- Only run Aperio on a machine you trust
- Do not expose the MCP server or web UI to the public internet without authentication
- Review any file write operations before confirming them — `write_file` overwrites completely with no undo
- The AI model can be prompted (or hallucinate) to write to sensitive paths — always review before confirming
- Never commit your `.env` file — it contains your database URL and API keys

If you know what you are doing - search with `Warning: Path safety` in `mpc/index.js` and swap the lines.

**Restrict file access further** by setting `APERIO_ALLOWED_PATHS` in your `.env`:
```env
# Allow only specific directories (comma-separated)
APERIO_ALLOWED_PATHS=/Users/yourname/projects,/Users/yourname/documents
```

If a model attempts to write outside the allowed paths, the operation is blocked and an error is returned.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Build On Top

Aperio is a foundation. The source is fully open — fork it and extend it:

- **Custom memory types** — add columns, new types, per-project namespacing
- **New MCP tools** — calendar, email, git, deploy — one function per tool
- **Swap embeddings** — OpenAI, Cohere, local `nomic-embed` via Ollama
- **Replace the UI** — VS Code extension, Raycast plugin, mobile app, CLI
- **Memory analytics** — query your own brain, visualize growth over time
- **Multi-agent sharing** — research agent, coding agent, writing agent — one brain

### 🏢 Team Shared Memory — Extend Aperio for Your Team

Aperio is personal by default — but since **you own the database**, it can become a shared team brain with minimal changes.

Every agent, every teammate, every tool — all drawing from the same memory pool.

#### The idea

Right now Aperio stores *your* context. But the same architecture works for a team:

- Shared decisions — *"We chose Fly.io over Railway in Q3 2024 because..."*
- Project knowledge — *"Project Atlas uses Next.js, PlanetScale, and Stripe. PM is Sara."*
- People context — *"John handles DevOps, prefers async communication, timezone UTC+2"*
- Onboarding — *"New devs should read X, set up Y, ask Z about access"*
- Runbooks — *"When the DB goes down: check pgvector index first, then..."*

Any agent connected to the MCP server reads all of this automatically.

#### How to set it up

**1. Update `prompts/system_prompt.md`**

Change the identity line to reflect a team context:
```
You are a helpful team assistant with access to Aperio — a shared memory system
that stores context about your team, projects, and decisions across conversations.
```

**2. Seed team memories in `db/migrations/001_init.sql`**

Add your team's baseline context as seed data:
```sql
INSERT INTO memories (type, title, content, tags, importance, source) VALUES
  ('project', 'Project Atlas', 'Next.js frontend, PlanetScale DB, Stripe payments. Repo: github.com/team/atlas. PM: Sara. Lead dev: John.', ARRAY['atlas','nextjs','stripe'], 5, 'manual'),
  ('project', 'Project Beacon', 'Internal analytics dashboard. React + FastAPI + ClickHouse. Owned by data team.', ARRAY['beacon','analytics','clickhouse'], 4, 'manual'),
  ('person', 'Sara — Product Manager', 'PM for Atlas and Beacon. Handles roadmap, stakeholder comms. Prefers Slack over email.', ARRAY['sara','pm','atlas'], 4, 'manual'),
  ('person', 'John — DevOps Lead', 'Manages infra on Fly.io. Primary contact for deployment issues. UTC+2.', ARRAY['john','devops','infra'], 4, 'manual'),
  ('decision', 'Chose Fly.io over Railway', 'Decided Q3 2024. Better pricing for always-on workloads, easier multi-region. Revisit if team grows past 10.', ARRAY['infra','flyio','railway'], 5, 'manual'),
  ('fact', 'Stack conventions', 'TypeScript everywhere. Tabs not spaces. All PRs require one review. Deploys on merge to main.', ARRAY['conventions','typescript','git'], 5, 'manual'),
  ('solution', 'pgvector HNSW index fix', 'Drop and recreate index after bulk insert. Run: DROP INDEX memories_embedding_idx; then recreate.', ARRAY['postgres','pgvector','fix'], 4, 'manual');
```

**3. Connect your team to the same MCP server**

Point everyone's Cursor / Windsurf / Claude at the same `mcp/index.js`:
```json
{
  "mcpServers": {
    "aperio-team": {
      "command": "node",
      "args": ["/shared/path/to/aperio/mcp/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://aperio:secret@your-db-host:5432/aperio"
      }
    }
  }
}
```

Everyone reads and writes to the same brain.

#### What this unlocks

| Use case | Example |
|---|---|
| **Onboarding** | *"What do I need to know to start contributing to Atlas?"* |
| **Project context** | *"What's the current stack for Beacon?"* |
| **Decision history** | *"Why did we choose Fly.io?"* |
| **People finder** | *"Who owns the analytics pipeline?"* |
| **Runbooks** | *"What do we do when the DB goes down?"* |
| **Cross-project search** | *"Which projects use Stripe?"* |

#### What's coming

- **Per-user memory spaces** — personal context alongside shared team context
- **Memory ownership** — tag memories by who created them
- **Access control** — read-only vs read-write roles
- **Audit log** — see who saved or changed what and when

> **💡 Tip:** The database is yours. The memory is yours. Scale it however you need.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Troubleshooting

**Semantic search not working / full-text fallback**
- Run `backfill my embeddings` in the chat after first launch
- Check that your embedding model is pulled: `ollama pull mxbai-embed-large`
- Verify `.env` has: `OLLAMA_EMBEDDING_MODEL=mxbai-embed-large`
- At startup you should see: `✅ pgvector enabled — semantic search active (X/Y memories embedded)`
- If you see `⚠️ no embeddings yet` — run backfill

**Embeddings dimension mismatch**
- `nomic-embed-text` → 768 dims — incompatible with default `vector(1024)` schema
- `mxbai-embed-large` → 1024 dims — use this for local embeddings
- Voyage AI → 1024 dims — compatible out of the box

### Port already in use
```bash
# Kill whatever is running on the port
lsof -ti:3001 | xargs kill -9   # local
lsof -ti:3000 | xargs kill -9   # cloud
```
Or change the port in `.env`:
```env
PORT=3002
```

### Ollama not running
```
Error: Ollama is not running at http://localhost:11434
```
Fix:
```bash
ollama serve          # start Ollama
ollama pull llama3.1  # make sure your model is pulled
```

### pgvector extension missing
```
⚠️  pgvector not found — using full-text search only
```
Fix — the Docker image includes pgvector by default. If you're using a custom Postgres instance:
```bash
# Inside your Postgres container
CREATE EXTENSION IF NOT EXISTS vector;
```
Or restart with the correct image:
```bash
cd docker && docker compose down && docker compose up -d
```

### Database connection failed
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```
Fix:
```bash
cd docker && docker compose up -d
# Wait a few seconds, then retry
```

### MCP server not connecting
```
Error: spawn node ENOENT
```
Fix — Node.js is not in PATH or not installed:
```bash
node --version  # should be 18+
```

### What a healthy startup looks like
```
🤖 Provider: Ollama (qwen3) @ http://localhost:11434
✅ Connected to Aperio database
✅ pgvector enabled — semantic search active (12/12 memories embedded)
🧠 Aperio MCP server v2.0 running
✅ MCP server connected
✦ Aperio running at http://localhost:3001
```
If all five lines appear — you're good.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

<div align="center">

Built with ☕ and pgvector  
**One brain. Every agent. Nothing forgotten.**

*From Latin* aperire *— to open, to reveal, to bring into the light.*

</div>
