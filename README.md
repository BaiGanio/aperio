<a id="top"></a>
<div align="center">
<h1>✨ Aperio</h1>

**One brain. Every agent. Nothing forgotten.**

![Latest Release](https://img.shields.io/github/v/release/BaiGanio/aperio) 
[![Bounties Available](https://img.shields.io/badge/bounties-disabled-black)](./PAYMENT.md)
[![Lead Policy](https://img.shields.io/badge/lead%20policy-transparent-blue)](./PROJECT_LEAD_POLICY.md)
<!-- [![Bounties Available](https://img.shields.io/badge/bounties-active-brightgreen)](./PAYMENT.md) --> 
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)
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

<!-- HEADER --> 
<p align="center">
  • 
  <a href="#philosophy">Philosophy</a>
  • 
  <a href="#architecture">Architecture</a>
  • 
  <a href="#getting-started">Getting Started</a>
  • 
  <a href="#ai-providers">AI Providers</a>
  • 
  <a href="https://github.com/BaiGanio/aperio/wiki/MCP-Tools-Guide" target="_blank">Aperio MCP Tools Guide</a> 
  •  
  <a href="#privacy">Privacy</a> 
  • 
  <a href="#security">Security</a>
  •  
  <a href="https://github.com/BaiGanio/aperio/discussions/24">Design Decisions</a>
  • 
</p>
<p align="center">
  <sub>💡 <b>Pro Tip:</b> Visit the <a href="https://github.com/BaiGanio/aperio/wiki">Aperio Wiki</a> for extensive documentation on advanced topics.<br>
   Explore more: <a href="https://github.com/BaiGanio/aperio/issues/3">Early Testing Contributors</a> • <a href="https://github.com/BaiGanio/aperio/discussions/14">FAQ</a> • <a href="https://github.com/BaiGanio/aperio/wiki/Troubleshooting">Troubleshooting</a></sub>
</p>

---
## 🏗️ Project Structure
```txt
📂 aperio/          <---=  You are here 
├── 📂 db/
│   └── 📂 migrations/            # 001_init · 002_pgvector
├── 📂 docker/
│   └── docker-compose.yml        # pgvector/pgvector:pg16
├── 📂 docs/
│   └── index.html                # Landing page for GitHub Pages
├── 📂 mcp/
│   └── index.js                  # MCP server — 11 tools
├── 📂 prompts/
│   └── system_prompt.md          # Instructions for AI agents (edit this!)
├── 📂 public/
│   └── index.html                # Web UI — themes, streaming, sidebar
├── 📂 scripts/
│   └── chat.js                   # Terminal chat client
├── .env                          # Your keys — never commit this
├── START.sh                      # Aperio (lite) for MacOS/Linux
├── package.json
└── server.js                     # Express + WebSocket + agent loop
```

> **💡 Tip:** `prompts/system_prompt.md` controls how AI agents handles memories. It's the most impactful file to customize.

---

## Philosophy
<img alt="Aperio philosophy" width="100%" srcs="https://raw.githubusercontent.com/BaiGanio/aperio/master/.github/images/aperio-philosophy.png" />

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Architecture
<img alt="Aperio architecture" srcs="https://raw.githubusercontent.com/BaiGanio/aperio/master/.github/images/aperio-architecture.png" />

<p align="right">
  [<a href="#top">Back to top ↑</a>]
</p>

---

## Getting Started 

👉 [Aperio-lite](https://github.com/BaiGanio/repository/releases/latest/download/aperio-lite.zip) - for non-code users.
- Small tool for big ideas 🧐
- The fastest path. Runs 100% on your machine. No API Keys.

<details>
  <summary>Instructions (MacOS/Linux) <- click it!</summary><br>

> OPTION: EASY

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

> OPTION: TECHNICAL

> Open terminal in the project root
> Run `chmod +x START.sh` - grant permission to the main script just in case
> Follow the installation instructions - (one-time setup)
> Open browser at `http://localhost:31337`

> Q: Future use?
> - Just double-click the file in Finder like a normal app!
> - For a terminal geeks - `./start.sh` in the project root

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
```bash
git clone https://github.com/BaiGanio/aperio
cd aperio
```
> Minimum `.env.example` for a fully local setup:
```env
DATABASE_URL=postgresql://aperio:aperio_secret@localhost:5432/aperio
AI_PROVIDER=ollama
OLLAMA_MODEL=qwen3
EMBEDDING_PROVIDER=ollama
OLLAMA_EMBED_MODEL=mxbai-embed-large
```

### Step 2. Start The Database & Run migrations
```bash
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
npm install ollama
ollama serve 
```
```bash
ollama pull llama3.1           # LLM — best tool-calling support
ollama pull qwen3              # LLM — strong reasoning, thinking mode support
ollama pull mxbai-embed-large  # embeddings — local semantic search
```
### Step 4. Start Aperio
```bash
npm install             # terminal 1  →  restore dependencies
npm run start:local     # terminal 2  →  localhost:31337 → if option is developer
npm run start:lite      # terminal 2  →  localhost:31337 → if option is lite
```

> That's it. No API keys. No cloud. Full semantic memory on your machine.

### Now what?
(1st run only) - Once Aperio is running, open the chat in the browser at `localhost:31337` and type:
```bash
backfill my embeddings
```
  
 This generates semantic vectors for all your memories. 
- Without this step, search falls back to full-text only.
- You only need to do this once — new memories are embedded automatically.

>💡 If you get stuck on your installation steps - check our [Troubleshooting](https://github.com/BaiGanio/aperio/wiki/Troubleshooting) wiki page.

>💡 Check our wiki page [Aperio MCP Tools Guide](https://github.com/BaiGanio/aperio/wiki/MCP-Tools-Guide) for extended examples.   
>💡 Check our wiki page [Commands](https://github.com/BaiGanio/aperio/wiki/Commands) for the available options to run the app.

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
