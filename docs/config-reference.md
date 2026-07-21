# Aperio configuration reference

<!-- AUTO-GENERATED from lib/config.js — do not edit by hand. Run `npm run gen:env`. -->

Every variable Aperio reads, grouped as in the app. Most are managed in the
app's **Settings** and saved to the database; all of them also work as lines
in `.env`. By default a value saved in Settings wins (`APERIO_CONFIG_PRECEDENCE=db`);
set `APERIO_CONFIG_PRECEDENCE=env` in `.env` to make every line written in the
file win instead — however few lines it holds. Tier-0 keys are read before the
database opens and therefore live in `.env` only.

## 1 · START HERE — safe to edit

The few values most setups actually touch. Pick a provider and paste its key (or use the local llama.cpp engine), then choose a model and port.

### ESSENTIALS

The few values most setups need to get started.

#### `AI_PROVIDER`

select · tier 1 (Settings UI, restart to apply) · default: *(unset)* · options: `anthropic | deepseek | gemini | llamacpp | claude-code | codex`

Which AI backend to use.
• anthropic / deepseek / gemini → cloud; paste the matching API key below.
• llamacpp → free, runs on your machine via a vendored llama-server (no key).
• claude-code → uses your Claude Pro/Max subscription via the Agent SDK (requires the `claude` CLI logged in; do NOT also set ANTHROPIC_API_KEY).
• codex → uses the Codex CLI (`codex login` or CODEX_API_KEY for exec automation).

#### `ANTHROPIC_API_KEY`

secret · tier 1 (Settings UI, restart to apply) · default: *(unset)*

Anthropic — console.anthropic.com

#### `ANTHROPIC_MODEL`

text · tier 1 (Settings UI, restart to apply) · default: `claude-haiku-4-5-20251001`

#### `DEEPSEEK_API_KEY`

secret · tier 1 (Settings UI, restart to apply) · default: *(unset)*

DeepSeek — platform.deepseek.com

#### `DEEPSEEK_MODEL`

text · tier 1 (Settings UI, restart to apply) · default: `deepseek-v4-flash`

#### `GEMINI_API_KEY`

secret · tier 1 (Settings UI, restart to apply) · default: *(unset)*

Google Gemini — aistudio.google.com

#### `GEMINI_MODEL`

text · tier 1 (Settings UI, restart to apply) · default: `gemini-2.0-flash`

#### `OPENAI_API_KEY`

secret · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

OpenAI key (only if you wire an OpenAI-compatible provider).

#### `CODEX_MODEL`

text · tier 1 (Settings UI, restart to apply) · default: `gpt-5.5` · advanced

Codex model when AI_PROVIDER=codex.

#### `CODEX_API_KEY`

secret · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Optional API-key auth for `codex exec`; otherwise Codex uses cached CLI auth. Use Codex only in a trusted workspace: agent-run code can inherit process credentials.

#### `CODEX_SANDBOX`

select · tier 1 (Settings UI, restart to apply) · default: `workspace-write` · options: `read-only | workspace-write | danger-full-access` · advanced

Codex sandbox when AI_PROVIDER=codex. Prefer workspace-write unless the host is externally isolated.

#### `CODEX_APPROVAL_POLICY`

select · tier 1 (Settings UI, restart to apply) · default: `never` · options: `untrusted | on-request | never` · advanced

Codex approval policy for non-interactive provider runs. `never` avoids stalled UI prompts; pair it with a sandbox. Aperio's required MCP server is explicitly approved separately.

#### `CODEX_MCP_APPROVAL_MODE`

select · tier 1 (Settings UI, restart to apply) · default: `approve` · options: `auto | prompt | approve` · advanced

Tool-approval mode for Aperio's MCP server inside Codex runs. `approve` marks this explicitly configured, required server as trusted (needed because approval_policy=never cannot answer an MCP prompt).

#### `CODEX_MCP_STARTUP_TIMEOUT_SEC`

number · tier 1 (Settings UI, restart to apply) · default: `20` · advanced

Seconds Codex waits for Aperio's MCP server to start before failing the run.

#### `CODEX_MCP_TOOL_TIMEOUT_SEC`

number · tier 1 (Settings UI, restart to apply) · default: `300` · advanced

Per-tool-call timeout (seconds) for Aperio's MCP server inside Codex runs.

#### `CODEX_IGNORE_RULES`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Pass --ignore-rules to `codex exec` so repo rule files (AGENTS.md etc.) are skipped for provider runs.

