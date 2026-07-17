# Aperio — Feature Inventory

Single source of truth for **what exists**. If you add or remove a feature, change it here in the same PR — otherwise it didn't ship.

Last reconciled: 2026-07-16 · Version: 0.67.4

---

## Memory
- Save memories with type (`fact`, `preference`, `project`, `decision`, `solution`, `source`, `person`, `inference`, `workflow`), title, tags, importance, optional `tier` (1=normal, 2=sensitive, 3=private), optional expiry (`remember`)
- Semantic + full-text recall across all memories (`recall`) — accepts `maxTier` to filter by sensitivity
- Update by ID — tombstones old version, regenerates embedding (`update_memory`)
- Delete by ID (`forget`)
- Generate embeddings for memories missing one (`backfill_embeddings`)
- Find and merge near-duplicates by cosine similarity (`deduplicate_memories`)
- **Workflow detection**: after a turn with 2+ successful meaningful action calls, emits a `workflow_suggestion` event prompting the model/user to save the sequence as a `workflow` memory; background reads, recall, and searches are excluded
- **Scope preferences**: preferences tagged `scope:<term>` (e.g. `scope:auth`) inject a system-prompt hint and safely scope `grep_files` from either the original user query or the eventual search pattern

## Self-Memory
- Agent's own walled-off memory store — separate table, never mixed with user memories
- Save notes with title, tags, importance, language, confidence (`self_remember`) — model identity recorded in `generated_by`
- Semantic + full-text recall across own notes (`self_recall`)
- Revise in-place by ID (`self_update`)
- Delete by ID (`self_forget`)
- Local-only: never surfaced on cloud providers

## Wiki
- Create/update LLM-authored, cited articles; upsert by slug, bump revision (`wiki_write`)
- Hybrid full-text + semantic search (`wiki_search`)
- Browse newest-first by tag / status / updated-since (`wiki_list`)
- Fetch full article by slug with breadcrumb + optional stale-refresh (`wiki_get`)

## Code Graph
- tree-sitter symbol/call/import/`extends` extraction — JS/TS/JSX/TSX (+ extended langs)
- One-shot index of a directory (`node lib/codegraph/indexer.js .`)
- Live reindex on save via chokidar watcher (`APERIO_CODEGRAPH=on`)
- Hybrid FTS + semantic symbol search (`code_search`)
- File symbol outline by line (`code_outline`)
- Source slice for a qualified symbol with doc + padding (`code_context`)
- Reverse call graph — who calls this (`code_callers`)
- Forward call graph — what does this call (`code_callees`)
- List indexed repos with file/symbol counts + last-indexed (`code_repos`)
- Multi-repo support, honors `APERIO_ALLOWED_PATHS_TO_READ`
- Backends: Postgres and SQLite

## Doc Graph
- Extract + chunk documents — MD, TXT, HTML, PDF, DOCX, XLSX, PPTX, EML
- One-shot index of a directory (`node lib/docgraph/indexer.js .`)
- Live reindex on save via chokidar watcher (`APERIO_DOCGRAPH=on`)
- Hybrid FTS + semantic chunk search (`doc_search`)
- Document outline by section/heading (`doc_outline`)
- Chunk slice for a document with surrounding context (`doc_context`)
- Cross-document reference extraction — links/citations (`doc_refs`)
- List indexed doc repos with counts + last-indexed (`doc_repos`)
- Backends: Postgres and SQLite

