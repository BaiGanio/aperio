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
![MCP](https://img.shields.io/badge/MCP-v1-blue?style=flat-square)
![Node](https://img.shields.io/badge/Node_Js-green?style=flat-square&logo=node.js)

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
You ──→ Aperio Web UI ──→ Claude API
              │
       MCP Server (9 tools)
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
MCP Server (mcp/index.js)          9 tools
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

---

## Project Structure

```
aperio/
├── docker/
│   └── docker-compose.yml        # pgvector/pgvector:pg16 image
├── db/
│   └── migrations/
│       ├── 001_init.sql          # Core schema, indexes, seed data
│       └── 002_pgvector.sql      # pgvector extension + HNSW index
├── mcp/
│   └── index.js                  # MCP server — 9 tools, all memory ops
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

## Model Configuration

Aperio ships with Haiku — fast and cheap for daily use. Switch models in `server.js` by uncommenting one line:

```js
// ─── Model config ─────────────────────────────────────────
// const MODEL = "claude-opus-4-6";        // Most capable — higher cost
// const MODEL = "claude-sonnet-4-6";      // Balanced — recommended for power users
const MODEL = "claude-haiku-4-5-20251001"; // Fast + cheap — default ✓
```

### Which model should I use?

| Model | Best for | Cost |
|---|---|---|
| **Haiku** | Daily use, quick questions, memory ops | ~$0.01/session |
| **Sonnet** | Complex reasoning, long documents, coding | ~$0.05/session |
| **Opus** | Deep research, nuanced decisions | ~$0.20/session |

> **Tip:** Start with Haiku. Switch to Sonnet when you notice it missing context or giving shallow answers. Opus is rarely needed for memory-backed conversations since the context does a lot of the heavy lifting.

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

## MCP Tools (9)

| Tool | Description |
|---|---|
| `remember` | Save a memory + auto-generate embedding |
| `recall` | Semantic search with similarity scores, full-text fallback |
| `update_memory` | Edit by UUID, regenerates embedding if content changes |
| `forget` | Delete a memory by UUID |
| `backfill_embeddings` | Generate embeddings for memories that don't have one |
| `dedup_memories` | Find near-duplicates via cosine similarity, merge or report |
| `read_file` | Read any file from disk (max 500 lines, safe extensions only) |
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
```

### 4. Run migrations
Go back to root
```bash
# Core schema
docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/001_init.sql

# pgvector (semantic search)
docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/002_pgvector.sql
```

### 5. Start Aperio

```bash
lsof -ti :3000 | xargs kill -9
npm start
# → http://localhost:3000
```

### 6. Seed your brain

Tell Claude what it should know about you:

- *"Remember that I'm building a SaaS in Next.js with Supabase"*
- *"Remember I prefer TypeScript over JavaScript always"*
- *"Scan my project at ~/projects/myapp"*

Or use the terminal client for a focused seeding session:

```bash
npm run chat
```

---

## How Memory Works

### At conversation start
Claude silently calls `recall` to load your core context. It uses this naturally without announcing it. You'll never see "I found 12 memories" — Claude just *knows*.

### During conversation
If you say **"remember that..."** → Claude saves it immediately.
If a memory becomes outdated → Claude notices and asks if you want to update it.

### At conversation end
Claude reviews what was discussed and suggests memories worth saving:

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

## Deduplication

Aperio runs a background dedup job every 10 minutes:

```
🧹 Dedup report:

Found 2 near-duplicate pair(s):

[98.3% similar]
  A: [fact] "Primary dev machine" (uuid-a)
  B: [fact] "My MacBook setup"   (uuid-b)
```

**Dry run by default** — it logs, never acts. To merge duplicates, tell Claude:

```
run dedup with dry_run false
```

---

## Semantic Search

Memories are embedded using Voyage AI's `voyage-3` model (1024 dimensions) and stored in pgvector with an HNSW index. Claude searches by meaning first, falls back to full-text if no vectors exist.

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

## What's Next

- **Cursor / Windsurf integration** — point your editor's MCP config at `mcp/index.js` and share the same brain across tools
- **ngrok tunnel** — one command to access Aperio from any device
- **Memory analytics** — a view showing your brain growing over time

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
