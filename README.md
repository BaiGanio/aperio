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

A self-hosted personal memory layer for AI agents.  
Postgres + pgvector + MCP. Your context, always available.

🌐 **[aperio.dev](https://baiganio.github.io/aperio)** 
</div>

---

## Setup

### Prerequisites

- Node.js 18+
- Docker Desktop
- Ollama (free)
- [Anthropic API key](https://console.anthropic.com) — (optional) or Ollama for local AI
- [Voyage AI API key](https://dash.voyageai.com) — (optional) free, 50M tokens/month or `nomic-embed-text` for local embeddings
---

## Project Structure

```txt
aperio/
├── docker/
│   └── docker-compose.yml        # pgvector/pgvector:pg16
├── db/
│   └── migrations/               # 001_init · 002_pgvector
├── mcp/
│   └── index.js                  # MCP server — 11 tools
├── prompts/
│   └── system_prompt.md          # ← AI agents instructions (edit this!)
├── scripts/
│   └── chat.js                   # Terminal chat client
├── public/
│   └── index.html                # Web UI — themes, streaming, sidebar
├── server.js                     # Express + WebSocket + agent loop
├── package.json
└── .env                          # Your keys — never commit this
```

> **Tip:** `prompts/system_prompt.md` controls how AI agents handles memories. It's the most impactful file to customize.
---

### 1. Clone & install

```bash
git clone https://github.com/BaiGanio/aperio
cd aperio
npm install
```

---

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your keys:

```env
DATABASE_URL=postgresql://aperio:aperio_secret@localhost:5432/aperio

AI_PROVIDER=anthropic          # "anthropic" | "ollama"
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

VOYAGE_API_KEY=pa-...

PORT=3000
```

---

### 3. Start the database

```bash
cd docker && docker compose up -d
cd ..
```

---

### 4. Run migrations

```bash
docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/001_init.sql
docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/002_pgvector.sql
```

---

### 5. Start Aperio

```bash
npm run start:cloud    # Claude via Anthropic API  →  localhost:3000
npm run start:local    # Ollama (local, free)       →  localhost:3001
```

Both can run at the same time and share the same memory database.

Open your browser → `http://localhost:3000`

---

### 6. Seed your brain

Tell Aperio what it should know about you:

```
Remember that I prefer TypeScript over JavaScript
Remember I'm building a SaaS with Next.js and Supabase
Scan my project at ~/projects/myapp
```

---

## Local AI (Ollama)

No API key needed. Runs entirely on your machine.

```bash
# 1. Install Ollama
brew install ollama          # macOS
# or: curl -fsSL https://ollama.com/install.sh | sh  (Linux)

# 2. Pull a model
ollama pull llama3.1         # recommended — best tool-calling support
ollama pull deepseek-r1:14b  # supports native thinking tokens (14b fits perfectly in MacBook M1 Pro 32GB)

# 3. Switch provider in .env
AI_PROVIDER=ollama
OLLAMA_MODEL=llama3.1
OLLAMA_BASE_URL=http://localhost:11434

# 4. Run
ollama serve                 # terminal 1
npm run start:local          # terminal 2
```

> **TIP:**`llama3.1` has the best tool-use support. `qwen2.5` and `mistral` are good alternatives on lighter hardware.

---

## npm Scripts

| Command | Provider | Port |
|---|---|---|
| `npm start` | whatever `.env` says | 3000 |
| `npm run start:cloud` | Anthropic (Claude) | 3000 |
| `npm run start:local` | Ollama | 3001 |
| `npm run chat:cloud` | Anthropic — terminal only | — |
| `npm run chat:local` | Ollama — terminal only | — |

---

## How Memory Works

- **On start** — agent silently loads your memories and uses them naturally. No announcements.
- **During chat** — say *"remember that…"* and it saves immediately.
- **On end** — agent suggests memories worth keeping from the conversation. You pick which ones.

### Memory types

`fact` · `preference` · `project` · `decision` · `solution` · `source` · `person`

---

## MCP Tools (11)

| Tool | Description |
|---|---|
| `remember` | Save a memory + auto-generate embedding |
| `recall` | Semantic search with similarity scores |
| `update_memory` | Edit by UUID, regenerates embedding |
| `forget` | Delete a memory by UUID |
| `backfill_embeddings` | Generate embeddings for memories missing one |
| `dedup_memories` | Find near-duplicates via cosine similarity |
| `read_file` | Read a file from disk (max 500 lines) |
| `write_file` | Overwrite a file completely |
| `append_file` | Add to end of file with before/after verification |
| `scan_project` | Scan a folder tree, infer project context |
| `fetch_url` | Fetch a URL, strip HTML, truncate at 15k chars |

---

## Reading Files with Local AI

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

### Available file tools

| Tool | What it does |
|---|---|
| `read_file` | Read any file from disk (max 500 lines by default) |
| `write_file` | Overwrite a file completely |
| `append_file` | Add content to the end of a file |
| `scan_project` | Scan a folder tree up to 3 levels deep |

### Raising the line limit

The default cap is 500 lines. To increase it, find this in `mcp/index.js`:
```js
const MAX_LINES = 500;
```

> **NOTE**: If you ask it to read a large file it'll truncate. For big files you'd either need to raise that limit or use `scan_project` first to find the right file, then `read_file` on the specific section you need.

Change it to whatever your use case needs.

### Example prompts that just work

- *"Read my server.js and tell me what the WebSocket handler does"*
- *"Scan my project and give me an overview of the structure"*
- *"Read my .env.example and tell me which variables I still need to fill in"*
- *"Append a TODO comment to the bottom of mcp/index.js"*

---

## Privacy & Embeddings

### What leaves your machine

By default, Aperio uses **Voyage AI** to generate embeddings. Here's exactly what happens:

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

### What an embedding actually is

An embedding converts your text into a list of numbers that represent its meaning:

```text
"I chose Postgres because of pgvector" → [0.023, -0.847, 0.331, ... ×1024]
```

Two semantically similar sentences produce vectors that are mathematically close — that's how `recall` finds the right memory even when you phrase the question differently.

### Go fully air-gapped — zero data leaves your machine

If you want complete privacy with no external API calls at all, swap Voyage for a local embedding model:

```bash
ollama pull nomic-embed-text
```

Then uncomment in your `.env`. That is it. It will be used as default ebmedding:

```env
EMBEDDING_PROVIDER=ollama
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

`nomic-embed-text` runs fully locally, produces 768-dimensional vectors, works natively with pgvector, and generates embeddings in ~15–50ms. No API key. No data leaving your machine. Ever.

---

## Build On Top

Aperio is a foundation. The source is fully open — fork it and extend it:

- **Custom memory types** — add columns, new types, per-project namespacing
- **New MCP tools** — calendar, email, git, deploy — one function per tool
- **Swap embeddings** — OpenAI, Cohere, local `nomic-embed` via Ollama
- **Replace the UI** — VS Code extension, Raycast plugin, mobile app, CLI
- **Memory analytics** — query your own brain, visualize growth over time
- **Multi-agent sharing** — research agent, coding agent, writing agent — one brain

PRs and forks welcome.

---


## DeepSeek R1 — Local Reasoning

Aperio has special handling for DeepSeek R1's `<think>` blocks:

- Reasoning is extracted, stripped from the final response, and shown in a collapsible UI panel
- Tool calls are intercepted from R1's text output (R1 doesn't support the tools API natively)
- Fully local — 9GB model, runs well on 16GB+ RAM (tested on M1 32GB)

```bash
ollama pull deepseek-r1:14b   # recommended
ollama pull deepseek-r1:7b    # lighter option
```
---

## Cursor / Windsurf (MCP)

Add to `~/.cursor/mcp.json` (or `~/.windsurf/mcp_config.json`):

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

Restart your editor. All 11 memory tools are now available to your editor agent — same brain, different interface.

---


<div align="center">

Built with ☕ and pgvector  
**One brain. Every agent. Nothing forgotten.**

*From Latin* aperire *— to open, to reveal, to bring into the light.*

</div>
