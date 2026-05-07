<a id="top"></a>
<div align="center">
<h1>✨ Aperio</h1>

**One brain. Every agent. Nothing forgotten.**     
A self-hosted personal memory layer for AI agents. Docker + Postgres + pgvector + MCP + Ollama.   
Your context, always available.  
<!-- 
##### • Download 👉 [Aperio-lite](https://github.com/BaiGanio/aperio/releases/latest/download/aperio-lite.zip) for non-code users. • Small tool for big ideas • [How to Install & Use?](https://github.com/BaiGanio/aperio/wiki/How-to-Install-&-Use-Aperio%E2%80%90lite%3F) •      
--> 
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
│   ├── index.js                  # Store factory — auto-selects Postgres or LanceDB
│   ├── lancedb.js                # LanceDB adapter (no Docker needed)
│   ├── postgres.js               # Postgres + pgvector adapter
│   ├── types.js                  # Shared DB types
│   └── 📂 migrations/            # 001_init · 002_pgvector
├── 📂 docker/
│   └── docker-compose.yml        # pgvector/pgvector:pg16
├── 📂 docs/
│   └── index.html                # Landing page for GitHub Pages
├── 📂 id/
│   └── whoami.md                 # Instructions for AI agent identity (edit this!)
├── 📂 lib/
│   ├── agent.js                  # Agent core — Anthropic / DeepSeek / Ollama loops
│   ├── terminal.js               # Terminal chat client
│   ├── 📂 emitters/              # CLI and WebSocket stream emitters
│   ├── 📂 handlers/              # Attachment and memory handlers
│   ├── 📂 helpers/               # Embeddings, logger, port, shutdown, Ollama health
│   ├── 📂 routes/                # Express API routes + path safety guards
│   ├── 📂 utils/                 # Chat utilities
│   └── 📂 workers/               # Deduplication, reasoning adapters, skill loader
├── 📂 mcp/
│   ├── index.js                  # MCP server entry point
│   └── 📂 tools/
│       ├── memory.js             # remember · recall · update_memory · forget · backfill_embeddings · deduplicate_memories
│       ├── files.js              # read_file · write_file · append_file · scan_project
│       ├── web.js                # fetch_url
│       └── image.js              # read_image · preprocess_image
├── 📂 public/
│   └── index.html                # Web UI — themes, streaming, sidebar
├── 📂 skills/                    # Memory, reasoning, tools, coding standards, etc.
├── 📂 tests/      
├── .env.example                  # Pre-set quick configuration
├── package.json                  # Dependencies
└── server.js                     # Express + WebSocket + agent loop
 
```

> **💡 Tip:** **`whoami.md`** controls the identity of the AI agent.    
> - It is the most impactful file to customize.

---

## Getting Started 
### Prerequisites
- Node.js 18+ — download from [https://nodejs.org/en/download](https://nodejs.org/en/download)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — (optional, for Postgres mode)
- Ollama — download from [https://ollama.com/download](https://ollama.com/download) (optional, for local AI)
- [Anthropic API key](https://console.anthropic.com) — (optional, for cloud AI)
- [DeepSeek API key](https://platform.deepseek.com) — (optional, for cloud AI)
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
> Ready to use `.env.example` for a fully local setup:
```env
# cp .env.example .env