## Databases
- Generic SQL client over named connections — the user's own SQLite / Postgres / MySQL / SQL Server databases **and** Aperio's internal store (the built-in `aperio` connection, read-only)
- List connections without leaking secrets (`db_connections`)
- Introspect tables, columns, indexes, foreign keys (`db_schema`)
- Read path — one read statement, server-side row cap (`db_query`); rejects writes/DDL and multi-statement batches
- Write/DDL path — two-phase confirm-before-write (`db_execute`); rejects reads, multi-statement batches, and read-only connections
- Statement classifier strips comments, rejects multi-statement batches, and escalates data-modifying CTEs/`EXPLAIN ANALYZE` off the free read path
- Read-only by default; reads enforced at the connection level (read-only handle / READ ONLY transaction) as defense in depth; parameters always bound, never interpolated
- Connections configured in **Settings → Database connections** (or `DB_CONNECTIONS` headless seed); passwords field-encrypted at rest (`var/db-connect.key`) and never returned to the browser
- Engines: SQLite, Postgres, MySQL (`mysql2`) and SQL Server (`mssql`) all bundled; the MySQL/SQL Server drivers still import lazily so they only load when used. SQL Server read-only is enforced at the tool level (its row cap uses result streaming, not a TOP/subquery wrapper)

## Files & Documents
- Read text/code file, paginated, 500 lines/call (`read_file`)
- Create/overwrite, write-path guarded (`write_file`)
- Append without touching rest (`append_file`)
- Exact-string replace, `replace_all` option (`edit_file`)
- Two-phase token-confirmed delete (`delete_file`)
- Traverse a project folder — tree + key files (`scan_project`)
- Recursively search allowed code/text files with literal, line-numbered matches (`grep_files`); skips secrets, symlinks, dependencies, build output, and files over 500 KB
- Generate multi-sheet `.xlsx`, served for download (`generate_xlsx`)
- Generate `.docx` via Node `docx` lib (`generate_docx`); read `.docx` text (`read_docx`)
- Attachment handlers: PDF, DOCX, PPTX, text, image
- PPTX generation via script + `run_node_script` (see `skills/pptx/`)
- Advanced DOCX edit (tracked changes, comments, validation) via opt-in Python toolchain + `run_python_script` (see `skills/docx/`)

## Shell
- Run a `.js` script in an allowed write path (`run_node_script`)
- Run a `.py` script in an allowed write path, requires host `python3` (`run_python_script`)
- JS syntax check without executing (`syntax_check`)
- Run an allowlisted shell command in a write path (`run_shell`)

## Web & Image
- Fetch URL, strip HTML, with offset paging for long pages (`fetch_url`)
- Load image from path or base64 for analysis (`read_image`)
- Normalize image to RGB PNG, letterbox 896×896 (`preprocess_image`)
- Describe image via local llama.cpp VLM (`describe_image`)

## GitHub
- Fetch an issue with body + comments (`fetch_github_issue`)
- List the open-issue backlog for triage (`list_github_issues`) — resolves the repo(s) from an explicit `repo`, a `project` name, or the user's `triage.repos` setting (never a hardcoded default); filters out PRs; records each issue in the triage ledger
- Record a triage verdict in the local ledger (`record_issue_triage`) — server-side dedup so the daily job never re-reads an issue
- Open a new issue (`create_github_issue`)
- Update / close an existing issue (`update_github_issue`)
- Daily issue-triage background job (`issue-triage`) + on-demand planner (`issue-planner`), both seeded **disabled** and repo-less; real-time capture via the GitHub webhook (`POST /api/github/webhook`, HMAC-verified with `GITHUB_WEBHOOK_SECRET`). Triage is read-only (no token for public repos) and treats issue text as untrusted data

> **54 MCP tools total**, callable by any MCP client (Cursor, Windsurf, Claude, etc.).