#### `CODEX_REASONING_SUMMARY`

select · tier 1 (Settings UI, restart to apply) · default: `auto` · options: `auto | concise | detailed | none` · advanced

Codex reasoning-summary verbosity. `auto`/`concise`/`detailed` make the CLI emit `reasoning` items that Aperio renders as the collapsed thinking bubble (same UI as every other provider); `none` disables it. Doesn't add API cost — it's a summary of tokens already billed as reasoning_output_tokens.

#### `CLAUDE_CODE_OAUTH_TOKEN`

secret · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Alternative to running `claude` interactively when AI_PROVIDER=claude-code.

#### `PORT`

number · tier 0 (bootstrap — .env only) · default: `3000`

Port the web app runs on.

#### `APERIO_LITE`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Lite profile for non-technical users (the desktop launchers set it). When on: the non-coder starter memory set is seeded on first boot, unset values default to the local llama.cpp engine + SQLite with the document index on, the web UI hides developer surfaces (code graph, DB browser, agents, skills, deep config) behind an Advanced toggle in Settings, and config precedence is always 'db' — the Settings UI rules; .env only spins the app up. Off unless set to exactly 'on'.

#### `APERIO_CONFIG_PRECEDENCE`

select · tier 0 (bootstrap — .env only) · default: `db` · options: `db | env` · advanced

Who wins when a setting is in BOTH the Settings UI (DB) and your .env:
• db (default) → the Settings UI is authoritative; a saved value overrides .env, so you manage everything from the app without editing files.
• env → the developer escape hatch: every line you write in .env wins, however few lines it holds. Settings that are ONLY in the DB (no .env entry) still apply — env mode overrides, it does not ignore the DB. This is also how to keep API keys file-only.
Readable from .env (so it can force itself) and editable in the Settings UI.
Ignored when APERIO_LITE=on: the lite profile is always 'db' (lite users configure everything in the UI; .env only spins the app up).

## 2 · OPTIONAL FEATURES

Extra capabilities, all off or at their default until you turn them on. These are normally toggled in the app's Settings panel (saved to the database); they're listed here for headless / file-only setups. By default (APERIO_CONFIG_PRECEDENCE=db) a value saved in the UI wins; set it to env to make what you write here win instead.

### File path safety

Seed-only: these populate the allowed-folders list on first run, then it's edited in the UI and persisted in the DB.

#### `APERIO_ALLOWED_PATHS_TO_READ`

list · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Seed only. Comma-separated absolute paths that populate the allowed read-folders list on first run; edited in the UI thereafter. Project dir + session scratch are always allowed.

#### `APERIO_ALLOWED_PATHS_TO_WRITE`

list · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Seed only. As above, for write access.

### Shell execution (run_shell tool)

Lets the model run a single allowlisted shell command inside the session workspace. NOT a sandbox — off by default.

#### `APERIO_ENABLE_SHELL`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)*

Allow the run_shell tool (single allowlisted command in the session workspace). NOT a sandbox — grants host execution as your user. Only enable for trusted models/content.

#### `APERIO_SHELL_LOCAL`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

By default only cloud providers get run_shell. Set to also offer it to the local llama.cpp model.

#### `APERIO_SHELL_MAX_OUTPUT_BYTES`

number · tier 1 (Settings UI, restart to apply) · default: `48000` · advanced

Max bytes of shell output captured before truncation.

### Capable local models

Local llama.cpp models are lean chat models by default; list trusted ones to grant them tools + memory.

#### `APERIO_CAPABLE_MODELS`

list · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Comma-separated local model names you trust to get the full tools + memory flow (others stay lean chat models).

#### `APERIO_RECALL_SCAFFOLD_MODELS`

list · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Comma-separated local model names that still need forced auto-recall (a behavior override, not just the recall pointer). Falls back to APERIO_CAPABLE_MODELS when unset. Remove a model from this list once it reliably calls recall on its own, without losing tools/memory from APERIO_CAPABLE_MODELS.

#### `APERIO_SMALL_WINDOW_TOKENS`

number · tier 1 (Settings UI, restart to apply) · default: `8192` · advanced

Context windows at or below this token count are treated as small: the per-turn tool set is capped so re-sent tool schemas don't crowd out the result and reasoning the model needs. Larger windows are never touched.

#### `APERIO_SMALL_WINDOW_MAX_TOOLS`

