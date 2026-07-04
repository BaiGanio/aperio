// lib/config.js
//
// Single source of truth for every user-facing configuration variable in
// Aperio. Issue #167, Phase 1.
//
// Nothing here reads or resolves values yet — this file is pure metadata. A
// later phase adds the resolver (DB > real env var > default) and a boot-time
// step that injects DB-stored values into process.env before the app loads, so
// the ~280 existing `process.env.X` reads keep working unchanged. Because the
// model is "restart to apply", there is no hot-reload machinery and only two
// tiers:
//
//   tier 0  → bootstrap / secret. Read from .env ONLY (the resolver itself
//             needs some of these to even open the DB). Shown read-only in the
//             eventual Settings UI.
//   tier 1  → editable in the Settings UI, persisted to the DB, restart to
//             apply. A real .env var still wins over the DB value (dev escape
//             hatch); the UI flags such keys as "overridden by .env".
//
// `scripts/gen-env-example.js` walks this registry to regenerate
// `.env.example`. It NEVER touches a real `.env` — technical users who edit
// `.env` by hand keep that file; the generator only refreshes the template.
//
// Deliberately excluded (set by the OS or the app itself, never by a user):
//   HOME, APPDATA, NODE_ENV, APERIO_PROC_ROLE.

// Risk-based groups (top = safest). The generated .env.example is ordered by
// group, with a STOP banner after the first one. `gen-env-example.js` walks
// these; each SECTION below names the group it belongs to.
//   start    → safe to edit; the few values most setups actually touch.
//   features → optional capabilities, off/at-default until enabled. Normally
//              toggled in the in-app Settings panel (DB); listed for headless use.
//   external → credentials/endpoints for third-party services.
//   core     → bootstrap + security plumbing read before the DB opens; MUST
//              live in .env, and wrong values can stop the app or expose it.
export const GROUPS = [
  { id: "start", title: "1 · START HERE — safe to edit",
    blurb: "The few values most setups actually touch. Pick a provider and paste its key (or use local Ollama), then choose a model and port." },
  { id: "features", title: "2 · OPTIONAL FEATURES",
    blurb: "Extra capabilities, all off or at their default until you turn them on. These are normally toggled in the app's Settings panel (saved to the database); they're listed here for headless / file-only setups. By default (APERIO_CONFIG_PRECEDENCE=env) what you set here wins; set it to db to let a value saved in the UI override what you set here instead." },
  { id: "external", title: "3 · EXTERNAL INTEGRATIONS — keys & endpoints",
    blurb: "Credentials and connection details for third-party services. Leave blank to keep the integration off." },
  { id: "core", title: "4 · CORE / CRITICAL — bootstrap & security",
    blurb: "Read at startup before the database opens, so these MUST live in .env (the UI can't manage them). Wrong values can stop Aperio from starting or expose it on a network — change only with intent." },
];

