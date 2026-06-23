# Aperio — Feature Inventory

Single source of truth for **what exists**. If you add or remove a feature, change it here in the same PR — otherwise it didn't ship.

Last reconciled: 2026-06-17 · Version: 0.56.0

---

## Memory
- Save memories with type, title, tags, importance, optional expiry (`remember`)
- Semantic + full-text recall across all memories (`recall`)
- Update by ID — tombstones old version, regenerates embedding (`update_memory`)
- Delete by ID (`forget`)
- Generate embeddings for memories missing one (`backfill_embeddings`)
- Find and merge near-duplicates by cosine similarity (`deduplicate_memories`)

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
- Describe image via local Ollama VLM (`describe_image`)

## GitHub
- Fetch an issue with body + comments (`fetch_github_issue`)
- List the open-issue backlog for triage (`list_github_issues`) — resolves the repo(s) from an explicit `repo`, a `project` name, or the user's `triage.repos` setting (never a hardcoded default); filters out PRs; records each issue in the triage ledger
- Record a triage verdict in the local ledger (`record_issue_triage`) — server-side dedup so the daily job never re-reads an issue
- Open a new issue (`create_github_issue`)
- Update / close an existing issue (`update_github_issue`)
- Daily issue-triage background job (`issue-triage`) + on-demand planner (`issue-planner`), both seeded **disabled** and repo-less; real-time capture via the GitHub webhook (`POST /api/github/webhook`, HMAC-verified with `GITHUB_WEBHOOK_SECRET`). Triage is read-only (no token for public repos) and treats issue text as untrusted data

> **50 MCP tools total**, callable by any MCP client (Cursor, Windsurf, Claude, etc.).

## Agent & Reasoning
- Agent loop with tool-calling (`lib/agent/index.js`)
- Providers: Ollama, Anthropic, DeepSeek (Gemini and Claude Code SDK exist in-code but are hidden from the UI)
- Skills matching per turn (`skills/`)
- Reasoning / thinking mode with reasoning-chain replay
- Round-table two-agent cross-review until `AGREED` or round cap (`ROUNDTABLE_AGENTS`); post-round manifestos from each agent saved to `var/roundtables/` and served for preview/download
- Background agents: scheduled, chat-less jobs over the store — interval, manual (`POST /api/agents/:id/run`), and codegraph/docgraph file-change (`watcher`) triggers, steps-mode tool pipelines and freeform `runAgentLoop` jobs, DB-backed (`agent_jobs` table) with per-run history in the `agent_runs` table (newest-first in the agents panel), gated by `APERIO_AGENT_JOBS=on` (see `background-agents.md`)
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

## Interfaces
- Web UI: streaming chat, themes, sidebar, code panel
- Inline input autocomplete — ghost-text suggestion accepted with Tab/→
- Clickable memory-suggestion chips — save all / pick / none, prompts for ones needing input
- Sessions: persistent (file + DB), pagination, delete
- 24-language i18n with flag-based navbar switcher
- Response stats badge: answer/thinking tokens, tok/s, elapsed
- Settings → Extras: detect optional skill deps, auto-install pip deps into project venv, guided install for system binaries (`/api/capabilities`)
- In-app Configuration panel — schema-driven editor (`lib/config.js` registry → `GET /api/config/schema`) for every `.env` var as a typed control (toggle/select/number/text/list-chips/secret); DB-backed under `config.<KEY>`, precedence DB > env > default, single restart-to-apply banner; API keys editable in-UI (no `.env`); Tier-0 bootstrap/security vars shown read-only ("edit in .env"); provider-scoped fields revealed by `AI_PROVIDER`; on-demand `.env` import of unmanaged vars (`npm run config:sync`, Managed/Unmanaged/Orphaned); amber rebuild-the-index warning when `EMBEDDING_PROVIDER`/`EMBEDDING_DIMS` change; the generated `.env.example` (`npm run gen:env`) ships only essentials + Tier-0 bootstrap (27 of 74 vars) — every other setting lives in the panel
- Terminal chat client — standalone or proxy (`lib/terminal.js`)
- MCP server entry point (`mcp/index.js`)

## Security & Hardening
Defenses for the local-first → LAN/hosted threat model (see `security-plan.md`, `SECURITY.md`).

**Agent exfiltration surface**
- SSRF egress guard on `fetch_url` + image fetch — blocks loopback/link-local/private addresses, opt-outs `APERIO_ALLOW_INTERNAL_FETCH` / `APERIO_EGRESS_ALLOWLIST`; egress logging
- Shell allowlist hardening — rejects node/python inline-eval, `find -exec`, non-read-only git, file args outside the allowlist; `curl` removed; `run_shell` is explicitly **not a sandbox**
- Prompt-injection defense — output of external/read tools fenced as `UNTRUSTED EXTERNAL CONTENT`; per-turn taint flag; tainted-turn writes routed through the confirm gate
- Confirm-on-write gate — `write_file` / `edit_file` / `append_file` two-phase token-confirmed when the write lands outside `var/scratch/` or the turn is tainted (edit shows a capped unified diff)
- Secret deny-list — `read_file` / `edit_file` / attachments refuse `.env*`, `id_rsa`, `.pem`/`.key`, and known credential files before any extension check

**Secrets & privacy**
- `.env` written `0600` with injection-safe quoting; default Postgres password hard-fail (`APERIO_ALLOW_DEFAULT_DB_PASSWORD` opt-out)
- Secret redaction (PEM keys, API tokens, JWTs, URI passwords) at every cloud-provider send boundary; local Ollama skipped
- `local-only`-tagged memories dropped from recall on cloud providers; memory inference/dedup workers gated to local provider (`APERIO_CLOUD_MEMORY_WORKERS` opt-in)
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

## Ops
- CI: CodeQL, Codecov, SonarCloud, Codacy, Dependabot (npm + github-actions), `npm audit` (high-severity gate)
- Quiet test reporter gated on `APERIO_AGENT_RUN` (summary-only output for agent runs)
- Graceful shutdown with ONNX cleanup
- RAM-based model auto-select (`CHECK_RAM=true`)
- Docker production config (`docker/docker-compose.prod.yml`)
- Test suite: 1724 tests (`npm test`)
