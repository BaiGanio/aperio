# Aperio — Feature Inventory

Single source of truth for **what exists**. If you add or remove a feature, change it here in the same PR — otherwise it didn't ship.

Last reconciled: 2026-06-10 · Version: 0.55.0

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
- Open a new issue (`create_github_issue`)
- Update / close an existing issue (`update_github_issue`)

> **41 MCP tools total**, callable by any MCP client (Cursor, Windsurf, Claude, etc.).

## Agent & Reasoning
- Agent loop with tool-calling (`lib/agent/index.js`)
- Providers: Ollama, Anthropic, DeepSeek (Gemini and Claude Code SDK exist in-code but are hidden from the UI)
- Skills matching per turn (`skills/`)
- Reasoning / thinking mode with reasoning-chain replay
- Round-table two-agent cross-review until `AGREED` or round cap (`ROUNDTABLE_AGENTS`)
- Background agents: scheduled, chat-less jobs over the store — interval, manual (`POST /api/agents/:id/run`), and codegraph/docgraph file-change (`watcher`) triggers, steps-mode tool pipelines and freeform `runAgentLoop` jobs, run records in `var/agents/`, gated by `APERIO_AGENT_JOBS=on` (see `background-agents.md`)
- Personas via `id/whoami*.md`; characters via `id/characters/`

## Storage
- SQLite + sqlite-vec + FTS5 — zero-config default, single file `var/aperio.db`
- Postgres + pgvector — Docker, for multi-agent/production
- Auto-detect backend (Postgres if Docker running, else SQLite)
- Embedding providers: local transformers (default), Voyage AI (cloud)
- Embedding retry queue for resilient vector writes

## Interfaces
- Web UI: streaming chat, themes, sidebar, code panel
- Sessions: persistent (file + DB), pagination, delete
- 24-language i18n with flag-based navbar switcher
- Response stats badge: answer/thinking tokens, tok/s, elapsed
- Settings → Extras: detect optional skill deps, auto-install pip deps into project venv, guided install for system binaries (`/api/capabilities`)
- Terminal chat client — standalone or proxy (`lib/terminal.js`)
- MCP server entry point (`mcp/index.js`)

## Ops
- CI: CodeQL, Codecov, SonarCloud, Codacy, Dependabot
- Graceful shutdown with ONNX cleanup
- RAM-based model auto-select (`CHECK_RAM=true`)
- Docker production config (`docker/docker-compose.prod.yml`)
- Test suite: 1454 tests (`npm test`)
