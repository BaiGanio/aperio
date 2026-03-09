---

<div align="center">

```
 █████╗ ██████╗ ███████╗██████╗ ██╗ ██████╗
██╔══██╗██╔══██╗██╔════╝██╔══██╗██║██╔═══██╗
███████║██████╔╝█████╗  ██████╔╝██║██║   ██║
██╔══██║██╔═══╝ ██╔══╝  ██╔══██╗██║██║   ██║
██║  ██║██║     ███████╗██║  ██║██║╚██████╔╝
╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝ ╚═════╝
```

**One brain. Every agent. Nothing forgotten.**

![Postgres](https://img.shields.io/badge/Postgres-16-336791?style=flat-square&logo=postgresql&logoColor=white)
![pgvector](https://img.shields.io/badge/pgvector-semantic_search-green?style=flat-square)
![Claude](https://img.shields.io/badge/Claude-Haiku-orange?style=flat-square)
![Ollama](https://img.shields.io/badge/Ollama-local_AI-black?style=flat-square)
![MCP](https://img.shields.io/badge/MCP-v1-blue?style=flat-square)
![Node](https://img.shields.io/badge/NodeJS-brightgreen?style=flat-square&logo=node.js)

</div>

---

## Why Aperio?

From Latin *aperire* — **to open, to reveal, to make known.**

The same root that gives us *aperture* — the opening in a lens that lets light through. In ancient Roman usage, *aperio* meant the act of uncovering something hidden, bringing it into the light, making the invisible visible.

That's exactly what this project does.

Your context — your preferences, your decisions, your project knowledge, your hard-won solutions — exists in your head but stays hidden from every AI tool you use. Each conversation starts in the dark. Every agent is blind to who you are.

**Aperio reveals it.**

It opens your accumulated knowledge to any AI agent that needs it — Claude, Cursor, Windsurf, anything MCP-compatible — automatically, silently, at the start of every conversation. One persistent brain. Every agent illuminated.

> *"Aperio"* — Latin, verb. To open. To reveal. To bring into the light.

---

## The Problem

Every AI conversation starts from zero. You re-explain your stack, your preferences, your project context — every single time. Claude knows nothing about you. Cursor knows nothing. Every agent is an amnesiac.

**Aperio fixes that.**

---

## What It Is

Aperio is a self-hosted personal memory layer that sits between you and any AI tool. It stores structured memories about you — facts, preferences, projects, decisions, solutions — and reveals them to Claude (or any MCP-compatible agent) automatically at the start of every conversation.

```
You ──→ Aperio Web UI ──→ Claude API (cloud)
              │         └─ Ollama    (local)
       MCP Server (11 tools)
              │
       Postgres + pgvector
       (your permanent brain)
```

Your brain lives in your database. Agents read it silently. You never re-explain yourself again.

---

## Architecture

```
Browser (localhost:3000)
    ↕  WebSocket (streaming)
Express Server (server.js)
    ↕  stdio
MCP Server (mcp/index.js)          11 tools
    ↕
Postgres 16 + pgvector             memories table
    ↕
Voyage AI                          embeddings API (free tier)
```

### Why this stack?

| Choice | Why |
|---|---|
| **Postgres** | Battle-tested, self-hosted, extensible |
| **pgvector** | Semantic search lives in the same DB — no separate vector store |
| **MCP** | Any MCP-compatible agent can connect to the same brain |
| **Voyage AI** | Best embedding quality, 50M free tokens, no SDK needed |
| **Node ESM** | Single runtime, single `node_modules`, clean imports |

---

## Features

### 🧠 Persistent Memory
Memories survive across every conversation, every tool, every session. 7 structured types keep things organized: `fact` `preference` `project` `decision` `solution` `source` `person`

### 🔍 Semantic Search
Powered by pgvector + Voyage AI embeddings. Ask for "my TypeScript projects" and get results by *meaning*, not just keyword matching. Full-text search as fallback.

### ⚡ Real-time Streaming
Responses stream token by token — no waiting for the full reply. Blinking cursor, live rendering, markdown processed on completion.

### 🎨 4 Themes
Light · Dark · Aurora (indigo-pink) · System. Persisted in localStorage. Syncs with your OS preference when set to System.

### 🧹 Auto-Deduplication
A background job runs every 10 minutes, finding near-duplicate memories using pgvector cosine similarity (97% threshold). Dry-run by default — you stay in control.

### 💬 Collapsible Sidebar
Memory categories start collapsed for a clean view. Search auto-expands matching groups. Sidebar itself toggles with a button or `⌘B`.

### 📤 Brain Export
One-click JSON export of all your memories. Discrete icon next to the memory count. Confirmation dialog before download.

### 🗑️ Delete Memories
Hover any memory card to reveal a trash icon. Confirmation before delete. No page reload needed.

### 📝 File Editing
Aperio can read, write, and append files directly on your filesystem. Ask it to scan a project, edit a file, or add to a document — it works on real files, not simulations.

---

## Project Structure

```
aperio/
├── docker/
│   └── docker-compose.yml        # pgvector/pgvector:pg16 image
├── db/
│   └── migrations/
│       ├── 001_init.sql          # Core schema, indexes, seed data
│       ├── 002_pgvector.sql      # pgvector extension + HNSW index
│       └── 003_drop_projects.sql # Simplified to one table
├── mcp/
│   └── index.js                  # MCP server — 11 tools, all memory + file ops
├── prompts/
│   └── system_prompt.md          # ← Claude's brain instructions (edit this!)
├── scripts/
│   └── chat.js                   # Terminal chat client
├── public/
│   └── index.html                # Full web UI — themes, streaming, sidebar
├── server.js                     # Express + WebSocket + streaming agent loop
├── package.json                  # Single dependency tree (no nested node_modules)
├── .env                          # Your keys — never commit this
└── .gitignore
```

---

## The System Prompt

`prompts/system_prompt.md` is the instruction set that makes Claude memory-aware. It tells Claude:

- **On start** — silently load memories via `recall`, use them naturally without announcing
- **During chat** — save immediately when user says "remember that…", suggest updates for stale memories
- **On end** — review the conversation and suggest memories worth keeping

**This file is yours to edit.** The default is a solid starting point but you can tune it — change how Claude phrases memory suggestions, adjust what it considers worth saving, or add domain-specific rules for your workflow.

```
prompts/system_prompt.md
    ↓ loaded at startup by server.js
    ↓ sent as system prompt on every API call
    ↓ Claude follows these rules in every conversation
```

> **Tip:** The most impactful edit is the memory suggestion rules at the bottom. Add your own types or tighten the criteria so Claude only suggests things that are genuinely useful to you.

---

## AI Providers

Aperio supports two providers — switch with a single line in `.env`. No code changes needed.

```env
AI_PROVIDER=anthropic   # default — Claude via Anthropic API
AI_PROVIDER=ollama      # local — runs on your machine, free
```

---

### ✦ Anthropic (Cloud)

The default. Best tool use support, most reliable memory operations.

```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

| Model | Best for | Cost |
|---|---|---|
| `claude-haiku-4-5-20251001` | Daily use, fast, cheap | ~$0.01/session |
| `claude-sonnet-4-6` | Complex reasoning, coding | ~$0.05/session |
| `claude-opus-4-6` | Deep research, nuanced decisions | ~$0.20/session |

> **Tip:** Start with Haiku. Switch to Sonnet when you need deeper reasoning. Opus is rarely needed — memory context does a lot of the heavy lifting.

---

### ⬡ Ollama (Local)

Run entirely on your machine. Free, private, no API key needed.

**1. Install Ollama**
```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows — download from ollama.com
```

**2. Pull a model**
```bash
ollama pull llama3.1        # recommended — best tool use support
ollama pull mistral         # good alternative, lighter
ollama pull qwen2.5         # fast and capable
```

**3. Switch provider in `.env`**
```env
AI_PROVIDER=ollama
OLLAMA_MODEL=llama3.1
OLLAMA_BASE_URL=http://localhost:11434
```

**4. Start Ollama and Aperio**
```bash
ollama serve   # in one terminal
npm start      # in another
```

| Model | RAM needed | Tool use |
|---|---|---|
| `llama3.1` (8B) | 8GB | ✅ Good |
| `llama3.1` (70B) | 48GB | ✅ Excellent |
| `mistral` (7B) | 8GB | ⚠️ Partial |
| `qwen2.5` (7B) | 8GB | ✅ Good |

> **Note:** Local models are improving fast but tool use (memory save/recall) works best with `llama3.1`. Smaller models may occasionally miss a tool call — Aperio handles this gracefully and falls back to a plain response.

---

### Switching providers

The active provider and model are shown in the UI status bar. To switch:

1. Change `AI_PROVIDER` in `.env`
2. Restart with `npm start`

That's it. Your memories, your MCP tools, your UI — everything else stays the same.

---

## Memory Schema

```sql
CREATE TABLE memories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT CHECK (type IN (
                'fact','preference','project',
                'decision','solution','source','person'
              )),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,         -- plain English, future-proof
  tags        TEXT[],                -- GIN indexed
  importance  INT DEFAULT 3,         -- 1 (low) → 5 (critical)
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  expires_at  TIMESTAMPTZ,           -- optional TTL
  source      TEXT DEFAULT 'manual', -- 'manual' | 'claude'
  embedding   vector(1024)           -- Voyage AI, HNSW indexed
);
```

One table. Everything lives here. Projects, decisions, people — all memories.

---

## MCP Tools (11)

| Tool | Description |
|---|---|
| `remember` | Save a memory + auto-generate embedding |
| `recall` | Semantic search with similarity scores, full-text fallback |
| `update_memory` | Edit by UUID, regenerates embedding if content changes |
| `forget` | Delete a memory by UUID |
| `backfill_embeddings` | Generate embeddings for memories that don't have one |
| `dedup_memories` | Find near-duplicates via cosine similarity, merge or report |
| `read_file` | Read any file from disk (max 500 lines, safe extensions only) |
| `write_file` | Overwrite a file on disk with new content |
| `append_file` | Add content to the end of a file without touching the rest |
| `scan_project` | Scan a folder tree, read key files, infer project context |
| `fetch_url` | Fetch a URL, strip HTML, truncate at 15k chars |

---

## Setup

### Prerequisites
- Node.js 18+
- Docker Desktop
- Anthropic API key
- Voyage AI API key (free at [dash.voyageai.com](https://dash.voyageai.com) — 50M tokens free)

### 1. Clone & install

```bash
git clone https://github.com/you/aperio
cd aperio
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

```env
DATABASE_URL=postgresql://aperio:aperio_secret@localhost:5432/aperio
ANTHROPIC_API_KEY=sk-ant-...
VOYAGE_API_KEY=pa-...
PORT=3000
```

### 3. Start the database

```bash
cd docker && docker compose up -d
cd ..   # return to project root — migrations must run from here
```

### 4. Run migrations

```bash
# Run from the project root (aperio/)
docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/001_init.sql
docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/002_pgvector.sql
```

### 5. Start Aperio

```bash
npm start              # uses AI_PROVIDER from .env (default: anthropic)
npm run start:cloud    # force Claude (Anthropic)
npm run start:local    # force Ollama (local) — runs on port 3001
```

Both instances can run simultaneously and share the same memory database.

### 6. Seed your brain

Tell Aperio what it should know about you:

- *"Remember that I'm building a SaaS in Next.js with Supabase"*
- *"Remember I prefer TypeScript over JavaScript always"*
- *"Scan my project at ~/projects/myapp"*

Or use the terminal client for a focused seeding session:

```bash
npm run chat          # uses .env provider
npm run chat:cloud    # force Claude
npm run chat:local    # force Ollama
```

---

## How Memory Works

### At conversation start
Aperio silently loads your memories via `recall` before the first response. The agent uses this context naturally — you'll never see "I found 12 memories". It just *knows*.

### During conversation
If you say **"remember that..."** → the agent saves it immediately.
If a memory becomes outdated → it notices and asks if you want to update it.

### At conversation end
The agent reviews what was discussed and suggests memories worth saving:

```
🧠 Memory suggestions — should I remember any of these?

1. [decision] Chose Fly.io over Railway — better pricing for always-on workloads
2. [solution] Fixed pgvector HNSW index by dropping and recreating after data load
3. [preference] Prefers streaming responses over batch for better UX

Reply with numbers to save, or "none".
```

### Memory types guide

| Type | Use for |
|---|---|
| `fact` | Stable truths about your setup, environment, situation |
| `preference` | How you like things done — code style, tools, workflows |
| `project` | Active codebases, research areas, side projects |
| `decision` | Choices made and why — invaluable for future reference |
| `solution` | Bugs fixed, problems solved — never debug the same thing twice |
| `source` | Papers, docs, repos, articles worth returning to |
| `person` | People you work with — roles, context, relationship |

---

## File Operations

Aperio can work directly with files on your filesystem via three tools:

```
scan_project ~/myapp     → understand the structure
read_file ~/myapp/server.js  → read a specific file
write_file               → overwrite with new content
append_file              → add to the end without touching existing content
```

Example workflows:

- *"Scan my aperio project and add a summary to the bottom of the README"*
- *"Read my server.js and fix the timeout on line 42"*
- *"Append my new API route to routes/index.js"*

`append_file` always reports before/after line counts so you can verify nothing was lost.

---

## Deduplication

Aperio runs a background dedup job every 10 minutes:

```
🧹 Dedup report:

Found 2 near-duplicate pair(s):

[98.3% similar]
  A: [fact] "Primary dev machine" (uuid-a)
  B: [fact] "My MacBook setup"   (uuid-b)
```

**Dry run by default** — it logs, never acts. To merge duplicates, tell Aperio:

```
run dedup with dry_run false
```

---

## Semantic Search

Memories are embedded using Voyage AI's `voyage-3` model (1024 dimensions) and stored in pgvector with an HNSW index. Aperio searches by meaning first, falls back to full-text if no vectors exist.

```
Query: "what database stuff have I worked on?"
  → Finds: "Fixed pgvector HNSW index bug"      [97.2%]
  → Finds: "Chose Postgres over MongoDB"         [94.8%]
  → Finds: "Aperio uses pg + pgvector"           [93.1%]
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `⌘ + Enter` | Send message |
| `⌘ + B` | Toggle sidebar |

---

## Themes

| Theme | Description |
|---|---|
| ☀️ Light | Warm off-white, clean minimal |
| 🌙 Dark | Deep charcoal, easy on the eyes |
| ✦ Aurora | Deep indigo with purple-pink gradients |
| ⊙ System | Follows your OS preference (default) |

---

## Cost

| Action | Cost |
|---|---|
| Normal conversation turn | ~$0.005 |
| Memory save + embedding | ~$0.001 |
| Dedup job (background) | $0.00 — pure SQL |
| Voyage AI embeddings | Free (50M tokens/month) |
| **Typical daily session** | **~$0.01–0.03** |

---

## Local AI with Ollama

Aperio runs fully local — no API keys, no cloud, no cost. Just install [Ollama](https://ollama.ai) and pull a model.

### Setup

```bash
# Install Ollama (ollama.ai) then pull a model
ollama pull llama3.1

# Start Aperio with local AI
npm run start:local
```

### Startup commands

| Command | Provider | Use when |
|---|---|---|
| `npm start` | whatever `.env` says | default |
| `npm run start:cloud` | Anthropic (Claude) | you want cloud regardless of `.env` |
| `npm run start:local` | Ollama (local) | you want local regardless of `.env` |
| `npm run chat:cloud` | Anthropic | terminal chat, cloud |
| `npm run chat:local` | Ollama | terminal chat, local |

### Recommended models

| Model | Size | Best for |
|---|---|---|
| `llama3.1` | 8B | Best tool-calling support — recommended |
| `qwen2.5` | 7B | Fast, capable, good reasoning |
| `mistral` | 7B | Good alternative, well-rounded |
| `gemma2` | 9B | Google's model, strong at coding |
| `phi3` | 3.8B | Ultra fast, lighter hardware |

Set any model name in `.env`:
```env
OLLAMA_MODEL=qwen2.5
```

### Cloud vs Local

| | Claude (cloud) | Ollama (local) |
|---|---|---|
| **Cost** | ~$0.01/session | Free |
| **Privacy** | Data leaves your machine | 100% local |
| **Tool calling** | Excellent | Good (model dependent) |
| **Speed** | Fast | Depends on hardware |
| **Best for** | Daily use, complex tasks | Privacy, offline, experimentation |

> **Tip:** The header badge shows which provider is active — `✦ haiku` for Claude, `⬡ llama3.1` for Ollama.

---

## Cursor / Windsurf Integration

Aperio's MCP server works with any MCP-compatible editor. Point your editor at the same `mcp/index.js` and it shares the exact same brain as the web UI.

**Cursor** — add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "aperio": {
      "command": "node",
      "args": ["/absolute/path/to/aperio/mcp/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://aperio:aperio_secret@localhost:5432/aperio",
        "VOYAGE_API_KEY": "pa-..."
      }
    }
  }
}
```

**Windsurf** — add to `~/.windsurf/mcp_config.json` with the same format.

Restart your editor. Aperio's 11 memory + file tools are now available to Cursor/Windsurf agent — same memories, same brain, different interface.

---

## What's Next

- **ngrok tunnel** — one command to access Aperio from any device remotely
- **Memory analytics** — a view showing your brain growing over time
- **Multi-user support** — separate memory spaces per user

---

## Philosophy

> *"The best memory system is one you forget about."*

Aperio is designed to be invisible. Claude loads your context silently. Memories save without interrupting your flow. The UI stays out of the way until you need it.

You should be thinking about your work — not about managing your AI's context window.

---

<div align="center">

Built with ☕ and pgvector.  
**One brain. Every agent. Nothing forgotten.**

*From Latin* aperire *— to open, to reveal, to bring into the light.*

</div>