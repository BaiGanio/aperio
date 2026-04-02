<a id="top"></a>
<div align="center">
<h1>✨ Aperio</h1>

**One brain. Every agent. Nothing forgotten.**
<p align="center">• Download 👉 <b><a href="https://github.com/BaiGanio/aperio/releases/latest/download/aperio-lite.zip">Aperio-lite</a></b> for non-code users. • Small tool for big ideas • <a href="https://github.com/BaiGanio/aperio/wiki/How-to-Install-&-Use-Aperio%E2%80%90lite%3F">How to Install & Use?</a> •</p>

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-16-336791?style=flat-square&logo=postgresql&logoColor=white)
![pgvector](https://img.shields.io/badge/pgvector-semantic_search-green?style=flat-square)
![Ollama](https://img.shields.io/badge/Ollama-local_AI-black?style=flat-square)
![MCP](https://img.shields.io/badge/MCP-v1-blue?style=flat-square)
![Claude](https://img.shields.io/badge/Claude-Haiku-orange?style=flat-square)
![GitHub contributors](https://img.shields.io/github/contributors/baiganio/aperio)
<!-- [![Bounties Available](https://img.shields.io/badge/bounties-active-brightgreen)](./PAYMENT.md) --> 
![Latest Release](https://img.shields.io/github/v/release/BaiGanio/aperio) 
[![Bounties Available](https://img.shields.io/badge/bounties-disabled-black)](./PAYMENT.md)
[![Lead Policy](https://img.shields.io/badge/lead%20policy-transparent-blue)](./PROJECT_LEAD_POLICY.md)

[![Downloads](https://img.shields.io/github/downloads/baiganio/aperio/total?style=flat-square)](https://github.com/baiganio/aperio/releases)


A self-hosted personal memory layer for AI agents.  
Postgres + pgvector + MCP. Your context, always available.

• 🌐 Site: **[https://baiganio.github.io/aperio](https://baiganio.github.io/aperio)** •</div>

<!-- HEADER --> 
<p align="center">
  • 
  <a href="#getting-started">Getting Started</a>
  • 
  <a href="#philosophy">Philosophy</a>
  • 
  <a href="#architecture">Architecture</a>
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
<p align="center">  <sub></sub></p>
<p align="center">
  💡 <b>Pro Tip:</b> Visit the <a href="https://github.com/BaiGanio/aperio/wiki">Aperio Wiki</a> or <a href="https://github.com/BaiGanio/aperio/discussions">Discussions</a> for extensive documentation on advanced topics.<br>
   🔍 <b>Explore more:</b> <a href="https://github.com/BaiGanio/aperio/issues/3">Early Testing Contributors</a> • <a href="https://github.com/BaiGanio/aperio/discussions/14">FAQ</a> • <a href="https://github.com/BaiGanio/aperio/wiki/Troubleshooting">Troubleshooting</a>
</p>

---
## 🏗️ Project Structure   
```txt
📂 aperio/          <---=  You are here if You are Developer. He-he ;/
├── 📂 db/
│   └── 📂 migrations/            # 001_init · 002_pgvector
├── 📂 docker/
│   └── docker-compose.yml        # pgvector/pgvector:pg16
├── 📂 docs/
│   └── index.html                # Landing page for GitHub Pages
├── 📂 how-to/                    # Installation scripts and instructions
├── 📂 lib/
│   └── chat.js                   # Terminal chat client
├── 📂 mcp/
│   └── index.js                  # MCP server — 11 tools
├── 📂 prompts/
│   └── system_prompt.md          # Instructions for AI agents (edit this!)
├── 📂 public/
│   └── index.html                # Web UI — themes, streaming, sidebar
├── 📂 skills/                    # Memory, reasoning, tools, etc.
├── .env.example                  # Pre-set quick configuration
├── package-lock.json
├── package.json                  # Dependencies
└── server.js                     # Express + WebSocket + agent loop
```

> **💡 Tip:** `prompts/system_prompt.md` controls how AI agents handles memories. It's the most impactful file to customize.

---

## Getting Started 

👉 [Aperio-lite](https://github.com/BaiGanio/aperio/releases/latest/download/aperio-lite.zip) - for non-code users.
- Small tool for big ideas 🧐
- The fastest path. Runs 100% on your machine. 
- No API Keys. No Cloud. No registration here and there.

<details>
  <summary>Quick Instructions <- click it!</summary><br>

> OPTION: EASY (MacOS/Linux)

> - Download the latest version, unzip and open in `Finder`.
> - Look for file name called `start.sh`.
> - Mark it, right click on it and select `Make Alias`.
> - Name the new file `Aperio` or by your choice.
> - Drag the alias to the Desktop folder on the left sidebar in Finder.
>   - ❗Dragging to the Desktop itself wont work. Should be in Finder app.
> - Just double-click the file on the Desktop like a normal app!
> - Follow the installation instructions - (one-time setup)
> - The application will automatically open the default browser at `http://localhost:31337`

---

> OPTION: TECHNICAL (MacOS/Linux)

> Open terminal in the project root
> Run `chmod +x START.sh` - grant permission to the main script just in case
> Follow the installation instructions - (one-time setup)
> Open browser at `http://localhost:31337`

> Q: Future use?

> - Just double-click the file in Finder like a normal app!
> - If you have made an Alias, same - double click from Desktop
> - For a terminal geeks - `./start.sh` in the project root

>💡 Check our wiki page [Aperio-lite Installation Guide](https://github.com/BaiGanio/aperio/wiki/How-to-Install-&-Use-Aperio%E2%80%90lite%3F) for more clarifications.    
>💡 Check our wiki page [Aperio MCP Tools Guide](https://github.com/BaiGanio/aperio/wiki/MCP-Tools-Guide) for extended examples. 

---

</details>

### Prerequisites
- Node.js 18+
- Docker Desktop — (optional)
- [Ollama](https://ollama.ai)
- [Anthropic API key](https://console.anthropic.com) — (optional) or Ollama for local AI
- [Voyage AI API key](https://dash.voyageai.com) — (optional) free, 50M tokens/month or `nomic-embed-text` for local embeddings

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
DATABASE_URL=postgresql://aperio:aperio_secret@localhost:5432/aperio
AI_PROVIDER=ollama
OLLAMA_MODEL=llama3.1
EMBEDDING_PROVIDER=ollama
OLLAMA_EMBED_MODEL=mxbai-embed-large
```

### Step 2. Databases & Migrations
```bash
# vector database for lite mode when Docker is optional
npm install @lancedb/lancedb uuid 
```
> 💡 If no Docker is installed (dev-lite mode)- skip below commands and go directly to `Step 3`.
```bash
# DEV-MODE - start the database and run migrations
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
```bash
npm install ollama               # run only if not previosly installed
ollama serve                     # use separate terminal
```
```bash
ollama pull llama3.1             # LLM — best tool-calling support ! Noreasoning
# ollama pull qwen3              # LLM — strong reasoning, thinking mode support
ollama pull mxbai-embed-large    # embeddings — local semantic search
```
### Step 4. Start Aperio
```bash
npm run start:local              # localhost:31337 → browser opens automatically
```

> That's it. No API keys. No cloud. Full semantic memory on your machine.

### Step 5. Now what?

>💡 Stuck on the installation steps? - check [Troubleshooting](https://github.com/BaiGanio/aperio/wiki/Troubleshooting) wiki.

>💡 Check [Aperio MCP Tools Guide](https://github.com/BaiGanio/aperio/wiki/MCP-Tools-Guide) wiki for extended examples.   
>💡 Check [Commands](https://github.com/BaiGanio/aperio/wiki/Commands) wiki for the available options to run the app.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Philosophy
Aperio is open source and self-hosted because **your memories is yours**.
- It runs entirely on your machine - no API keys, no data leaving your network, no cloud dependency.   
- Default is local and private. The option - self-hosted. The price - free forever.   
- Cloud AI is available as a power upgrade, but you will be never forced to use it.    

<img alt="Aperio philosophy" src="https://github.com/user-attachments/assets/cc129c2f-174e-49c6-9804-6a1264964546" />

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Architecture
<img alt="Aperio architecture" src="https://raw.githubusercontent.com/BaiGanio/aperio/master/.github/images/aperio-architecture.png" />

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
EMBEDDING_PROVIDER=ollama
OLLAMA_EMBEDDING_MODEL=mxbai-embed-large
```

> **💡 Tip:** Use `qwen3` as your daily driver. Switch to `deepseek-r1:14b` for deep reasoning. `llama3.1` for fast responses when reasoning isn't needed.

### ✦ Anthropic Claude (Optional — Cloud Upgrade)

For heavy research, complex multi-step reasoning, or the strongest tool-calling available.
```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
VOYAGE_API_KEY=pa-...
```

💡 Check out our wiki pages [AI Providers](https://github.com/BaiGanio/aperio/wiki/AI-Providers) & [Embeddings](https://github.com/BaiGanio/aperio/wiki/Embeddings) for more details.

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

💡 Check out our wiki page [MPC Tools](https://github.com/BaiGanio/aperio/wiki/MPC-Tools) for more details.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Security
Aperio runs on your machine and has access to your file system through the `scan_project`, `write_file`, `append_file`, and `read_file` tools. By default, file operations are restricted to the directory where the process was started from — which will be the Aperio project root when you run `npm run start:local`.

**File system access**

The `scan_project`, `write_file`, `append_file`, and `read_file` tools can access any absolute path on your machine that the Node.js process has permission to read or write. 

📄 Take a notes:
- Only run Aperio on a machine you trust
- Do not expose the MCP server or web UI to the public internet without authentication
- Review any file write operations before confirming them — `write_file` overwrites completely with no undo
- The AI model can be prompted (or hallucinate) to write to sensitive paths — always review before confirming
- Never commit your `.env` file — it contains your database URL and API keys

**Customize file access further** by setting `APERIO_ALLOWED_PATHS` in your `.env`:

```env
# Allow only specific directories (comma-separated)
APERIO_ALLOWED_PATHS=/Users/yourname/projects,/Users/yourname/documents
```

If a model attempts to write outside the allowed paths, the operation is blocked and an error is returned.

💡 Check out our wiki page [Path safety](https://github.com/BaiGanio/aperio/wiki/Path-Safety) for more details.

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

<div align="center">

Built with ☕ and pgvector  
**One brain. Every agent. Nothing forgotten.**

*From Latin* aperire *— to open, to reveal, to bring into the light.*

</div>