DATABASE_URL=postgresql://aperio:aperio_secret@localhost:5432/aperio
AI_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:3b
EMBEDDING_PROVIDER=transformers    # fully local, no API key required
```

### Step 2. Databases & Migrations

Aperio supports two vector store backends — pick the one that fits your setup:

| Backend | When to use | Requires |
|---------|-------------|----------|
| **LanceDB** (default) | No Docker, quick start, single user | Nothing extra |
| **Postgres + pgvector** | Multi-agent, persistent, production-like | Docker |

```bash
# LanceDB is the default — no extra steps needed.
# Skip the Docker commands below and go directly to Step 3.
```

> **💡 Tip:** Set `DB_BACKEND=lancedb` in `.env` to force LanceDB, or `DB_BACKEND=postgres` for Postgres.   
> If not set, Aperio auto-detects: uses Postgres when Docker is running, LanceDB otherwise.

```bash
# POSTGRES MODE — start the database and run migrations
cd docker && docker compose up -d && cd ..
```
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
### Step 3. Install Ollama & Pull Models
> **💡 Tip:** Skip this step entirely if you are using Anthropic or DeepSeek as your `AI_PROVIDER`.
```bash
ollama serve                     # use separate terminal
```
```bash
ollama pull qwen2.5:3b           # LLM — lightweight, fast, good tool-calling
# ollama pull llama3.1           # LLM — solid tool-calling, no reasoning
# ollama pull qwen3:4b           # LLM — strong reasoning, thinking mode support
```
### Step 4. Start Aperio Web UI
```bash
npm run start:local              # localhost:31337 → browser opens automatically
```
### Step 5. Start Aperio terminal chat
```bash
npm run chat:local               # runs as proxy or standalone
```

> That's it. No API keys. No cloud. Full semantic memory on your machine.

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

## MCP Tools

Aperio exposes **12 tools** over MCP. Any MCP-compatible agent (Cursor, Windsurf, Claude, etc.) can call them.

| Category | Tool | What it does |
|----------|------|-------------|
| **Memory** | `remember` | Save a memory with type, title, tags, importance, and optional expiry |
| | `recall` | Semantic or full-text search across all memories |
| | `update_memory` | Update an existing memory by ID; re-generates its embedding |
| | `forget` | Delete a memory by ID |
| | `backfill_embeddings` | Generate embeddings for memories that are missing one |
| | `deduplicate_memories` | Find and merge near-duplicate memories by cosine similarity |
| **Files** | `read_file` | Read a code or text file (max 500 lines per call, paginated via `offset`) |
| | `write_file` | Create or overwrite a file (subject to write-path guard) |
| | `append_file` | Append content to an existing file without touching the rest |
| | `scan_project` | Traverse a project folder — returns a file tree and reads key files |
| **Web** | `fetch_url` | Fetch a URL, strip HTML, truncate at 15 000 characters |
| **Image** | `read_image` | Load an image (file path or base64) for the agent to analyse |
| | `preprocess_image` | Normalise an image to RGB PNG before sending to a local VLM (strips alpha, letterboxes to 896×896) |

> **💡 Tip:** Check [Aperio MCP Tools Guide](https://github.com/BaiGanio/aperio/wiki/MCP-Tools-Guide) for call examples.

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
| Ollama + local embeddings — zero external calls | Claude / DeepSeek for deep research & heavy tasks |

| | |
|---|---|
| 🗄️ **Your brain, your data** | 🖥️ **MCP-native** |
| Postgres or LanceDB lives on your machine. You own it. | Any MCP agent plugs in — Cursor, Windsurf, etc. |

| |
|---|
| ✅ **Free to run** | |
| No subscription. No per-message cost. Just your hardware. | |

> #### ‼️ What Aperio Is Not!

| | |
|---|---|
| 🚫 **Not a cloud service** | 🚫 **Not a managed product** |
| No hosted version, no SaaS, no managed infra | No support contracts, SLAs, or guaranteed uptime |

| | |
|---|---|
| 🚫 **Not a plugin or extension** | 🚫 **Not a replacement for your AI** |
| It's a self-hosted server you run yourself | A memory layer alongside Claude, Cursor, etc. |

| | |
|---|---|
| 🚫 **Not plug-and-play** | 🚫 **Not production-hardened** |
| Needs Node.js, Docker, and basic terminal comfort | Early software, built in the open, improving fast |

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## AI Providers

Switch with a single line in `.env`. Everything else — memories, tools, UI — stays identical.

```env
AI_PROVIDER=ollama       # "ollama" | "anthropic" | "deepseek"
```

### ⬡ Ollama (Default — Local, Free, Private)

No API keys, no data leaving your machine.

```env
AI_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:3b
OLLAMA_BASE_URL=http://localhost:11434
```

Recommended models (pull with `ollama pull <model>`):

| Model | Best for |
|-------|----------|
| `qwen2.5:3b` | Default — lightweight, fast, good tool-calling |
| `llama3.1` | Solid tool-calling, no thinking/reasoning overhead |
| `qwen3:4b` | Strong reasoning, thinking mode |
| `deepseek-r1:32b` | Heavy reasoning, requires ≥ 60 GB RAM |

> **💡 Tip:** Set `CHECK_RAM=true` in `.env` to let Aperio auto-select a model based on available RAM.

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

#### Q: You call this privacy?
> 💡 Check out our wiki page [MPC Tools](https://github.com/BaiGanio/aperio/wiki/MPC-Tools) for more details.  

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Security
Aperio runs on your machine and has access to your file system through the `scan_project`, `write_file`, `append_file`, and `read_file` tools. File operations are gated by a path safety system — read and write access are controlled independently.

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