## Agent & Reasoning
- Agent loop with tool-calling (`lib/agent/index.js`)
- Validated `AgentSpec` contract — normalizes provider/model overrides, identity/persona, character, skills, memory scopes, tool allowlists, filesystem rules, interrupt policy, timeout, recursion depth, concurrency, and optional output JSON Schema while rejecting unknown security-sensitive fields; `createAgent` consumes specs through a legacy-compatible adapter and filters provider-visible tool schemas by explicit allowlist (`lib/agent/spec.js`, `lib/agent/index.js`)
- Portable agent bundles — optional `createAgent({ bundleDir })` directories can provide `AGENT.md`, `permissions.json`, `memory-scopes.json`, `output.schema.json`, and agent-local `skills/`; bundle policy is normalized into `AgentSpec` and cannot widen explicit administrator tool, filesystem, memory, interrupt, recursion, concurrency, or timeout limits (`lib/agent/bundle.js`)
- Provider-neutral lifecycle middleware contract — seven ordered async hooks with immutable request snapshots, explicit returned updates/short-circuiting, validated named registrations, and failure attribution (`lib/agent/middleware.js`)
- Tool safety middleware — failure-budget gating, repeated-call detection, untrusted-content fencing, taint propagation, and tainted-write confirmation now run as named `beforeTool`/`afterTool` adapters while preserving existing WebSocket events and limits (`lib/agent/tool-safety-middleware.js`)
- Model-context middleware — the native Anthropic/llama.cpp/Gemini/DeepSeek loops share named context-trimming, memory-pointer, skill-injection, tool-profile, and result-offload adapters while retaining provider-local wire serialization and redaction (`lib/agent/model-context-middleware.js`)
- Bounded lifecycle diagnostics — each native run retains up to 200 metadata-only hook records (identity, timing, decision, error class) with read-only last-run inspection; prompts, arguments, results, error messages, secrets, and artifact contents have no trace storage path (`lib/agent/lifecycle-trace.js`)
- Durable interrupt service — pending sensitive-action descriptors persist in SQLite/Postgres with canonical arguments or protected payload references, digests, allowed decisions, expiry, decision/claim/completion state, and atomic claim-before-execute semantics; approve/edit/reject/respond decisions are supported and same-decision replays are idempotent while conflicting replays are rejected (`lib/security/interruptService.js`). File write/delete approvals and `db_execute` database-write confirmations now use this service; `/api/interrupts` and the chat UI list pending actions after reconnect and let the user approve, safely edit JSON arguments, reject, or respond without execution.
- Lossless large-result offloading — oversized text tool results are secret-redacted and stored immutably under a private session/run scope; the model receives a bounded head/tail preview with an artifact ID instead of losing the full result to context trimming (`APERIO_TOOL_RESULT_OFFLOAD_TOKENS`, `APERIO_TOOL_RESULT_OFFLOAD_BYTES`)
- Chunked result recovery — after an offload in the active run, the read-only `read_artifact` tool pages the complete result by byte offset/limit under code-enforced session/run ownership (8,192-byte default chunk, 24,000-byte maximum chunk, 32,000-byte maximum response)
- Artifact lifecycle and observability — session artifacts are deleted/pruned with sessions; run artifacts follow `AGENT_RUN_RETENTION_DAYS`; logs and background-run history expose only offload IDs/scopes/counts/byte totals, never stored content
- First-class providers: llama.cpp (vendored, self-managed), Anthropic, DeepSeek, Gemini, Claude Code Agent SDK, and OpenAI Codex CLI
- Codex provider: authenticated `codex exec --json`, Aperio MCP tool access, explicit sandbox/approval policy, session-scoped persisted thread resume, background completions, setup wizard, and round-table support
- Skills matching per turn (`skills/`)
- Reasoning / thinking mode with reasoning-chain replay
- Round-table two-agent cross-review until `AGREED` or round cap (`ROUNDTABLE_AGENTS`); both participants are constructed from validated `AgentSpec` definitions derived from the configured provider/model/persona/character, and post-round manifestos from each agent are saved to `var/roundtables/` and served for preview/download
- Background agents: scheduled, chat-less jobs over the store — interval, manual (`POST /api/agents/:id/run`), and codegraph/docgraph file-change (`watcher`) triggers, steps-mode tool pipelines and freeform `runAgentLoop` jobs, DB-backed (`agent_jobs` table) with per-run history in the `agent_runs` table (newest-first in the agents panel), gated by `APERIO_AGENT_JOBS=on`; freeform jobs store validated `AgentSpec` definitions and legacy provider/persona/character fields are normalized safely on read/write; fresh stores include a disabled `nightly-maintenance` example for embedding backfill and dry-run dedupe (see `background-agents.md`)
- Background-agents UI panel — right-side sidebar with live master switch, per-job trigger/mode/last-verdict, "Run now", and per-job run history (`lib/routes/api-agents.js`, `public/scripts/agents-panel.js`)
- Personas via `id/whoami*.md`; 7 domain characters via `id/characters/` (architect, reviewer, security, product, socratic, doctor, space-engineer) overlayable per-agent via `ROUNDTABLE_CHARACTERS`

