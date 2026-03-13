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
  [ <a href="#local-vs-vloud">Local vs Cloud</a> ]
  · · ·
  [ <a href="#commands">Commands</a> ]
  · · ·
  [ <a href="#mcp-tools-11">MCP Tools</a> ]  
  · · ·
  [ <a href="#privacy">Privacy</a> ]  
  · · ·
</p>

---

<div align="center">
<h1>✦ Aperio</h1>

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
| **nomic-embed-text** | Local embeddings via Ollama — no external calls |
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
OLLAMA_EMBED_MODEL=nomic-embed-text
```

### 4. Pull Ollama models
```bash
ollama pull llama3.1           # LLM — best tool-calling support
ollama pull nomic-embed-text   # embeddings — local semantic search
```

### 5. Start the database
```bash
cd docker && docker compose up -d && cd ..
```

### 6. Run migrations
```bash
docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/001_init.sql
docker exec -i aperio_db psql -U aperio -d aperio < db/migrations/002_pgvector.sql
```

### 7. Start Aperio
```bash
ollama serve            # terminal 1
npm run start:local     # terminal 2  →  localhost:3001
```

### 8. Seed your brain

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

### 🧠 Reasoning

Aperio has special handling for DeepSeek R1's  and Qwen3`<think>` blocks:

- Reasoning is extracted, stripped from the final response, and shown in a collapsible UI panel

> **Important note:** Due to the limitations of my M1 Pro 32GB, I CAN NOT confirm that Aperio handles the models reasoning behavior perfectly. Still working on it.


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

> **Tip:** Start with `llama3.1`. Upgrade to `qwen3` or `deepseek-r1` when you want reasoning transparency.

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
OLLAMA_EMBED_MODEL=nomic-embed-text

# Cloud upgrade
VOYAGE_API_KEY=pa-...
```

| Provider | Details |
|---|---|
| **Ollama** *(default)* | `nomic-embed-text` — zero external calls, 768 dims |
| **Voyage AI** *(optional)* | `voyage-3` — 1024 dims, highest quality, 50M free tokens/month |

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Local vs Cloud

| | ⬡ Ollama (Local) | ✦ Claude (Cloud) |
|---|---|---|
| **Cost** | Free | ~$0.01–0.20/session |
| **Privacy** | 100% local | Data sent to Anthropic |
| **Tool calling** | Good (model dependent) | Excellent |
| **Reasoning** | qwen3 / deepseek thinking mode | Claude Sonnet / Opus |
| **Speed** | Depends on hardware | Fast |
| **Offline** | ✅ Yes | ❌ No |
| **Best for** | Daily use, privacy, experiments | Heavy research, complex agents |

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

> **Tip:** Both instances can run simultaneously and share the same memory database.

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


`nomic-embed-text` runs fully locally, produces 768-dimensional vectors, works natively with pgvector, and generates embeddings in ~15–50ms. No API key. No data leaving your machine. Ever.

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

## Build On Top

Aperio is a foundation. The source is fully open — fork it and extend it:

- **Custom memory types** — add columns, new types, per-project namespacing
- **New MCP tools** — calendar, email, git, deploy — one function per tool
- **Swap embeddings** — OpenAI, Cohere, local `nomic-embed` via Ollama
- **Replace the UI** — VS Code extension, Raycast plugin, mobile app, CLI
- **Memory analytics** — query your own brain, visualize growth over time
- **Multi-agent sharing** — research agent, coding agent, writing agent — one brain

PRs and forks welcome.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

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

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---


<div align="center">

Built with ☕ and pgvector  
**One brain. Every agent. Nothing forgotten.**

*From Latin* aperire *— to open, to reveal, to bring into the light.*

</div>
