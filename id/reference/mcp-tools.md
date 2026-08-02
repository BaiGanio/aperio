# MCP Tools

All tools registered in `mcp/index.js`. Each tool file in `mcp/tools/` exports a
`register(server, ctx)` function.

## Tool Catalog

| Category | Tools | File |
|----------|-------|------|
| Memory | `remember`, `recall`, `forget`, `update_memory`, `propose_memory`, `backfill_embeddings`, `deduplicate_memories` | `memory.js` |
| Self-memory | `self_remember`, `self_recall`, `self_update`, `self_forget` | `self-memory.js` |
| Self-wiki | `self_wiki_get`, `self_wiki_write` | `self-wiki.js` |
| Files | `read_file`, `grep_files`, `write_file`, `edit_file`, `append_file`, `delete_file`, `read_docx`, `scan_project`, `generate_xlsx`, `generate_docx` | `files.js` |
| Web | `fetch_url`, `web_search` | `web.js` |
| Image | `read_image`, `preprocess_image`, `describe_image` | `image.js` |
| Shell | `run_shell`, `run_node_script`, `run_python_script`, `syntax_check` | `shell.js` |
| Wiki | `wiki_get`, `wiki_write`, `wiki_list`, `wiki_search`, `propose_wiki` | `wiki.js` |
| Code graph | `code_search`, `code_context`, `code_outline`, `code_callers`, `code_callees`, `code_repos`, `code_neighbors`, `code_path`, `code_insights` | `codegraph.js` |
| Doc graph | `doc_search`, `doc_context`, `doc_outline`, `doc_refs`, `doc_repos`, `doc_manifest`, `doc_batch` | `docgraph.js` |
| GitHub | `fetch_github_issue`, `create_github_issue`, `update_github_issue`, `list_github_issues`, `record_issue_triage` | `github.js` |
| Data | `export_data`, `import_data` | `data.js` |
| Database | `db_query`, `db_execute`, `db_schema`, `db_connections` (external DB connections) | `database.js` |
| Extraction | `extraction_template_list`, `extraction_template_get`, `extraction_template_match`, `extraction_template_propose`, `extraction_template_delete`, `extraction_apply`, `extraction_log_check`, `extraction_log_record` | `extraction.js` |

### Code graph intelligence contract (`code_neighbors` / `code_path` / `code_insights`)