## Storage
- SQLite + sqlite-vec + FTS5 — zero-config default, single file `var/aperio.db`
- Postgres + pgvector — Docker, for multi-agent/production
- Auto-detect backend (Postgres if Docker running, else SQLite)
- SQLite at-rest encryption — AES-256-GCM, key stored in OS keychain (`APERIO_DB_ENCRYPT=1`)
- Embedding providers: local transformers (default), Voyage AI (cloud)
- Embedding retry queue for resilient vector writes
- Data portability — `export_data` (portable JSON backup) and `import_data` (idempotent restore, deduplicates by ID/slug, queues embeddings for backfill)
- Private agent-artifact store — immutable SHA-256-verified metadata/content pairs scoped to a chat session or headless run, written atomically with `0700` directories and `0600` files

## Testing large-result artifacts

Run the focused lifecycle and retrieval coverage:

```bash
NODE_ENV=test node --test \
  tests/lib/context/artifactStore.test.js \
  tests/lib/context/toolResultOffload.test.js \
  tests/lib/context/artifactRetrieval.test.js \
  tests/lib/agent/tool-hooks.test.js \
  tests/lib/helpers/sessions.test.js \
  tests/lib/workers/agent-run-prune.test.js \
  tests/lib/workers/agent-scheduler.test.js

NODE_ENV=test node --test tests/db/sqlite.test.js tests/db/postgres.test.js
```

Manual verification: set `APERIO_TOOL_RESULT_OFFLOAD_BYTES=1000`, restart,
have a capable agent read more than 1 KB of text, and verify the bounded preview
and `read_artifact` pagination. Check `[tool-result-offload]` logs and background
run history for byte counts without content. Delete the session and verify its
`var/agent-artifacts/sessions/<session-id>/` directory is gone, then restore the
normal threshold.

## Testing lifecycle middleware

```bash
NODE_ENV=test node --test \
  tests/lib/agent/middleware.test.js \
  tests/lib/agent/model-context-middleware.test.js \
  tests/lib/agent/tool-hooks.test.js
```

The contract suite covers hook ordering, async updates, immutable snapshots,
short-circuiting, registration validation, failure attribution, and `onError`
observer isolation. Tool-hook coverage verifies fencing, taint-to-confirm
propagation, repeated-call and failure-budget stops, unchanged event payloads,
and offload ordering. Model-context coverage verifies bounded immutable history,
memory/skill ordering, canonical tool selection, provider-local serialization,
offload failure isolation, bounded trace eviction, and trace privacy/fail-open
behavior.