// Section order = order they appear within their group in the generated file.
export const SECTIONS = [
  { id: "essentials", title: "ESSENTIALS", group: "start",
    blurb: "The few values most setups need to get started." },
  { id: "database", title: "Database (bootstrap)", group: "core",
    blurb: "How and where Aperio stores its data. Read at startup before anything else, so these stay in .env." },
  { id: "postgres", title: "Postgres", group: "core",
    blurb: "Only used when DB_BACKEND=postgres (or Docker is detected)." },
  { id: "paths", title: "File path safety", group: "features",
    blurb: "Seed-only: these populate the allowed-folders list on first run, then it's edited in the UI and persisted in the DB." },
  { id: "shell", title: "Shell execution (run_shell tool)", group: "features",
    blurb: "Lets the model run a single allowlisted shell command inside the session workspace. NOT a sandbox — off by default." },
  { id: "models", title: "Capable local models", group: "features",
    blurb: "Local Ollama models are lean chat models by default; list trusted ones to grant them tools + memory." },
  { id: "toolsafety", title: "Tool-call safety", group: "features",
    blurb: "Tools treated as destructive get strict handling: malformed JSON arguments are never auto-repaired (a 'fixed' string could silently corrupt a file or row) and a failed call returns a plain error instead of a coercion hint. The built-in list (write_file, edit_file, db_execute, run_shell, …) can't be weakened; you can only extend it." },
  { id: "ollama", title: "Ollama (local) extras", group: "features",
    blurb: "Defaults shown — override only if your Ollama setup differs." },
  { id: "gemini", title: "Gemini thinking budget", group: "features",
    blurb: "Tokens reserved for reasoning. 0 = off. Range when on: 512–24576." },
  { id: "roundtable", title: "Round-table mode (two-agent cross-review)", group: "features",
    blurb: "Boots a second verifier agent that reviews/revises answers until both agree or the round cap." },
  { id: "wiki", title: "Wiki refresh provider", group: "features",
    blurb: "Regenerate stale wiki articles with a cheaper/local provider instead of the chat model." },
  { id: "embeddings", title: "Embeddings", group: "features",
    blurb: "transformers (local, no key) or voyage (cloud). EMBEDDING_DIMS must match the model — changing it needs a fresh DB." },
  { id: "github", title: "GitHub integration", group: "external",
    blurb: "Token + webhook secret for the issue-triage tools. Both can also be set in the app (Settings → GitHub triage)." },
  { id: "graph", title: "Code & document graph", group: "features",
    blurb: "Symbol/reference index of the workspace + document index so the model can navigate code and docs." },
  { id: "dbtools", title: "Database tool (SQL connections)", group: "external",
    blurb: "Named connections the db_* tools can query (SQLite/Postgres/MySQL/SQL Server + the built-in 'aperio' store). Normally added in Settings → Database connections; the env var below is a headless seed." },
  { id: "agents", title: "Background agents (scheduled, chat-less jobs)", group: "features",
    blurb: "Master switch for the background-agent scheduler and how long run history is kept." },
  { id: "timeouts", title: "Request timeouts (advanced)", group: "features",
    blurb: "Milliseconds. Raise if big local models or slow networks time out." },
  { id: "logging", title: "Logging & diagnostics", group: "features", blurb: "" },
  { id: "server", title: "Server", group: "core", blurb: "" },
  { id: "network", title: "Network security", group: "core", blurb: "" },
  { id: "hosting", title: "Hosting hardening", group: "core", blurb: "" },
];