These three read-only tools sit on top of the persistent code graph (issue #283).
All traversal is bounded and deterministic; nothing here mutates the graph.

- **`code_neighbors`** — neighborhood around one `qualified` symbol across *all*
  relation kinds (`calls`, `imports`, `extends`, `references`), not just calls.
  Inputs: `qualified` (a file node's qualified name is its repo-relative path),
  optional `repo`, `direction` = `in|out|both` (default `both`), `kinds[]`,
  `depth` 1–3 (default 1), `limit` 1–100 (default 50). Output carries the seed,
  deterministically ordered nodes with per-node minimum `hop`, edges with
  `confidence` metadata, and `truncated`/`returned`/`total`. Edges reference
  endpoints by `from`/`to` qualified names.
- **`code_path`** — bounded shortest relationship path. Inputs: `from`, `to`,
  optional `repo`, `directed` (default `false`), `kinds[]`, `max_depth` 1–10
  (default 6). Output: ordered `nodes`/`edges` and `hop_count`, or a distinct
  `{ found: false }` when the endpoints are known but unreachable. An unknown or
  cross-repo-ambiguous symbol raises the existing repo-resolution error rather
  than masquerading as disconnection.
- **`code_insights`** — architecture insights for one `repo` (required),
  `view` = `summary|communities|hotspots|bridges|cycles` (default `summary`),
  `limit` 1–50 (default 20). Analysis is computed once per graph revision (seeded
  Louvain communities, degree-based hotspots excluding file/built-in noise,
  cross-community bridges, one representative import cycle per SCC) and reused
  while the revision is unchanged.

Confidence values across these tools: `EXTRACTED` (direct syntax fact, score 1.0)
vs `INFERRED` (unique-name or relative-import resolution, score 0.8). Unresolved
targets are never fabricated. Raw UI graph data (`GET /api/codegraph/graph`) is
HTTP-only and intentionally not exposed as an MCP tool.

### Doc graph manifest/batch evidence contract

`doc_manifest` candidates carry `file_mtime` (filesystem timestamp — indexing/edit
time, never a document date) separate from `filename_date_hint` (best-effort date
parsed from the filename/title only, or `null`); content-identical duplicates are
merged with the dropped copies listed under `duplicates`, never silently discarded.
`doc_batch` attaches `dates` (role-labeled: `invoice_date`, `document_date`,
`statement_date`, `receipt_date`, `payment_date`, `due_date`,
`service_period_start`/`_end`, `unlabeled_date`; ISO `value` or `null` when the raw
token's format is locale-ambiguous) and `amounts` (`value`/`currency`/`label`,
`currency: null` when undetectable) extracted from each read document's real text —
an empty array means none were detected, never a fabricated value. See
`lib/docgraph/extract-facts.js` and `lib/docgraph/retrieval.js`.
When `DOCGRAPH_AUTO_MEMORY=on`, doc_batch also auto-promotes high-confidence
terminal facts (amount_due/grand_total + due_date/invoice_date/service_period
at high confidence) into the memory store. Promoted memories are tier 2
(sensitive), carry opaque hashed dedup tags, and are owned by `source="docgraph"`
to prevent user-memory collisions. See `lib/handlers/docgraph/docgraphHandlers.js`.

### Extraction template contract (Document Intelligence WS3, issue #250)

Recognizes and reuses a learned document *shape* on top of the ad-hoc `db_execute`
flow — a document matching no known template still falls through to that flow
unchanged. `extraction_template_match` ranks a document's text against every known
template by Unicode-aware whole-word keyword overlap (never substring — a `gas`
keyword does not match inside "Vegas") and returns `confident` / `ambiguous` / `none`,
never silently picking between two close scores. A `none` match makes
`extraction_template_propose` infer a new template from the document's own labeled
evidence (`lib/docgraph/extract-facts.js`'s amount/date roles) — this is the only
write path, and it is confirm-gated the same way as `db_execute`: propose once, the
user confirms, only then does `templateHandlers.create` run. `extraction_apply`
extracts fields against a matched (or explicitly named) template — regex/label-first,
then one targeted LLM completion for whatever's still unresolved, never a full
re-extraction; a field unresolved by both is reported `missing`, never fabricated.

`extraction_log_record` is the dedup contract's other half, and its own confirm
boundary is unusual: it requires `db_execute_token` — the *same* token that
confirmed the real write — and verifies server-side, before recording anything, that
the interrupt reached `status: "executed"` against the `extraction` connection, that
the confirmed statement's `classify()` keyword was `INSERT` (not e.g. a bare
`CREATE TABLE`), and that the `source_hash` being recorded appears literally among
that INSERT's own bound `params`. A confirmed write for an unrelated or nonexistent
source can never be used to falsely mark a different document "already extracted."
`extraction_apply`'s own description tells the model to include `sourceHash` as an
INSERT column value for exactly this reason.

Reachable from the web agent via `TOOL_PROFILES.extraction` in
`lib/agent/tool-profiles.js`, loaded alongside `docgraph` and `database` on the same
`isDocumentAggregationIntent` signal that already unlocks document-aggregation
turns — extraction's own persistence/dedup follow-up needs `db_execute` in the same
turn, so `database` is loaded whenever `extraction` is. MCP registration alone does
not make a tool reachable here; `tests/integration/mcp/tool-profile-coverage.test.js`
enforces a strict registered⇔reachable bijection across every MCP tool in the repo.

## Tool Context (`ctx`)

Passed to every tool registration. Contains:
- `store` — DB instance (SQLite or Postgres)
- `generateEmbedding` — vector embedding function
- `vectorEnabled()` — whether vector search is active
- `embeddingQueue` — batched background embedding processor
- `providerIsLocal` — whether the current model runs locally (privacy gate)