## Interfaces
- Web UI: streaming chat, themes, sidebar, code panel, voice input + TTS readout
- Inline input autocomplete — ghost-text suggestion accepted with Tab/→
- Skill quick-access chips — one measured row that hides overflow behind a `+N more` chip (click expands to a wrapped panel, `− less` collapses); recomputed on resize; click injects `/skill <name>`
- Branch conversation — labeled "Branch" button plus a discoverable entry in the `+` actions menu, both opening a friendly inline confirm card (replaces the browser `confirm()`); gated by the lite profile
- Model download/load banner — while llama.cpp pulls/loads GGUF weights inside a request, a self-dismissing main-window banner shows live GB and staged `downloading → loading → ready`, fading 5 s after the model is ready; warm models stay silent
- Clickable memory-suggestion chips — save all / pick / none, prompts for ones needing input
- Sessions: persistent (file + DB), pagination, delete
- 26-language Web UI i18n (24 EU + 中文 + 日本語) with flag-based navbar switcher and persistent selection; all locale files match the complete 304-key English baseline
- Locale integrity gate (`npm run i18n:check`) — rejects missing/extra keys and placeholder/HTML drift, and verifies statically referenced UI keys exist
- Response stats badge: answer/thinking tokens, tok/s, elapsed
- Settings → Extras: detect optional skill deps, auto-install pip deps into project venv, guided install for system binaries (`/api/capabilities`)
- Settings overlay — one full-screen configuration surface (schema-driven from the `lib/config.js` registry → `GET /api/config/schema`) with plain-language categories (Provider & Models · Memory & Privacy · Features · Network & Security · Advanced), search, and a Simple↔Advanced toggle; every var is a typed control (toggle/select/number/text/list-chips/secret), DB-backed under `config.<KEY>`, precedence DB > env > default by default (set `APERIO_CONFIG_PRECEDENCE=env` to make `.env` win — the secrets-stay-in-env escape hatch), single restart-to-apply banner, provenance chips (from UI / from .env / default) and a shadow warning when a `.env` line is beaten by a differing DB value; Tier-0 bootstrap/security vars shown read-only ("edit in .env"); provider-scoped fields revealed by `AI_PROVIDER`; on-demand `.env` import of unmanaged vars (`npm run config:sync`, rendered under Advanced); amber rebuild-the-index warning when `EMBEDDING_PROVIDER`/`EMBEDDING_DIMS` change; `npm run gen:env` generates the slim `.env.example` (essentials + START-HERE provider block) **and** the full annotated `docs/config-reference.md` from the same registry; fresh installs default to local `llamacpp` (RAM-tier model pick) and an unconfigured provider is a loud, explicit notice — never a silent cloud fallback
- Terminal chat client — standalone or proxy (`lib/terminal.js`); text only (voice/TTS is Web UI only)
- Guided-tour `help` — each command paired with a runnable `try:` example; `examples` toggles the examples (persisted in `var/cli-prefs.json`), `help <command>` shows focused per-command docs
- Localized terminal welcome/help — English by default; `lang <code>` switches and persists (bare `lang` lists all 26 locales), or set `APERIO_UI_LANG` in `.env` (saved pref wins over env); translations overlay `cli_`-prefixed keys in the shared `public/locales/<lang>.json`, falling back to English per-string
- Sticky navbar — a compact, width-aware status strip (model · mode · Docker · storage) reprinted above every prompt; `status` is the on-demand superset (adds language/reasoning/stats/examples)
- `restart` command — bare `restart` starts a fresh session in-process (standalone) or relaunches (proxy); `restart --hard` always re-execs the process, reloading `.env`/config
- MCP server entry point (`mcp/index.js`)

## Security & Hardening
Defenses for the local-first → LAN/hosted threat model (see `security-plan.md`, `SECURITY.md`).

**Agent exfiltration surface**
- Agent permission evaluator — ordered first-match rules with default deny for read, write, execute, network, database, and memory capabilities, plus parent-to-child narrowing checks that reject delegated policies broader than the parent (`lib/security/agentPermissions.js`)
- SSRF egress guard on `fetch_url` + image fetch — blocks loopback/link-local/private addresses, opt-outs `APERIO_ALLOW_INTERNAL_FETCH` / `APERIO_EGRESS_ALLOWLIST`; egress logging
- Shell allowlist hardening — rejects node/python inline-eval, `find -exec`, non-read-only git, file args outside the allowlist; `curl` removed; `run_shell` is explicitly **not a sandbox**
- Prompt-injection defense — output of external/read tools fenced as `UNTRUSTED EXTERNAL CONTENT`; per-turn taint flag; tainted-turn writes routed through the confirm gate
- Confirm-on-write gate — `write_file` / `edit_file` / `append_file` two-phase token-confirmed when the write lands outside `var/scratch/` or the turn is tainted (edit shows a capped unified diff); `delete_file` uses the same durable approval path
- Durable interrupt persistence — the store and service layer can preserve pending sensitive actions across restart, validate decisions, expire stale descriptors, and atomically claim approved/edited actions before execution; file write/delete confirmations and `db_execute` database writes use it now, with API/UI decisions for approve, edit, reject, and respond
- Secret deny-list — `read_file` / `edit_file` / attachments refuse `.env*`, `id_rsa`, `.pem`/`.key`, and known credential files before any extension check