// Field reference:
//   key      env var name
//   section  one of SECTIONS[].id
//   type     select | number | boolean | text | list | secret | path
//   tier     0 (bootstrap/secret, .env only) | 1 (UI-editable, restart to apply)
//   default  built-in fallback when unset (the resolver's last resort)
//   example  illustrative value the generator writes (falls back to `default`)
//   options  allowed values for `select`
//   show     'set' → emit uncommented   | 'commented' (default) → emit `# KEY=…`
//   help     short comment block emitted above the line
export const CONFIG = [
  // ── essentials ──────────────────────────────────────────────
  { key: "AI_PROVIDER", section: "essentials", type: "select", tier: 1, show: "set",
    default: "", example: "ollama",
    options: ["anthropic", "deepseek", "gemini", "ollama", "claude-code"],
    help: "Which AI backend to use.\n• anthropic / deepseek / gemini → cloud; paste the matching API key below.\n• ollama → free, runs on your machine (no key).\n• claude-code → uses your Claude Pro/Max subscription via the Agent SDK (requires the `claude` CLI logged in; do NOT also set ANTHROPIC_API_KEY)." },

  { key: "ANTHROPIC_API_KEY", section: "essentials", type: "secret", tier: 1, show: "set",
    default: "", help: "Anthropic — console.anthropic.com" },
  { key: "ANTHROPIC_MODEL", section: "essentials", type: "text", tier: 1, show: "set",
    default: "claude-haiku-4-5-20251001", help: "" },

  { key: "DEEPSEEK_API_KEY", section: "essentials", type: "secret", tier: 1, show: "set",
    default: "", help: "DeepSeek — platform.deepseek.com" },
  { key: "DEEPSEEK_MODEL", section: "essentials", type: "text", tier: 1, show: "set",
    default: "deepseek-v4-flash", help: "" },

  { key: "GEMINI_API_KEY", section: "essentials", type: "secret", tier: 1, show: "set",
    default: "", help: "Google Gemini — aistudio.google.com" },
  { key: "GEMINI_MODEL", section: "essentials", type: "text", tier: 1, show: "set",
    default: "gemini-2.0-flash", help: "" },

  { key: "OPENAI_API_KEY", section: "essentials", type: "secret", tier: 1, show: "commented",
    default: "", help: "OpenAI key (only if you wire an OpenAI-compatible provider)." },
  { key: "CLAUDE_CODE_OAUTH_TOKEN", section: "essentials", type: "secret", tier: 1, show: "commented",
    default: "", help: "Alternative to running `claude` interactively when AI_PROVIDER=claude-code." },

  { key: "OLLAMA_MODEL", section: "essentials", type: "text", tier: 1, show: "set",
    default: "qwen2.5:3b",
    help: "LOCAL: if you chose ollama, set the model (install: ollama.ai).\nPick by RAM: <8GB → qwen2.5:3b · 8GB → gemma4:e4b · 24GB → gemma4:12b · 48GB+ → qwen3:30b-a3b" },

  { key: "PORT", section: "essentials", type: "number", tier: 0, show: "set",
    default: "3000", example: "31337", help: "Port the web app runs on." },

  { key: "APERIO_CONFIG_PRECEDENCE", section: "essentials", type: "select", tier: 0,
    show: "commented", default: "env", example: "env", options: ["db", "env"], editable: true,
    help: "Who wins when a setting is in BOTH the Settings UI (DB) and your .env:\n• env (default) → your .env wins, so terminal users configure everything from the file. Settings that are ONLY in the DB (no .env entry) still apply — env mode overrides, it does not ignore the DB.\n• db → the Settings UI is authoritative; a saved value overrides .env, so you can manage everything from the panel instead of editing .env by hand.\nReadable from .env (so it can force itself) but also editable in the Settings UI — flip it to 'db' there once you want to drive config from the panel." },

  // ── database (bootstrap) ────────────────────────────────────
  { key: "DB_BACKEND", section: "database", type: "select", tier: 0, show: "commented",
    default: "sqlite", options: ["sqlite", "postgres"],
    help: "'postgres' (Docker required) | 'sqlite' (zero-config, default).\nDefault: auto-detect — Postgres if Docker is running, else SQLite." },
  { key: "SQLITE_PATH", section: "database", type: "path", tier: 0, show: "commented",
    default: "./.sqlite/aperio.db", help: "Where SQLite stores data (default shown)." },
  { key: "APERIO_DB_ENCRYPT", section: "database", type: "boolean", tier: 0, show: "commented",
    default: "", example: "1",
    help: "Encrypt the SQLite database file on disk with AES-256-GCM. Key lives in your OS keychain. Off by default; SQLite only." },

  // ── postgres ────────────────────────────────────────────────
  { key: "POSTGRES_HOST", section: "postgres", type: "text", tier: 0, show: "set", default: "localhost", help: "" },
  { key: "POSTGRES_PORT", section: "postgres", type: "number", tier: 0, show: "set", default: "5432", help: "" },
  { key: "POSTGRES_DB", section: "postgres", type: "text", tier: 0, show: "set", default: "aperio", help: "" },
  { key: "POSTGRES_USER", section: "postgres", type: "text", tier: 0, show: "set", default: "aperio", help: "" },
  { key: "POSTGRES_PASSWORD", section: "postgres", type: "secret", tier: 0, show: "set", default: "aperio_secret", help: "Change this!" },
  { key: "DATABASE_URL", section: "postgres", type: "text", tier: 0, show: "set",
    default: "postgresql://aperio:aperio_secret@localhost:5432/aperio", help: "" },

  // ── paths ───────────────────────────────────────────────────
  { key: "APERIO_ALLOWED_PATHS_TO_READ", section: "paths", type: "list", tier: 1, show: "commented",
    default: "", example: "/abs/path/one,/abs/path/two",
    help: "Seed only. Comma-separated absolute paths that populate the allowed read-folders list on first run; edited in the UI thereafter. Project dir + session scratch are always allowed." },
  { key: "APERIO_ALLOWED_PATHS_TO_WRITE", section: "paths", type: "list", tier: 1, show: "commented",
    default: "", example: "/abs/path/one", help: "Seed only. As above, for write access." },

  // ── shell ───────────────────────────────────────────────────
  { key: "APERIO_ENABLE_SHELL", section: "shell", type: "boolean", tier: 1, show: "commented",
    default: "", example: "1",
    help: "Allow the run_shell tool (single allowlisted command in the session workspace). NOT a sandbox — grants host execution as your user. Only enable for trusted models/content." },
  { key: "APERIO_SHELL_LOCAL", section: "shell", type: "boolean", tier: 1, show: "commented",
    default: "", example: "1",
    help: "By default only cloud providers get run_shell. Set to also offer it to local Ollama models." },
  { key: "APERIO_SHELL_MAX_OUTPUT_BYTES", section: "shell", type: "number", tier: 1, show: "commented",
    default: "48000", help: "Max bytes of shell output captured before truncation." },

  // ── capable local models ────────────────────────────────────
  { key: "APERIO_CAPABLE_MODELS", section: "models", type: "list", tier: 1, show: "commented",
    default: "", example: "qwen3:32b,llama3.1:70b",
    help: "Comma-separated local model names you trust to get the full tools + memory flow (others stay lean chat models)." },

  // ── tool-call safety ────────────────────────────────────────
  { key: "APERIO_EXTRA_DESTRUCTIVE_TOOLS", section: "toolsafety", type: "list", tier: 1, show: "commented",
    default: "", example: "my_custom_writer,my_db_mutator",
    help: "Comma-separated EXTRA tool names to treat as destructive, added to the built-in set. Use for your own / MCP tools that mutate state. Built-ins can't be removed — this only adds stricter handling." },

  // ── ollama extras ───────────────────────────────────────────
  { key: "OLLAMA_BASE_URL", section: "ollama", type: "text", tier: 1, show: "commented",
    default: "http://localhost:11434", help: "Ollama chat API base URL." },
  { key: "OLLAMA_VLM_MODEL", section: "ollama", type: "text", tier: 1, show: "commented",
    default: "qwen2.5vl:3b", help: "Model used for image understanding." },
  { key: "OLLAMA_NUM_CTX", section: "ollama", type: "number", tier: 1, show: "commented",
    default: "32768",
    help: "Context window (tokens) the app assumes for its trim/cap math. The real KV cache is sized by the server's OLLAMA_CONTEXT_LENGTH; Aperio passes this through when it starts Ollama for you. Bigger is NOT free — keep it within VRAM (16384–32768 suits a 7–12B model)." },
  { key: "OLLAMA_CONTEXT_LENGTH", section: "ollama", type: "number", tier: 1, show: "commented",
    default: "32768",
    help: "Server-side KV cache size. If you run `ollama serve` yourself, launch it with this matching OLLAMA_NUM_CTX." },
  { key: "OLLAMA_HOST", section: "ollama", type: "text", tier: 1, show: "commented",
    default: "http://localhost:11434",
    help: "Used by the auto start/stop helper; prefer OLLAMA_BASE_URL. Set only if your Ollama host differs." },

  // ── gemini ──────────────────────────────────────────────────
  { key: "GEMINI_THINKING_BUDGET", section: "gemini", type: "number", tier: 1, show: "commented",
    default: "0", help: "Tokens reserved for reasoning. 0 = off. Range when on: 512–24576." },

  // ── roundtable ──────────────────────────────────────────────
  { key: "ROUNDTABLE_AGENTS", section: "roundtable", type: "text", tier: 1, show: "commented",
    default: "", example: "anthropic:claude-haiku-4-5-20251001,deepseek:deepseek-chat",
    help: "<provider>:<model>,<provider>:<model> — first = answerer, second = reviewer." },
  { key: "ROUNDTABLE_CHARACTERS", section: "roundtable", type: "text", tier: 1, show: "commented",
    default: "", example: "software-architect,code-reviewer",
    help: "Domain characters layered on each agent's role. \"charA,charB\" — first → answerer, second → reviewer.\nE.g. security audit: software-architect,security-engineer." },
  { key: "ROUNDTABLE_MAX_ROUNDS", section: "roundtable", type: "number", tier: 1, show: "commented",
    default: "3", help: "Max review/revise rounds before giving up on agreement." },

  // ── wiki ────────────────────────────────────────────────────
  { key: "WIKI_REFRESH_PROVIDER", section: "wiki", type: "text", tier: 1, show: "commented",
    default: "", example: "ollama:llama3.1",
    help: "<provider>:<model> to regenerate stale wiki articles with instead of the chat model. Unset disables (serves the stale body)." },
  { key: "WIKI_REFRESH_AUTOSTART_OLLAMA", section: "wiki", type: "boolean", tier: 1, show: "set",
    default: "true", help: "Only honored for ollama: spawn `ollama serve` on first refresh if down." },

  // ── embeddings ──────────────────────────────────────────────
  { key: "EMBEDDING_PROVIDER", section: "embeddings", type: "select", tier: 1, show: "commented",
    default: "transformers", options: ["transformers", "voyage"],
    help: "transformers (default, fully local, no key) | voyage (cloud). transformers downloads mxbai-embed-large-v1 on first run." },
  { key: "EMBEDDING_DIMS", section: "embeddings", type: "number", tier: 1, show: "commented",
    default: "1024", help: "Vector size. Must match your embedding model; changing it requires a fresh database." },
  { key: "VOYAGE_API_KEY", section: "embeddings", type: "secret", tier: 1, show: "commented",
    default: "", example: "pa-xxxxx-xxxx", help: "Voyage key — dash.voyageai.com (50M tokens/month free). Only needed when EMBEDDING_PROVIDER=voyage." },
  { key: "VOYAGE_MODEL", section: "embeddings", type: "text", tier: 1, show: "commented",
    default: "voyage-3", help: "Voyage embedding model (used when EMBEDDING_PROVIDER=voyage)." },
  { key: "TRANSFORMERS_CACHE", section: "embeddings", type: "path", tier: 1, show: "commented",
    default: "~/.cache/aperio/transformers", help: "Local model cache directory for the transformers embedder." },
  { key: "APERIO_SKILL_SEMANTIC", section: "embeddings", type: "boolean", tier: 1, show: "commented",
    default: "", example: "on",
    help: "Semantic skill-match rescue: when keyword matching finds no skill for a turn, fall back to embedding similarity so paraphrases still attach the right skill. Fills blanks only — never overrides a keyword match. Requires an embedder (EMBEDDING_PROVIDER). on to enable." },
  { key: "APERIO_SKILL_SEMANTIC_FLOOR", section: "embeddings", type: "number", tier: 1, show: "commented",
    default: "", help: "Cosine floor for the semantic skill rescue. Empty = per-provider default (transformers 0.54; voyage not yet calibrated — run skills/autotune/calibrate.mjs with your key and set this). Higher = fewer, more confident matches." },

  // ── github ──────────────────────────────────────────────────
  { key: "GITHUB_TOKEN", section: "github", type: "secret", tier: 1, show: "commented",
    default: "", example: "ghp_xxxxxxxxxxxxxxxxxxxx",
    help: "Personal access token for the github tools. Read needs no token for public repos; write (create/update issue) requires a `repo`-scoped token. github.com/settings/tokens" },
  { key: "GITHUB_WEBHOOK_SECRET", section: "github", type: "secret", tier: 1, show: "commented",
    default: "",
    help: "Shared secret for the issue-triage webhook (POST /api/github/webhook). When set, deliveries are HMAC-verified; unset, the route refuses all requests (503). The daily triage job also polls, so the webhook is optional." },

  // ── code & document graph ───────────────────────────────────
  { key: "APERIO_CODEGRAPH", section: "graph", type: "boolean", tier: 1, show: "commented",
    default: "", example: "on", help: "Build a symbol/reference index of the workspace. Off unless set to exactly 'on'." },
  { key: "APERIO_DOCGRAPH", section: "graph", type: "boolean", tier: 1, show: "commented",
    default: "", example: "on", help: "Build a document index (MD/TXT/HTML/PDF/DOCX/XLSX/PPTX/EML). Off unless set to exactly 'on'." },
  { key: "DOCGRAPH_CHUNK_TOKENS", section: "graph", type: "number", tier: 1, show: "commented",
    default: "512", help: "Target chunk size (tokens) for document indexing." },
  { key: "DOCGRAPH_CHUNK_OVERLAP", section: "graph", type: "number", tier: 1, show: "commented",
    default: "64", help: "Token overlap between adjacent document chunks." },
  { key: "DOCGRAPH_XLSX_MAX_ROWS", section: "graph", type: "number", tier: 1, show: "commented",
    default: "2000", help: "Max rows read per spreadsheet during document indexing." },
  { key: "DOCGRAPH_REF_PATTERNS", section: "graph", type: "list", tier: 1, show: "commented",
    default: "", example: "\\bACME-\\d+\\b",
    help: "Extra regex patterns (comma-separated) for cross-reference extraction, e.g. ticket IDs." },

  // ── database tool (SQL connections) ─────────────────────────
  { key: "DB_CONNECTIONS", section: "dbtools", type: "text", tier: 1, show: "commented",
    default: "", example: '[{"name":"shop","engine":"postgres","host":"localhost","port":5432,"database":"shop","user":"ro","password":"secret","readOnly":true}]',
    help: "Advanced/headless seed: a JSON array of database connections for the db_* tools. Normally you add these in Settings → Database connections (passwords are encrypted at rest there). Connections saved in the UI take precedence over names listed here. The built-in 'aperio' connection (your own store, read-only) always exists and is not listed here." },

  // ── background agents ───────────────────────────────────────
  { key: "APERIO_AGENT_JOBS", section: "agents", type: "boolean", tier: 1, show: "commented",
    default: "off", example: "on",
    help: "Master switch for the background-agent scheduler. 'on' runs enabled jobs in var/agents/jobs.json on their interval. Off by default — nothing fires. See docs/background-agents.md." },
  { key: "AGENT_RUN_RETENTION_DAYS", section: "agents", type: "number", tier: 1, show: "commented",
    default: "0", example: "30",
    help: "Days of background-agent run history to keep (GC'd daily). Unset or 0 keeps it forever; runs are also deletable in the UI." },
  { key: "APERIO_INJECT_CLOCK", section: "agents", type: "boolean", tier: 1, show: "commented",
    default: "on", example: "off",
    help: "Inject the current date & time into the system prompt each turn, so the agent knows 'now' and can tell when its training data is stale. Set to 'off' to omit it." },
  { key: "APERIO_CLOCK_TZ", section: "agents", type: "text", tier: 1, show: "commented",
    default: "", example: "Europe/Sofia",
    help: "IANA timezone for the injected clock (e.g. 'America/New_York'). Empty uses the host system timezone." },

  // ── timeouts ────────────────────────────────────────────────
  { key: "DEEPSEEK_FETCH_TIMEOUT_MS", section: "timeouts", type: "number", tier: 1, show: "commented",
    default: "300000", help: "DeepSeek API request timeout." },
  { key: "OLLAMA_FETCH_TIMEOUT_MS", section: "timeouts", type: "number", tier: 1, show: "commented",
    default: "300000", help: "Ollama generate request timeout." },
  { key: "OLLAMA_HEALTH_TIMEOUT_MS", section: "timeouts", type: "number", tier: 1, show: "commented",
    default: "3000", help: "Ollama up/down health-check timeout." },

  // ── logging ─────────────────────────────────────────────────
  { key: "APERIO_LOG_RETENTION", section: "logging", type: "text", tier: 1, show: "commented",
    default: "30d", help: "How long to keep rotated log files (e.g. 7d, 30d, 14d)." },
  { key: "DEBUG", section: "logging", type: "boolean", tier: 1, show: "commented",
    default: "", example: "1", help: "Surface subprocess stderr that is hidden by default." },

  // ── server ──────────────────────────────────────────────────
  { key: "HOST", section: "server", type: "text", tier: 0, show: "commented",
    default: "127.0.0.1", example: "0.0.0.0",
    help: "Default 127.0.0.1 (loopback only — safe). Set 0.0.0.0 for LAN access only if you understand the risks." },
  { key: "IDLE_TIMEOUT_SECONDS", section: "server", type: "number", tier: 1, show: "set",
    default: "180", help: "Server + Ollama shut down this many seconds after the last tab closes." },
  { key: "HEARTBEAT_INTERVAL_SECONDS", section: "server", type: "number", tier: 1, show: "set",
    default: "120", help: "How often the browser pings to say a tab is still open (< IDLE_TIMEOUT)." },
  { key: "SESSION_RETENTION_DAYS", section: "server", type: "number", tier: 1, show: "set",
    default: "14", help: "Days of chat history to keep." },

  // ── network security ────────────────────────────────────────
  { key: "APERIO_ALLOWED_HOSTS", section: "network", type: "list", tier: 0, show: "commented",
    default: "", example: "aperio.lan,192.168.1.50",
    help: "Extra hostnames accepted by the Host-header / DNS-rebinding guard (comma-separated). Add these if you reach Aperio via a reverse proxy or LAN name." },
  { key: "APERIO_AUTH_TOKEN", section: "network", type: "secret", tier: 0, show: "commented",
    default: "",
    help: "Opt-in shared-secret auth. When set, every /api request and WebSocket must present it (Authorization: Bearer, X-Aperio-Token, or ?token=). Set a long random value before exposing Aperio on a network." },
  { key: "APERIO_CLOUD_MEMORY_WORKERS", section: "network", type: "boolean", tier: 1, show: "commented",
    default: "", example: "1",
    help: "By default the memory inference/dedup workers run only on local Ollama. Set to 1 to let them run on a cloud provider too (your memories get sent to it)." },
  { key: "APERIO_ALLOW_INTERNAL_FETCH", section: "network", type: "boolean", tier: 1, show: "commented",
    default: "", example: "1",
    help: "Allow the fetch_url tool to reach private/loopback addresses (SSRF guard off). Leave unset unless you specifically need it." },
  { key: "APERIO_EGRESS_ALLOWLIST", section: "network", type: "list", tier: 1, show: "commented",
    default: "", example: "api.github.com,example.com",
    help: "Restrict outbound fetches to these hosts (comma-separated). Unset = no allowlist restriction." },
  { key: "APERIO_PROVIDER_LOCAL", section: "network", type: "boolean", tier: 1, show: "commented",
    default: "", example: "1",
    help: "Advanced: force the active provider to be treated as local (affects tool/memory gating)." },
  { key: "APERIO_ALLOW_DEFAULT_DB_PASSWORD", section: "network", type: "boolean", tier: 0, show: "commented",
    default: "", example: "1",
    help: "Advanced: bypass the startup refusal to run Postgres with the shipped default password. Do NOT set in production." },

  // ── hosting hardening ───────────────────────────────────────
  { key: "APERIO_TLS_CERT", section: "hosting", type: "path", tier: 0, show: "commented",
    default: "", example: "/path/to/cert.pem",
    help: "Opt-in TLS. Set BOTH cert + key (PEM) to serve HTTPS; leave both unset for plain HTTP on loopback. Aperio does not generate certs." },
  { key: "APERIO_TLS_KEY", section: "hosting", type: "path", tier: 0, show: "commented",
    default: "", example: "/path/to/key.pem", help: "TLS private key (PEM). See APERIO_TLS_CERT." },
  { key: "APERIO_SESSION_KEY", section: "hosting", type: "secret", tier: 0, show: "commented",
    default: "",
    help: "Opt-in at-rest session encryption (AES-256-GCM). When set, session transcripts are encrypted on disk; existing plaintext still loads." },
  { key: "APERIO_BROWSER", section: "hosting", type: "select", tier: 1, show: "commented",
    default: "firefox",
    options: ["firefox", "firefox-dev", "librewolf", "mullvad", "chrome", "chromium", "brave", "edge", "tor", "ddg", "default"],
    help: "Which browser to open the UI in on startup (a private/incognito window). Falls back to the OS default if not installed. Use 'default' to skip the private window." },
  { key: "APERIO_BROWSER_ISOLATED", section: "hosting", type: "boolean", tier: 1, show: "commented",
    default: "", example: "1",
    help: "Launch the chosen browser with a dedicated profile under var/browser-profiles/<browser>, isolating Aperio's cookies/storage/extensions. Ignored for tor/ddg." },
];
