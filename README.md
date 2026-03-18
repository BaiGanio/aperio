<a id="top"></a>
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
  <a href="#how-to-use">How to Use?</a> 
  •  
  <a href="#privacy">Privacy</a> 
  • 
  <a href="#security">Security</a>
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
│   └── index.html                # Aperio landing page on GitHub pages
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

#### Commands
```
npm start # whatever .env says | 3000
```
```
npm run start:local # Ollama | 3001
```
```
npm run start:cloud # Anthropic (Claude) | 3000
```
```
npm run chat:local # Ollama — terminal only
```
```
npm run chat:cloud # Anthropic — terminal only
```

💡 Both instances can run simultaneously and share the same memory database.

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

## How to Use?
### 🛠️ Aperio MCP Tools Guide
Aperio exposes 11 tools for memory management, file operations, and web fetching.

Just type naturally in the chat — no commands, no syntax to remember.

<sub>NOTE: Chevrons are expandable. Click each for quick examples.</sub>

### 🧠 Memory Management Tools

<details>
  <summary><strong>remember</strong> — Save a memory</summary>
  <br>
  <p>Saves structured context about you — facts, decisions, preferences, projects, people, solutions, sources.</p>

```
Remember that I'm building a SaaS called Launchpad using Next.js, Supabase, and Stripe
```
```
Remember that I prefer tabs over spaces and always use TypeScript strict mode
```
```
Remember that I decided to use Fly.io over Railway — better pricing for always-on workloads
```
---

</details>
<details>
  <summary><strong>recall</strong>  — Search memories</summary>
  <br>
  <p>Searches your memory by meaning. Called automatically on every startup — you rarely need to trigger this manually.</p>

```
What do you know about my projects?
```
```
What stack am I using for Launchpad?
```
```
Do you remember any infrastructure decisions I made?
```
---

</details>
<details>
  <summary><strong>update_memory</strong>  — Update an existing memory</summary>
  <br>
  <p>Use when something has changed and a memory is outdated.</p>

```
Update my Launchpad memory — we switched from Supabase to PlanetScale
```
```
The Fly.io memory is wrong — update it, we moved to Railway after all
```
```
Update my name memory, I go by Lyu not Lyuben
```
---

</details>
<details>
  <summary><strong>forget</strong>  — Delete a memory</summary>
  <br>
  <p>Deletes a memory permanently. You can also use the trash icon in the sidebar.</p>

```
Forget everything about the old Stripe integration
```
```
Delete the memory about project Alpha — it's cancelled
```
```
Remove the memory about John from accounting
```
---

</details>
<details>
  <summary><strong>backfill_embeddings</strong>  — Generate missing embeddings</summary>
  <br>
  <p>Run this once after first setup or if semantic search isn't returning relevant results.</p>

```
Backfill embeddings for all my memories
```
```
Run backfill — semantic search isn't finding things correctly
```
---

</details>
<details>
  <summary><strong>dedup_memories</strong>  — Find and remove duplicates</summary>
  <br>
  <p>Finds near-duplicate memories using cosine similarity. Dry run by default — safe to run anytime.</p>

```
Run dedup and show me what duplicates exist
```
```
Check for duplicate memories — dry run only
```
```
Run dedup with dry_run false and merge the duplicates
```
---

</details>

### 📁 File Tools

<details>
  <summary><strong>read_file</strong>  — Read a file from disk</summary>
  <br>
  <p>Reads any file up to 500 lines. Use absolute paths.</p>

```
Read ~/Projects/launchpad/README.md
```
```
Read /Users/lk/Projects/aperio/mcp/index.js and explain what it does
```
```
Read ~/Projects/myapp/.env.example
```
---

</details>
<details>
  <summary><strong>scan_project</strong>  — Scan a project folder</summary>
  <br>
  <p>Scans a directory tree, reads key files, and infers project context. Great for onboarding Aperio to a new codebase.</p>

```
Scan my project at ~/Projects/launchpad and remember the stack
```
```
Scan ~/Projects/aperio and save a memory about the architecture
```
```
Scan ~/Projects/myapp — what tech stack is it using?
```
---

</details>
<details>
  <summary><strong>write_file</strong>  — Write to a file</summary>
  <br>
  <p>Writes content to a file on disk. Always asks for confirmation before writing.</p>

```
Write a basic .gitignore for a Node.js project to ~/Projects/launchpad/.gitignore
```
```
Save this SQL migration to ~/Projects/myapp/db/migrations/004_add_tags.sql
```
```
Write the updated README content to ~/Projects/aperio/README.md
```
---

</details>
<details>
  <summary><strong>append_file</strong>  — Append content to the end of an existing file</summary>
  <br>
  <p>Use this for 'add to', 'append', 'write at the bottom' requests. Returns before/after line count and the last 5 lines as proof.</p>

---

</details>

### 🌐 Web Tools

<details>
  <summary><strong>fetch_url</strong>  — Fetch a webpage</summary>
  <br>
  <p>Fetches a URL, strips HTML, and returns clean text. Useful for summarizing docs, articles, or repos.</p>

```
Fetch https://docs.supabase.com/guides/auth and summarize the auth options
```
```
Fetch https://github.com/BaiGanio/aperio and tell me what the project does
```
```
Fetch https://fly.io/docs/pricing and compare their plans
```
---

</details>

#### 📄 Take a notes

- **Be explicit when saving** — say "remember that..." or "save this as a memory" to trigger `remember` immediately
- **Semantic search is powerful** — ask about topics, not exact titles. "my database decisions" finds more than "postgres"
- **Scan before you ask** — run `scan_project` on a new codebase before asking questions about it
- **Dedup regularly** — run `dedup_memories` after a few sessions to keep your brain clean
- **Embeddings matter** — if recall feels off, run `backfill_embeddings` to fix semantic search -AZ

💡 Check out our wiki page [MPC Tools](https://github.com/BaiGanio/aperio/wiki/MPC-Tools) for more details.

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