**Secrets & privacy**
- `.env` written `0600` with injection-safe quoting; default Postgres password hard-fail (`APERIO_ALLOW_DEFAULT_DB_PASSWORD` opt-out)
- Secret redaction (PEM keys, API tokens, JWTs, URI passwords) at every cloud-provider send boundary; local llama.cpp skipped
- Oversized tool results are secret-redacted before entering the private artifact store; previews are generated from the redacted copy
- Memory sensitivity tiers: `tier: 1` (normal, always shared), `tier: 2` (sensitive, withheld or PII-redacted on cloud), `tier: 3` (private, never leaves the machine). Legacy `local-only` tag maps to tier 2.
- Cloud sensitive mode (`APERIO_CLOUD_SENSITIVE_MODE`): `withhold` (default — tier-2 filtered on cloud) or `redact` (PII-scrubbed via `lib/privacy/redact.js`)
- PII redaction library — EMAIL, PHONE, CARD, IBAN regex-based detection; server-side redact before cloud send, restore on return
- Memory inference/dedup workers gated to local provider (`APERIO_CLOUD_MEMORY_WORKERS` opt-in)
- At-rest `0600` perms + secret scrubbing for sessions, handoffs, and error logs
- SQLite at-rest encryption — AES-256-GCM with key in OS keychain (macOS Keychain, Linux libsecret, Windows DPAPI); plaintext in `$TMPDIR` only while running; auto-migrates existing plaintext DB on first enable; DELETE journal when encrypted (no WAL plaintext leakage); crash recovery from leftover temp files (`APERIO_DB_ENCRYPT=1`)

**Network & hosting**
- DNS-rebinding / Host + cross-site Origin guard + `X-Aperio-Client` requirement on state-changing `/api` (`APERIO_ALLOWED_HOSTS`)
- Opt-in shared-secret auth gate on `/api` + WS (`APERIO_AUTH_TOKEN`; Bearer / header / query, constant-time compare)
- Static `/uploads` + `/scratch` mounts gated by a per-process cookie (or auth token)
- Rate limiting on setup + indexing/import endpoints; Helmet headers; 256 kb JSON body cap
- Opt-in TLS/HTTPS (`APERIO_TLS_CERT` + `APERIO_TLS_KEY`, fail-loud on partial config)
- Opt-in AES-256-GCM session encryption at rest (`APERIO_SESSION_KEY`)
- Crash breaker (sliding window → supervised restart); scrubbed terminal error handler with correlation id
- DB access via table-name whitelist
- Private/incognito UI launch with default-browser fallback (`APERIO_BROWSER`: firefox/firefox-dev/librewolf/mullvad/chrome/chromium/brave/edge/tor/ddg); opt-in dedicated browser profile isolating cookies/storage/extensions (`APERIO_BROWSER_ISOLATED=1`)

## Onboarding & Install (Aperio-lite)
- Browser setup wizard (`public/setup.html`) driven over `/api/bootstrap/stream` — provider choice, llama.cpp, model download, DB, all without editing config files; `file://` guard redirects users who open the page directly instead of via the launcher
- Vendored llama.cpp — installs a private, pinned, checksum-verified `llama-server` copy into `vendor/llamacpp` (never system-wide); idle auto-shutdown watchdog + in-app Quit
- One-click launchers (`.github/lite/`): `START.sh` (macOS/Linux) / `START.bat` (Windows) do only what a browser can't — ensure Node + `npm install`, then start — and drop a hidden-window "Aperio" Desktop launcher for later runs
- Uninstaller (`uninstall.sh` / `uninstall.bat`) — stops the server + our vendored llama.cpp, removes `vendor/` · `node_modules/` · `var/` · `.sqlite/` + the Desktop launcher, offers to delete the downloaded model, and leaves system Node untouched (honest "left behind" wording via `nodePreexisting` in `bootstrap.lock`)
- Lite profile (`APERIO_LITE=on`) — SQLite + transformers + docgraph defaults, forced DB config-precedence (the Settings UI rules, never `.env`), essentials-only Web UI with a runtime **Advanced** escape hatch, and non-coder starter memories + a self-contained `public/help.html`
- Release packaging (`cd.release.yml`) — versioned `aperio-lite.zip` (launchers + how-to staged at the archive root) published to the latest GitHub release under a stable URL

