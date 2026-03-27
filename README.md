<a id="top"></a>
<div align="center">
<h1>✨ Aperio</h1>

**One brain. Every agent. Nothing forgotten.**

[![Bounties Available](https://img.shields.io/badge/bounties-active-brightgreen)](./PAYMENT.md)
[![Lead Policy](https://img.shields.io/badge/lead%20policy-transparent-blue)](./PROJECT_LEAD_POLICY.md)

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
├── package.json
└── server.js                     # Express + WebSocket + agent loop
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
```mermaid
flowchart TD
    Browser["Browser
    localhost:31337 · cloud:3000"]
    note1["Full-duplex WebSocket —
    streaming without polling"]

    Express["Express server · server.js"]
    note2["Only process on the network.
    Routes messages, manages sessions."]

    MCP["MCP server · mcp/index.js · 11 tools"]
    note3["Any MCP-compatible agent
    shares the same brain."]

    subgraph DB ["Database layer"]
        Postgres[("Postgres 16 + pgvector")]
        note4["Battle-tested, self-hosted.
        Semantic search built in."]
        LanceDB[("LanceDB")]
        note5["Embedded vector DB.
        Zero infra, fast local search."]
    end

    subgraph AI ["AI layer"]
        Ollama["Ollama"]
        note6["Local inference — llama3.1,
        qwen3, deepseek-r1 and more."]
        Embeddings["mxbai-embed-large"]
        note7["Local embeddings via Ollama.
        No external API calls."]
    end

    subgraph Cloud ["Optional cloud upgrade"]
        Claude["Claude · Anthropic API"]
        note8["Drop-in for complex
        reasoning tasks."]
        Voyage["Voyage AI"]
        note9["Highest embedding quality
        for power users."]
    end

    Browser <-->|"WebSocket · streaming"| Express
    Express <-->|stdio| MCP
    MCP <--> Postgres
    MCP <--> LanceDB
    MCP <--> Ollama
    Ollama --> Embeddings
    Ollama -. swap in .-> Claude
    Embeddings -. swap in .-> Voyage

    Browser ~~~ note1
    Express ~~~ note2
    MCP ~~~ note3
    Postgres ~~~ note4
    LanceDB ~~~ note5
    Ollama ~~~ note6
    Embeddings ~~~ note7
    Claude ~~~ note8
    Voyage ~~~ note9

    style note1 fill:#fafaf8,stroke:#d3d1c7,color:#5f5e5a,font-size:11px
    style note2 fill:#fafaf8,stroke:#d3d1c7,color:#5f5e5a,font-size:11px
    style note3 fill:#fafaf8,stroke:#d3d1c7,color:#5f5e5a,font-size:11px
    style note4 fill:#fafaf8,stroke:#d3d1c7,color:#5f5e5a,font-size:11px
    style note5 fill:#fafaf8,stroke:#d3d1c7,color:#5f5e5a,font-size:11px
    style note6 fill:#fafaf8,stroke:#d3d1c7,color:#5f5e5a,font-size:11px
    style note7 fill:#fafaf8,stroke:#d3d1c7,color:#5f5e5a,font-size:11px
    style note8 fill:#fafaf8,stroke:#d3d1c7,color:#5f5e5a,font-size:11px
    style note9 fill:#fafaf8,stroke:#d3d1c7,color:#5f5e5a,font-size:11px
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

### Prerequisites
- Node.js 18+
- Docker Desktop — (optional)
- [Ollama](https://ollama.ai)
- [Anthropic API key](https://console.anthropic.com) — (optional) or Ollama for local AI
- [Voyage AI API key](https://dash.voyageai.com) — (optional) free, 50M tokens/month or `nomic-embed-text` for local embeddings

### Step 1. Clone & install
```bash
git clone https://github.com/BaiGanio/aperio
cd aperio
npm install
```

### Step 2. Configure environment
#### **Option `lite`**
What each package does:
- `@lancedb/lancedb`: This is the database engine that will store and search your private files.
- `uuid`: Generates "Universally Unique Identifiers" (random IDs)s for every piece of information you save in your database, preventing data overwrites.
- `ollama`: This is the JavaScript library that lets your code send questions to the Qwen3 model and get reasoning-based answers back
```bash
npm install @lancedb/lancedb uuid ollama
```
>❗ NOTE: If you choose the `lite` option, skip other steps all the way down to step **6**.
#### **Option `developer`**
Minimum `.env` for a fully local setup:
```bash
cp .env.example .env
```
```env
DATABASE_URL=postgresql://aperio:aperio_secret@localhost:5432/aperio
AI_PROVIDER=ollama
OLLAMA_MODEL=qwen3
EMBEDDING_PROVIDER=ollama
OLLAMA_EMBED_MODEL=mxbai-embed-large
```
```bash
npm install ollama
```

### Step 3. Start the database
```bash
cd docker && docker compose up -d && cd ..
```

### Step 4. Run migrations
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
### Step 5. Pull Ollama models
```bash
ollama pull llama3.1           # LLM — best tool-calling support
ollama pull qwen3              # LLM — strong reasoning, thinking mode support
ollama pull mxbai-embed-large  # embeddings — local semantic search
```
### Step 6. Start Aperio
```bash
ollama serve            # terminal 1
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