number · tier 1 (Settings UI, restart to apply) · default: `10` · advanced

Maximum tools attached per turn on a small-window model (see APERIO_SMALL_WINDOW_TOKENS). The recall floor and the turn's intent tools are kept first.

### Tool-call safety

Tools treated as destructive get strict handling: malformed JSON arguments are never auto-repaired (a 'fixed' string could silently corrupt a file or row) and a failed call returns a plain error instead of a coercion hint. The built-in list (write_file, edit_file, db_execute, run_shell, …) can't be weakened; you can only extend it.

#### `APERIO_EXTRA_DESTRUCTIVE_TOOLS`

list · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Comma-separated EXTRA tool names to treat as destructive, added to the built-in set. Use for your own / MCP tools that mutate state. Built-ins can't be removed — this only adds stricter handling.

#### `APERIO_TOOL_RESULT_OFFLOAD_TOKENS`

number · tier 1 (Settings UI, restart to apply) · default: `20000` · advanced

Store a complete tool result outside model context when it exceeds this token count. Aperio lowers the effective threshold to 25% of the active model context window. 0 disables the token threshold; the byte threshold still applies.

#### `APERIO_TOOL_RESULT_OFFLOAD_BYTES`

number · tier 1 (Settings UI, restart to apply) · default: `80000` · advanced

Store a complete tool result outside model context when its redacted UTF-8 content exceeds this byte count. 0 disables the byte threshold; the token threshold still applies. Stored session artifacts follow SESSION_RETENTION_DAYS; background-run artifacts follow AGENT_RUN_RETENTION_DAYS.

### llama.cpp (local) extras

Defaults shown — override only if your llama-server setup differs.

#### `LLAMACPP_PORT`

number · tier 1 (Settings UI, restart to apply) · default: `8080` · advanced

Port the vendored llama-server listens on (127.0.0.1 only).

#### `LLAMACPP_BASE_URL`

text · tier 1 (Settings UI, restart to apply) · default: `http://127.0.0.1:8080` · advanced

llama-server chat API base URL.

#### `LLAMACPP_MODEL`

text · tier 1 (Settings UI, restart to apply) · default: `Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M`

Hugging Face repo[:quant] for the main model (llama-server -hf format). Becomes the hf-repo of the router's `aperio-main` preset entry; requests send that stable alias as the `model` field (not the raw repo id, which would load a second, full-context copy).

#### `LLAMACPP_MODEL_TIER_8`

text · tier 1 (Settings UI, restart to apply) · default: `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL` · advanced

Recommended llama.cpp model for machines with up to 8 GB RAM (Hugging Face repo[:quant]).

#### `LLAMACPP_MODEL_TIER_16`

text · tier 1 (Settings UI, restart to apply) · default: `unsloth/Qwen3.5-9B-GGUF:Q4_K_M` · advanced

Recommended llama.cpp model for machines with more than 8 GB and up to 16 GB RAM (Hugging Face repo[:quant]).

#### `LLAMACPP_MODEL_TIER_24`

text · tier 1 (Settings UI, restart to apply) · default: `unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL` · advanced

Recommended llama.cpp model for machines with more than 16 GB and up to 24 GB RAM (Hugging Face repo[:quant]).

#### `LLAMACPP_MODEL_TIER_32`

text · tier 1 (Settings UI, restart to apply) · default: `unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL` · advanced

Recommended llama.cpp model for machines with more than 24 GB RAM (Hugging Face repo[:quant]).

#### `LLAMACPP_VLM_MODEL`

text · tier 1 (Settings UI, restart to apply) · default: `ggml-org/Qwen2.5-VL-7B-Instruct-GGUF` · advanced

Hugging Face repo[:quant] used for image understanding; llama-server's router loads/swaps it on demand.

#### `LLAMACPP_CTX`

number · tier 1 (Settings UI, restart to apply) · default: `32768` · advanced