## Ops
- CI: CodeQL, Codecov, SonarCloud, Codacy, Dependabot (npm + github-actions), `npm audit` (high-severity gate)
- Quiet test reporter gated on `APERIO_AGENT_RUN` (summary-only output for agent runs)
- Graceful shutdown with ONNX cleanup
- RAM-based model recommendation (setup wizard + terminal model picker)
- Local-engine hardware/perf profiles (`APERIO_LOCAL_PERF_PROFILE`: balanced/fast-low-vram/long-context/quality) — MoE-aware model pick, KV-cache quantization + flash attention + single-resident-model on tight VRAM, raised context ceiling for long-context, biggest-model-RAM-allows for quality; best-effort VRAM detection (macOS unified memory, `nvidia-smi`, else unknown)
- Memory-aware llama.cpp vision bridge — native-vision main models omit the dedicated VLM; when the main model and VLM cannot fit together, the router keeps both entries but uses `models-max = 1` to swap them on demand, with the selected mode logged at startup
- `npm run local:bench` — short + medium fixed-prompt benchmark against the local llama.cpp engine; reports load overhead, prompt/gen tok/s, served context, profile, model, and a recommendation string (issue #222)
- Model-tier pilot benchmark — runs fixed tool-use qualification cases against a
  selected local llama.cpp model and RAM tier in an isolated temporary SQLite
  app/workspace, records readiness, tool sequence, state assertions, timings,
  context-limit evidence, and private logs under `var/benchmarks/model-tiers/`
- Model-tier campaign execution — sequentially runs the validated catalog's 38
  tier/model placements from private plans, with a non-live dry-run mode and
  private execution ledgers; individual cases can be audited with
  `npm run model-tier:pilot -- --model <id> --tier <8|16|24|32> --case <id>`
- Model-tier audit policy — retains a five-minute default case deadline and tests
  tiers in descending `32 → 24 → 16 → 8` order; two genuine top-tier
  failures stop the audit after artifact collection, while invalid readiness
  evidence is rerun instead of being treated as a model failure; high-tier
  audits prioritize `gemma4-26b-a4b-ud-q4kxl` and `gemma4-e4b-ud-q4kxl`
- Model-tier evidence review — offline finalist manifests and full-exam tier
  decisions from validated campaign artifacts; raw evidence remains private
  under `var/`, and pilot evidence alone cannot promote an installer default
- Model-tier diagnostics — persisted retry transcripts and timeout evidence
  distinguish generic loop deadlines, explicit llama.cpp context-limit
  failures, harness/readiness failures, and valid completions; terminal context
  overflows are invalid infrastructure evidence and are never counted or
  retried as model-behavior failures
- Context-safe local tool chains — schema costs are budgeted against the served
  window, complete llama.cpp requests retain headroom, newly appended recall
  results feed the next trimming decision immediately, and oversized recall
  previews prefer narrower retrieval before loading a full artifact
- Evidence-gated slow-turn diagnostic — after 3 consecutive local turns below a real-tok/s floor (llama-server's own reported `timings`, not wall-clock), a one-shot UI hint suggests a profile/context change; never fires for cloud providers
- Docker production config (`docker/docker-compose.prod.yml`)
- Test suite: 2953 unit tests (`npm test`) and 40 e2e tests (`npm run test:e2e`)
