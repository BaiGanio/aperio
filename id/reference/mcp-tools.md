# MCP Tools

All tools registered in `mcp/index.js`. Each tool file in `mcp/tools/` exports a
`register(server, ctx)` function.

## Tool Catalog

| Category | Tools | File |
|----------|-------|------|
| Memory | `remember`, `recall`, `forget`, `update_memory`, `backfill_embeddings`, `deduplicate_memories` | `memory.js` |
| Self-memory | `self_remember`, `self_recall`, `self_update`, `self_forget` | `self-memory.js` |
| Self-wiki | `self_wiki_get`, `self_wiki_write` | `self-wiki.js` |
| Files | `read_file`, `grep_files`, `write_file`, `edit_file`, `append_file`, `delete_file`, `read_docx`, `scan_project`, `generate_xlsx`, `generate_docx` | `files.js` |
| Web | `fetch_url`, `web_search` | `web.js` |
| Image | `read_image`, `preprocess_image`, `describe_image` | `image.js` |
| Shell | `run_shell`, `run_node_script`, `run_python_script`, `syntax_check` | `shell.js` |
| Wiki | `wiki_get`, `wiki_write`, `wiki_list`, `wiki_search` | `wiki.js` |
| Code graph | `code_search`, `code_context`, `code_outline`, `code_callers`, `code_callees`, `code_repos` | `codegraph.js` |
| Doc graph | `doc_search`, `doc_context`, `doc_outline`, `doc_refs`, `doc_repos`, `doc_manifest`, `doc_batch` | `docgraph.js` |
| GitHub | `fetch_github_issue`, `create_github_issue`, `update_github_issue`, `list_github_issues`, `record_issue_triage` | `github.js` |
| Data | `export_data`, `import_data` | `data.js` |
| Database | `db_query`, `db_execute`, `db_schema`, `db_connections` (external DB connections) | `database.js` |

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

## Tool Context (`ctx`)

Passed to every tool registration. Contains:
- `store` — DB instance (SQLite or Postgres)
- `generateEmbedding` — vector embedding function
- `vectorEnabled()` — whether vector search is active
- `embeddingQueue` — batched background embedding processor
- `providerIsLocal` — whether the current model runs locally (privacy gate)