Context window (tokens) the app assumes for its trim/cap math. Successor of OLLAMA_NUM_CTX. The real KV cache is sized by LLAMACPP_SERVE_CTX (the model's --ctx-size in the router preset); Aperio passes this through when it starts llama-server for you.

#### `LLAMACPP_SERVE_CTX`

number · tier 1 (Settings UI, restart to apply) · default: `32768` · advanced

Successor of OLLAMA_CONTEXT_LENGTH. Server-side KV cache size (--ctx-size) for the main model in the router preset.

#### `LLAMA_CACHE`

path · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Override where llama-server caches downloaded GGUF weights. Leave unset to use the standard Hugging Face hub cache (HF_HUB_CACHE, else $HF_HOME/hub, else ~/.cache/huggingface/hub) — the same location llama-cli and every other HF tool use, so models you already have are reused instead of re-downloaded into the app folder. Set a path only to force a non-standard location.

#### `LLAMACPP_CHECK_UPDATES`

select · tier 1 (Settings UI, restart to apply) · default: `off` · options: `off | on` · advanced

off (default): when every model in the router preset is already cached, llama-server starts with --offline, so it never re-checks Hugging Face on load — an upstream re-upload of the same repo can't trigger a surprise multi-GB re-download mid-conversation. on: revalidate against Hugging Face on every model load and pull upstream updates. Models not yet cached are always downloaded regardless of this setting.

#### `APERIO_LOCAL_PERF_PROFILE`

select · tier 1 (Settings UI, restart to apply) · default: `balanced` · options: `balanced | fast-low-vram | long-context | quality` · advanced

Hardware/perf preset for the local llama.cpp engine. balanced (default) = current sizing, unchanged. fast-low-vram = lower context ceiling, quantized KV cache (-ctk/-ctv q8_0), flash attention, a MoE-preferred model pick, MoE expert layers offloaded to CPU (--n-cpu-moe), and only one resident model at a time (--models-max 1) — the biggest speed win on tight VRAM. long-context = raised context ceiling and a larger share of RAM committed to the KV cache; trades throughput for a bigger window — expect noticeably slower tokens/sec. quality = the biggest model your RAM allows, accepting slower tokens/sec.

### Extended thinking budgets

Tokens reserved for reasoning on providers that charge for it. 0 = off.

#### `GEMINI_THINKING_BUDGET`

number · tier 1 (Settings UI, restart to apply) · default: `0` · advanced

Tokens reserved for reasoning. 0 = off. Range when on: 512–24576.

#### `ANTHROPIC_THINKING_BUDGET`

number · tier 1 (Settings UI, restart to apply) · default: `0` · advanced

Tokens reserved for Claude's extended thinking. 0 = off (default — thinking tokens are billed output). Range when on: 1024–24576. Reasoning streams as a collapsed bubble like every other provider.

### Round-table mode (two-agent cross-review)

Boots a second verifier agent that reviews/revises answers until both agree or the round cap.

#### `ROUNDTABLE_AGENTS`

text · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

<provider>:<model>,<provider>:<model> — first = answerer, second = reviewer.

#### `ROUNDTABLE_CHARACTERS`

text · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Domain characters layered on each agent's role. "charA,charB" — first → answerer, second → reviewer.
E.g. security audit: software-architect,security-engineer.

#### `ROUNDTABLE_MAX_ROUNDS`

number · tier 1 (Settings UI, restart to apply) · default: `3` · advanced

Max review/revise rounds before giving up on agreement.

### Wiki refresh provider

Regenerate stale wiki articles with a cheaper/local provider instead of the chat model.

#### `WIKI_REFRESH_PROVIDER`

text · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

<provider>:<model> to regenerate stale wiki articles with instead of the chat model. Unset disables (serves the stale body).

#### `WIKI_REFRESH_AUTOSTART_LLAMACPP`

boolean · tier 1 (Settings UI, restart to apply) · default: `true` · advanced

Only honored for llamacpp: start the vendored llama-server on first refresh if down.

### Embeddings

transformers (local, no key) or voyage (cloud). EMBEDDING_DIMS must match the model — changing it needs a fresh DB.

#### `EMBEDDING_PROVIDER`

select · tier 1 (Settings UI, restart to apply) · default: `transformers` · options: `transformers | voyage`

transformers (default, fully local, no key) | voyage (cloud). transformers downloads mxbai-embed-large-v1 on first run.

#### `EMBEDDING_DIMS`

number · tier 1 (Settings UI, restart to apply) · default: `1024` · advanced

Vector size. Must match your embedding model; changing it requires a fresh database.

#### `VOYAGE_API_KEY`

secret · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Voyage key — dash.voyageai.com (50M tokens/month free). Only needed when EMBEDDING_PROVIDER=voyage.

#### `VOYAGE_MODEL`

text · tier 1 (Settings UI, restart to apply) · default: `voyage-3` · advanced

Voyage embedding model (used when EMBEDDING_PROVIDER=voyage).

#### `TRANSFORMERS_CACHE`

path · tier 1 (Settings UI, restart to apply) · default: `~/.cache/aperio/transformers` · advanced

Local model cache directory for the transformers embedder.

#### `APERIO_SKILL_SEMANTIC`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Semantic skill-match rescue: when keyword matching finds no skill for a turn, fall back to embedding similarity so paraphrases still attach the right skill. Fills blanks only — never overrides a keyword match. Requires an embedder (EMBEDDING_PROVIDER). on to enable.

#### `APERIO_SKILL_SEMANTIC_FLOOR`

number · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Cosine floor for the semantic skill rescue. Empty = per-provider default (transformers 0.54; voyage not yet calibrated — run skills/autotune/calibrate.mjs with your key and set this). Higher = fewer, more confident matches.

### Code & document graph

Symbol/reference index of the workspace + document index so the model can navigate code and docs.

#### `APERIO_CODEGRAPH`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)*

Build a symbol/reference index of the workspace. Off unless set to exactly 'on'.

#### `APERIO_DOCGRAPH`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)*

Build a document index (MD/TXT/HTML/PDF/DOCX/XLSX/PPTX/EML). Off unless set to exactly 'on' (the lite profile turns it on by default).

#### `DOCGRAPH_CHUNK_TOKENS`

number · tier 1 (Settings UI, restart to apply) · default: `512` · advanced

Target chunk size (tokens) for document indexing.

#### `DOCGRAPH_CHUNK_OVERLAP`

number · tier 1 (Settings UI, restart to apply) · default: `64` · advanced

Token overlap between adjacent document chunks.

#### `DOCGRAPH_XLSX_MAX_ROWS`

number · tier 1 (Settings UI, restart to apply) · default: `2000` · advanced

Max rows read per spreadsheet during document indexing.

#### `DOCGRAPH_REF_PATTERNS`

list · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Extra regex patterns (comma-separated) for cross-reference extraction, e.g. ticket IDs.

### Background agents (scheduled, chat-less jobs)

Master switch for the background-agent scheduler and how long run history is kept.

#### `APERIO_AGENT_JOBS`

boolean · tier 1 (Settings UI, restart to apply) · default: `off` · advanced

Master switch for the background-agent scheduler. 'on' runs enabled jobs in var/agents/jobs.json on their interval. Off by default — nothing fires. See docs/background-agents.md.

#### `AGENT_RUN_RETENTION_DAYS`

number · tier 1 (Settings UI, restart to apply) · default: `0` · advanced

Days of background-agent run history to keep (GC'd daily). Unset or 0 keeps it forever; runs are also deletable in the UI.

### Privacy

How sensitive memories are handled when a cloud provider is active.

#### `APERIO_CLOUD_SENSITIVE_MODE`

select · tier 1 (Settings UI, restart to apply) · default: `withhold` · options: `withhold | redact`

How to handle tier-2 (sensitive) memories on cloud providers. 'withhold' (default) filters them out of recall results. 'redact' sends them with PII scrubbed. Tier-3 (private) is always withheld; tier-1 (normal) is always shared.

### Request timeouts (advanced)

Milliseconds. Raise if big local models or slow networks time out.

#### `DEEPSEEK_FETCH_TIMEOUT_MS`

number · tier 1 (Settings UI, restart to apply) · default: `300000` · advanced

DeepSeek API request timeout.

#### `LLAMACPP_FETCH_TIMEOUT_MS`

number · tier 1 (Settings UI, restart to apply) · default: `300000` · advanced

llama.cpp generate request timeout.

#### `LLAMACPP_HEALTH_TIMEOUT_MS`

number · tier 1 (Settings UI, restart to apply) · default: `3000` · advanced

llama.cpp up/down health-check timeout.

#### `LLAMACPP_VLM_TIMEOUT_MS`

number · tier 1 (Settings UI, restart to apply) · default: `300000` · advanced

Timeout for the local VLM image-analysis bridge (LLAMACPP_VLM_MODEL).

#### `CODEX_COMPLETION_TIMEOUT_MS`

number · tier 1 (Settings UI, restart to apply) · default: `120000` · advanced

Timeout for one-shot `codex exec` completions (read-only helper calls, not the chat loop).

### Logging & diagnostics

#### `APERIO_LOG_RETENTION`

text · tier 1 (Settings UI, restart to apply) · default: `30d` · advanced

How long to keep rotated log files (e.g. 7d, 30d, 14d).

#### `LLAMACPP_LOG_RETENTION_DAYS`

number · tier 1 (Settings UI, restart to apply) · default: `1` · advanced

Days to keep per-session llama-server debug logs (var/llamacpp/<session-id>.log). Pruned daily; minimum 1.

#### `DEBUG`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Surface subprocess stderr that is hidden by default.

#### `APERIO_NO_LLAMA_LOG`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Suppress the shared llama-server log file. Session-scoped logs are still controlled by the retention setting.

## 3 · EXTERNAL INTEGRATIONS — keys & endpoints

Credentials and connection details for third-party services. Leave blank to keep the integration off.

### GitHub integration

Token + webhook secret for the issue-triage tools. Both can also be set in the app (Settings → GitHub triage).

#### `GITHUB_TOKEN`

secret · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Personal access token for the github tools. Read needs no token for public repos; write (create/update issue) requires a `repo`-scoped token. github.com/settings/tokens

#### `GITHUB_WEBHOOK_SECRET`

secret · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Shared secret for the issue-triage webhook (POST /api/github/webhook). When set, deliveries are HMAC-verified; unset, the route refuses all requests (503). The daily triage job also polls, so the webhook is optional.

### Database tool (SQL connections)

Named connections the db_* tools can query (SQLite/Postgres/MySQL/SQL Server + the built-in 'aperio' store). Normally added in Settings → Database connections; the env var below is a headless seed.

#### `DB_CONNECTIONS`

text · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Advanced/headless seed: a JSON array of database connections for the db_* tools. Normally you add these in Settings → Database connections (passwords are encrypted at rest there). Connections saved in the UI take precedence over names listed here. The built-in 'aperio' connection (your own store, read-only) always exists and is not listed here.

## 4 · CORE / CRITICAL — bootstrap & security

Read at startup before the database opens, so these MUST live in .env (the UI can't manage them). Wrong values can stop Aperio from starting or expose it on a network — change only with intent.

### Database (bootstrap)

How and where Aperio stores its data. Read at startup before anything else, so these stay in .env.

#### `DB_BACKEND`

select · tier 0 (bootstrap — .env only) · default: `sqlite` · options: `sqlite | postgres`

'postgres' (Docker required) | 'sqlite' (zero-config, default).
Default: auto-detect — Postgres if Docker is running, else SQLite.

#### `SQLITE_PATH`

path · tier 0 (bootstrap — .env only) · default: `./.sqlite/aperio.db`

Where SQLite stores data (default shown).

#### `APERIO_DB_ENCRYPT`

boolean · tier 0 (bootstrap — .env only) · default: *(unset)*

Encrypt the SQLite database file on disk with AES-256-GCM. Key lives in your OS keychain. Off by default; SQLite only.

### Postgres

Only used when DB_BACKEND=postgres (or Docker is detected).

#### `POSTGRES_HOST`

text · tier 0 (bootstrap — .env only) · default: `localhost`

#### `POSTGRES_PORT`

number · tier 0 (bootstrap — .env only) · default: `5432`

#### `POSTGRES_DB`

text · tier 0 (bootstrap — .env only) · default: `aperio`

#### `POSTGRES_USER`

text · tier 0 (bootstrap — .env only) · default: `aperio`

#### `POSTGRES_PASSWORD`

secret · tier 0 (bootstrap — .env only) · default: `aperio_secret`

Change this!

#### `DATABASE_URL`

text · tier 0 (bootstrap — .env only) · default: `postgresql://aperio:aperio_secret@localhost:8008/aperio`

### Server

#### `HOST`

text · tier 0 (bootstrap — .env only) · default: `127.0.0.1`

Default 127.0.0.1 (loopback only — safe). Set 0.0.0.0 for LAN access only if you understand the risks.

#### `IDLE_SHUTDOWN`

select · tier 1 (Settings UI, restart to apply) · default: `auto` · options: `auto | on | off` · advanced

Idle auto-shutdown after the last browser tab closes. 'auto' = on only for the local llama.cpp provider; 'on' = always (the lite desktop launchers set this so a windowless/hidden server still self-stops on any provider); 'off' = never (for always-on server deployments).

#### `IDLE_TIMEOUT_SECONDS`

number · tier 1 (Settings UI, restart to apply) · default: `180` · advanced

Server + llama.cpp engine shut down this many seconds after the last tab closes.

#### `HEARTBEAT_INTERVAL_SECONDS`

number · tier 1 (Settings UI, restart to apply) · default: `60` · advanced

How often the browser pings to say a tab is still open. Keep it well under IDLE_TIMEOUT (≤ 1/3) so a throttled or dropped ping doesn't cause a false shutdown.

#### `SESSION_RETENTION_DAYS`

number · tier 1 (Settings UI, restart to apply) · default: `14`

Days of chat history to keep.

#### `DEFAULT_LOCALE`

text · tier 1 (Settings UI, restart to apply) · default: `en`

Server-side fallback locale when no cookie or Accept-Language match is found. Must match a locale key in public/scripts/i18n.js LOCALE_META.

#### `APERIO_UI_LANG`

text · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Language for the terminal UI. A saved CLI preference wins over this value.

#### `APERIO_CLI_PREFS`

path · tier 1 (Settings UI, restart to apply) · default: `./var/cli-prefs.json` · advanced

Optional path for persisted terminal preferences such as the examples toggle.

### Network security

#### `APERIO_ALLOWED_HOSTS`

list · tier 0 (bootstrap — .env only) · default: *(unset)*

Extra hostnames accepted by the Host-header / DNS-rebinding guard (comma-separated). Add these if you reach Aperio via a reverse proxy or LAN name.

#### `APERIO_CSP`

select · tier 0 (bootstrap — .env only) · default: `on` · options: `on | report | off`

Content-Security-Policy mode. 'on' enforces the browser policy (default), 'report' sends it as report-only during rollout, and 'off' disables CSP temporarily for troubleshooting.

#### `APERIO_AUTH_TOKEN`

secret · tier 0 (bootstrap — .env only) · default: *(unset)*

Opt-in shared-secret auth. When set, every /api request and WebSocket must present it (Authorization: Bearer, X-Aperio-Token, or ?token=). Set a long random value before exposing Aperio on a network.

#### `APERIO_CLOUD_MEMORY_WORKERS`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

By default the memory inference/dedup workers run only on the local llama.cpp provider. Set to 1 to let them run on a cloud provider too (your memories get sent to it).

#### `APERIO_ALLOW_INTERNAL_FETCH`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Allow the fetch_url tool to reach private/loopback addresses (SSRF guard off). Leave unset unless you specifically need it.

#### `APERIO_EGRESS_ALLOWLIST`

list · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Restrict outbound fetches to these hosts (comma-separated). Unset = no allowlist restriction.

#### `APERIO_PROVIDER_LOCAL`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Advanced: force the active provider to be treated as local (affects tool/memory gating).

#### `APERIO_ALLOW_DEFAULT_DB_PASSWORD`

boolean · tier 0 (bootstrap — .env only) · default: *(unset)*

Advanced: bypass the startup refusal to run Postgres with the shipped default password. Do NOT set in production.

### Hosting hardening

#### `APERIO_TLS_CERT`

path · tier 0 (bootstrap — .env only) · default: *(unset)*

Opt-in TLS. Set BOTH cert + key (PEM) to serve HTTPS; leave both unset for plain HTTP on loopback. Aperio does not generate certs.

#### `APERIO_TLS_KEY`

path · tier 0 (bootstrap — .env only) · default: *(unset)*

TLS private key (PEM). See APERIO_TLS_CERT.

#### `APERIO_SESSION_KEY`

secret · tier 0 (bootstrap — .env only) · default: *(unset)*

Opt-in at-rest session encryption (AES-256-GCM). When set, session transcripts are encrypted on disk; existing plaintext still loads.

#### `APERIO_BROWSER`

select · tier 1 (Settings UI, restart to apply) · default: `firefox` · options: `firefox | firefox-dev | librewolf | mullvad | chrome | chromium | brave | edge | tor | ddg | default` · advanced

Which browser to open the UI in on startup (a private/incognito window). Falls back to the OS default if not installed. Use 'default' to skip the private window.

#### `APERIO_BROWSER_ISOLATED`

boolean · tier 1 (Settings UI, restart to apply) · default: *(unset)* · advanced

Launch the chosen browser with a dedicated profile under var/browser-profiles/<browser>, isolating Aperio's cookies/storage/extensions. Ignored for tor/ddg.

#### `APERIO_LOCALES_DIR`

path · tier 1 (Settings UI, restart to apply) · default: `./public/locales` · advanced

Override the directory containing terminal locale JSON files. Intended for relocations and custom bundles.
