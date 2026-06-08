# docgraph — feature briefing

> Self-contained brief. A future session should be able to pick this up cold and start implementing without re-deriving context. If you change the design, update this file in the same commit.

---

## Why

Aperio's `codegraph` indexes code (JS/TS today) into a symbol + call graph so the agent can navigate without reading whole files. That model is useless for the project's other users — accountants, doctors, students, lawyers, researchers — who point Aperio at folders of **documents**, not code.

`docgraph` is the document-shaped sibling of `codegraph`: a pre-indexed, searchable, navigable view of an arbitrary directory tree of human content (Markdown, PDF, DOCX, XLSX, PPTX, EML, plain text, HTML), so the agent can answer:

- "Where in my notes did I write about X?"
- "Outline this 80-page PDF for me."
- "Which of my case files reference patient ID 4471?"
- "What does my Q3 budget say about marketing spend?"

**without** loading every document into context on every turn.

## Who it's for

The agent. Users never call `docgraph` tools directly — they ask natural questions; the agent reaches for `doc_search`, `doc_outline`, `doc_refs` the same way it reaches for `code_search` today.

---

## What already exists (reuse, don't rebuild)

Before writing anything new, walk these and decide what to extend vs. duplicate:

- `lib/codegraph/` — indexer, watcher, status, sqlite + postgres backends, MCP tool wiring. This is the architectural template. Mirror its shape; do **not** copy-paste — share where it makes sense (walker, backend dispatch, watcher lifecycle).
- `lib/codegraph/indexer.js` — filesystem walk + skip-dirs + backend dispatch. The walker is generic and should be lifted into a shared helper both graphs use.
- `lib/handlers/codegraph/codegraphHandlers.js` — handler shape (ctx-bound, MCP-text response, stale-file fallback message). Copy the pattern.
- `mcp/tools/codegraph.js` — tool registration shape. Copy the pattern.
- `lib/helpers/embeddings.js` — embedding generator. Reuse as-is for semantic search over chunks.
- `lib/codegraph/symbol-embedding-queue.js` — background embedding queue. The exact same pattern works for doc chunks; consider generalizing the queue.
- **Skills already doing document extraction** — do NOT reimplement these:
  - `skills/preprocess-pdf` — PDF → text/structure
  - `skills/pdf` — PDF reading patterns
  - `skills/pptx` — PowerPoint extraction
  - `skills/xlsx` — Excel extraction
  - `skills/preprocess-image` — OCR for scanned docs
  - `skills/working-with-files` — surgical edit principles (relevant when docgraph powers edits later)
- `wiki` MCP tools + `skills/wiki` — already does semantic search over a curated knowledge store. **Decision needed (see Open Questions):** is docgraph a replacement for wiki, a peer, or wiki's backend?
- `memory` MCP tools — for facts, not content. Out of scope here.

---

## Non-goals (be strict)

- Not a code index. If the file is `.js`/`.ts`/etc., it belongs to codegraph. Skip code extensions in the walker.
- Not a full-text search engine for the web. Local files only.
- Not a writeback tool in v1. Read-only index. Editing docs already has `working-with-files` + format-specific skills.
- Not a chat-with-your-docs RAG product. The agent is the consumer, not the end user. Output is structured (outlines, hits, refs), not synthesized prose.
- No new heavy dependencies. Reuse `web-tree-sitter` + `tree-sitter-wasms` for markup grammars; reuse whatever PDF/DOCX/XLSX libs the existing skills already pulled in.

---

## Practical constraints (read before Phase 1)

### Tokenizer for chunking

`gpt-tokenizer` is already in `package.json` (used elsewhere in the project). Use it for chunk boundary detection. Default: 512-token chunks with 64-token overlap. This is a config constant, not user-facing — but make it easy to tune after Phase 2 measurements.

### MIME type detection

Extension alone is unreliable — `.txt` files are sometimes Markdown, `.doc` files without extensions exist, and some users rename `.pdf` to `.bin` for legacy tools. Use a dual approach:
1. Extension first (fast path, works for 95% of files).
2. Magic-byte fallback via `file-type` or a minimal hand-rolled check for the common formats (PDF starts `%PDF`, DOCX is a ZIP with `[Content_Types].xml`, etc.).

The magic-byte check only needs to run when the extension is absent or ambiguous. Do not add a heavy dependency for this — a 20-line function covering the 7 supported formats is sufficient.

### Disk space budget

For a 500-document folder (typical mixed office content ~200 MB raw), the SQLite DB will be:
- Documents/sections/chunks metadata: ~5–10 MB.
- Embedding vectors (1024-dim float32 × ~5,000 chunks): ~20 MB uncompressed, ~5–10 MB with sqlite-vec's built-in quantization.
- FTS5 index: ~10–20 MB.

**Worst case: ~60 MB for a 200 MB document folder.** Acceptable. If the folder is 10 GB of scanned PDFs, the DB will be proportionally larger — surface this in `doc_repos` output so users see the cost.

### Embedding cost surface

Two paths, both already in `lib/helpers/embeddings.js`:
- **Local Transformers.js (default):** free, private, but slow — ~5,000 chunks takes 10–30 minutes on Apple Silicon, longer on x86 without GPU. This runs in the background embedding queue, so the user isn't blocked, but `doc_repos` should show "N chunks pending embedding" until it finishes.
- **Voyage API (`VOYAGE_API_KEY`):** fast (~30 seconds for 5,000 chunks) but costs money (~$0.10 per million tokens → ~$0.50 for a 500-doc folder) and sends text to Voyage's servers. Legal/medical users must not use this path unless they've cleared it.

The embedding queue from `lib/codegraph/symbol-embedding-queue.js` should be generalized so both code symbols and doc chunks share it. The queue already handles graceful shutdown and backfill — reuse that.

### Incremental indexing

The codegraph walker does a full-tree walk on every index. That's fine for code repos (hundreds of files, cheap extraction), but a document folder could be thousands of files, many with expensive extraction (PDF, DOCX). The docgraph indexer must:
1. Track `mtime` per document (already in schema).
2. On re-index, skip files whose `mtime` hasn't changed.
3. On watcher events (Phase 7), only re-extract the changed file.

Full re-index is still available as a "rebuild from scratch" option — expose it as `doc_index --full` or equivalent.

### Section ID stability

Do NOT use auto-increment IDs for sections. If a document is re-indexed, sequential IDs change and any stored references (e.g., in agent context summaries) break. Use path-derived stable IDs:

```
section_id = `${rel_path}#${section_path}`
```

where `section_path` is the heading chain joined by `/`, e.g. `reports/q3.md#Financials/Revenue`. For formats without headings (PDF pages, XLSX sheets), use the page number or sheet name. If two sections have the same heading, append a disambiguating suffix (`#2`, `#3`). Chunk IDs are `{section_id}/chunk_{ord}`.

This means `doc_context` can accept a stable `section_id` and the agent can cache it across turns without worrying about re-index invalidation.

### Corrupt / unreadable file handling

Not just encrypted files — also truncated PDFs, DOCX files with broken XML, files that changed encoding mid-stream, zero-byte files, files locked by another process. General pattern:
- Attempt extraction.
- On failure: log the error to `var/logs/`, record the file in `docgraph_documents` with `status = 'error'` and an `error_message` column, skip it.
- `doc_repos` returns an `errors` count so the agent knows something is wrong and can surface it.
- Add `status` and `error_message` columns to `docgraph_documents` schema (missing from the sketch below — see updated schema).

### Language mixing in FTS

SQLite FTS5's default tokenizer (`unicode61`) handles Latin + CJK poorly in mixed-language documents. If a user's folder contains Chinese medical records alongside English notes, FTS queries may miss matches across the language boundary. Two options:
- **Phase 1:** use `unicode61` with `tokenchars` widened for CJK ranges (good enough for MD/TXT).
- **Phase 2+:** if recall is poor, evaluate the `icu` tokenizer extension (requires compiling SQLite with ICU) or fall back to semantic search only for mixed queries.

This is a "measure first, fix later" concern — don't over-engineer before Phase 2 embedding measurements.

---

## Mental model

`codegraph` thinks in **symbols** (functions, classes) and **edges** (calls). `docgraph` thinks in:

- **Documents** — one row per indexed file (path, mime, size, mtime, title, summary).
- **Sections** — hierarchical chunks within a document. For MD/DOCX, headings. For PDF, page + heuristic section breaks. For XLSX, sheets + named ranges. For PPTX, slides. For EML, headers + body parts.
- **Chunks** — embedding-sized slices of section text (e.g. ~512 tokens, overlap ~64). One row per chunk, with vector.
- **Refs** — extracted entities or cross-references: URLs, file paths, citation keys, ID-shaped tokens (invoice numbers, patient IDs, ticket IDs — regex-discovered), `[[wikilinks]]` if present.

The "graph" part is light compared to codegraph — there's no call graph. The interesting edges are:
- Section → parent section (hierarchy)
- Document → document (via shared refs / explicit links)
- Chunk → section → document (ownership)

---

## MCP tools to expose

Mirror codegraph's surface. Names and one-line descriptions:

| Tool | Purpose | Inputs |
|---|---|---|
| `doc_repos` | List indexed folders, with doc + chunk counts and last-index time. Call first when unsure where something lives. | — |
| `doc_search` | Hybrid FTS + semantic search across chunks. Returns ranked hits with `{document, section, snippet, score}`. | `query`, optional `folder`, `mime`, `limit` |
| `doc_outline` | Section tree for a single document. The "table of contents" view — cheap before fetching content. | `path` |
| `doc_context` | Fetch the text of a specific section (or chunk range), with small padding. The analog of `code_context`. | `path`, `section_id` or `chunk_id`, optional `padding` |
| `doc_refs` | Find all documents that mention a given ref (URL, ID, citation key, filename). Cross-document lookup. | `ref`, optional `folder` |

**Padding semantics for `doc_context`:** Unlike codegraph (which pads by lines around a function body), document padding should be by adjacent sections or chunks. Default: include the full parent section plus one adjacent section on each side. If `padding` is specified as a number, include that many adjacent chunks. Rationale: in a document, the unit of context is a section (or slide, or sheet), not a line. A "small padding" on line N of a PDF page is meaningless; a "small padding" on section 3 is the surrounding sections.

**Section ID in `doc_context`:** Accept either `section_id` (stable, path-derived) or `chunk_id` (for fine-grained fetch). If only `path` is given, return the first section (title/abstract). This mirrors how `code_context` works with qualified names vs file paths.

**Search ranking:** `doc_search` should return `{document: {title, path}, section: {id, heading}, snippet, score}`. The snippet is the best-matching chunk text, not an LLM summary. If embeddings are unavailable (Phase 1), rank by FTS `bm25` only and note in the response that semantic ranking is pending. Never return a score without indicating whether it's FTS-only or hybrid.

**`doc_refs` normalization:** Refs are case-sensitive by default; `INV-204871` ≠ `inv-204871`. For ID-shaped refs where the user's pattern is case-insensitive (e.g., patient IDs), the regex config should allow a `case_insensitive` flag per pattern. The handler normalizes the stored ref value to the original casing found in the document, but matches case-insensitively when the pattern flag says so.

**`doc_search` by folder:** When `folder` is omitted, search across all indexed repos. When provided, restrict to that specific repo (matched by root path substring, same semantics as `code_search`'s `repo` parameter).

Open question: do we want a `doc_summary` tool that returns a cached LLM-generated summary per document? Useful but adds a cost surface — defer to v2 unless the agent struggles without it.

---

## Extractor plan (per file type)

Each extractor returns the same shape: `{ title, sections: [{id, level, heading, startOffset, endOffset, text}], refs: [{kind, value, sectionId}] }`. The indexer then chunks `text` and embeds.

| Extension | Library / approach | Notes |
|---|---|---|
| `.md`, `.mdx`, `.rst`, `.txt` | Parse headings directly; treat top of file as untitled section. | Cheapest. Start here. |
| `.html`, `.htm` | `cheerio` or tree-sitter html grammar. Use `<h1>`…`<h6>` as section breaks. | Strip script/style. |
| `.pdf` | Reuse whatever `skills/preprocess-pdf` already uses (probably `pdf-parse` or `pdfjs-dist`). | Page = coarse section. Detect bold/larger fonts as heading candidates if the lib exposes them; otherwise fall back to "page N" sections. Scanned PDFs need OCR — defer or pipe through `preprocess-image`. |
| `.docx` | `mammoth` (HTML conversion) or `docx` lib — whatever's already in the tree. | Headings come through cleanly via styles. |
| `.xlsx` | Reuse what `skills/xlsx` uses. | One section per sheet; named ranges become sub-sections. Embed cell text content; skip pure numeric cells. |
| `.pptx` | Reuse what `skills/pptx` uses. | One section per slide; title + body text. |
| `.eml`, `.msg` | `mailparser` or similar. | Section per message; headers as a structured ref block; thread by `In-Reply-To`. |
| `.json`, `.yaml`, `.toml` | Parse, walk to depth N, treat top-level keys as sections. | Only embed text-valued leaves. Skip if file is config-shaped (heuristic: most values numeric/boolean). |
| `.csv` | Header row + first N rows as section; do NOT embed every row. | Big CSVs are a footgun — cap aggressively. |

**Reference extraction (shared, runs after extraction):**
- URLs (regex)
- Filesystem paths (regex, validated against existence optional)
- Wikilinks `[[...]]` and markdown links
- Citation keys (`@author2023`, `[doi:...]`, `arXiv:...`)
- ID-shaped tokens — user-configurable regex list per folder (e.g. `INV-\d{6}`, `MRN\d+`, `JIRA-\d+`)

---

## Schema sketch

SQLite first (matches codegraph's zero-config default); Postgres parity later.

```sql
docgraph_repos        (id INTEGER PRIMARY KEY, root_path TEXT UNIQUE, indexed_at TEXT, doc_count INTEGER, chunk_count INTEGER, error_count INTEGER)
docgraph_documents    (id INTEGER PRIMARY KEY, repo_id INTEGER, rel_path TEXT, mime TEXT, size INTEGER, mtime TEXT, title TEXT, summary TEXT, indexed_at TEXT, status TEXT DEFAULT 'ok', error_message TEXT)
docgraph_sections     (id TEXT PRIMARY KEY,        -- stable path-derived id (e.g. "reports/q3.md#Financials")
                       document_id INTEGER, parent_id TEXT, level INTEGER, heading TEXT, start_offset INTEGER, end_offset INTEGER)
docgraph_chunks       (id TEXT PRIMARY KEY,         -- stable id (e.g. "reports/q3.md#Financials/chunk_3")
                       document_id INTEGER, section_id TEXT, ord INTEGER, text TEXT, token_count INTEGER, embedding BLOB)
docgraph_refs         (id INTEGER PRIMARY KEY, document_id INTEGER, section_id TEXT, kind TEXT, value TEXT)
docgraph_fts          FTS5 virtual table over sections.text + documents.title
                       -- IMPORTANT: index the FULL section text, NOT individual chunks.
                       -- If each chunk were a separate FTS row, a phrase search for "marketing spend"
                       -- would fail when those two words fall in adjacent chunks (even with overlap).
                       -- FTS5 queries tokenize each indexed row independently; chunk-level FTS
                       -- means no cross-chunk phrase matching. Section-level FTS fixes this.
                       -- Chunks still exist for embedding — they're for semantic search, not FTS.
```

Indexes: `chunks(document_id)`, `sections(document_id, parent_id)`, `refs(value)`, `refs(kind, value)`, `documents(repo_id, rel_path UNIQUE)`.

Reuse codegraph's embedding column convention (whatever format `symbol-embedding-queue.js` writes).

---

## Skill to ship alongside

Create `skills/docgraph/SKILL.md` mirroring the freshly written `skills/codegraph/SKILL.md`:
- Same structure: When to use / When not / Canonical flow / Gotchas.
- Keywords tuned for non-coder phrasing: "find in my notes", "outline this PDF", "what did I write about", "which document mentions", "search my files", "table of contents".
- Make the boundary with `codegraph` explicit: code files → codegraph, everything else → docgraph.
- Make the boundary with `wiki` and `memory` explicit (see Open Questions — resolve before writing the skill).

Also add one line to `skills/coding-standards` (or wherever tool-choice nudges live) telling the agent to prefer docgraph over `read_file` for document lookups in indexed folders.

---

## Agent protocol: wiki vs. docgraph vs. memory

The agent has three knowledge sources; a clear protocol prevents confusion:

| Source | What it holds | When to use |
|--------|--------------|-------------|
| `memory` | Atomic facts the agent explicitly stored (user preferences, decisions, key events). | "What did the user tell me about X?" — single facts. |
| `wiki` | LLM-authored synthesis articles, grounded in memories, curated over time. | "What do I know about X as a composite topic?" — multi-fact synthesis. |
| `docgraph` | Raw file content, indexed but not interpreted. The user's source material. | "What did the user *write* about X?" — document lookup. |

**Decision rule for the agent:**
1. If the question is about a fact the agent stored → `recall` (memory).
2. If the question is about a recurring topic the agent has synthesized → `wiki_search` / `wiki_get`.
3. If the question is about what's *in the user's files* → `doc_search` / `doc_outline` / `doc_refs`.
4. If `doc_search` returns nothing and the topic seems like something the agent should have synthesized, fall back to `wiki_search`.
5. If all three return nothing, use `read_file` as last resort.

This keeps `wiki` as the curated knowledge base and `docgraph` as the raw file index. They do NOT overlap — one is synthesized, the other is source material. The docgraph skill (`skills/docgraph/SKILL.md`) must encode this protocol so every agent session follows the same decision tree.

This resolves Open Question #1: answer is **(a)** — docgraph replaces wiki for file-backed searches; wiki keeps its curated knowledge-base role. The agent picks based on whether the content is "raw file content" vs. "synthesized knowledge."

---

## Implementation phases

Each phase is independently shippable. Don't combine.

**Phase 0 — decide.** Resolve every Open Question below. Update this file. Get user signoff before any code.

**Phase 1 — skeleton + markdown.** SQLite backend, walker (shared with codegraph if cleanly extractable), MD/TXT extractor only, `doc_repos` + `doc_search` (FTS only, no embeddings) + `doc_outline` + `doc_context`. Verify on a folder of the user's own notes.

**Phase 2 — embeddings.** Plug into the existing embedding queue. `doc_search` becomes hybrid. Measure: does semantic actually improve recall on user's real queries, or is FTS enough?

**Phase 3 — PDF + DOCX.** Reuse existing skill libs. Heading detection quality is the success bar — if PDFs come out as one giant section, the outline tool is useless.

**Phase 4 — XLSX + PPTX + EML.** Per-format extractor.

**Phase 5 — refs + `doc_refs` tool.** Regex extractors + user-configurable ID patterns per folder.

**Phase 6 — Postgres backend parity.** Same shape as codegraph's pg backend.

**Phase 7 — watcher.** Mirror `lib/codegraph/watcher.js`. Re-index on change. Debounce.

---

## Open questions (resolve in Phase 0)

1. **Relationship to `wiki`.** ✅ RESOLVED — see "Agent protocol" section above. docgraph for raw files, wiki for curated synthesis. They don't overlap.
2. **Where do indexed folders come from?** Same pattern as codegraph: env var `APERIO_DOCGRAPH_PATHS` (comma-separated absolute paths) + an API endpoint `POST /api/docgraph/index` that accepts `{ path }` and auto-adds to the allowlist (mirrors codegraph's `POST /api/codegraph/index`). Also a `doc_index` MCP tool so the agent can trigger indexing conversationally ("please index my Documents folder"). The env var is for server startup; the API/MCP tool is for runtime.
3. **Permissioning.** ✅ RESOLVED — same allowlist as codegraph. `isReadPathAllowed` already gates all file access. Adding a docgraph-specific allowlist would create two permission surfaces to audit. One allowlist, one gate. The `APERIO_DOCGRAPH_PATHS` env var feeds into the same allowlist via `setAllowlist`.
4. **Chunk size / overlap.** ✅ RESOLVED — 512 tokens / 64 overlap. Use `gpt-tokenizer` (already in deps) for token counting. Revisit after Phase 2 measurements, but don't block Phase 1 on tuning.
5. **OCR for scanned PDFs.** In scope for v1 or v2? OCR is expensive — probably v2, with a clear "this PDF has no extractable text" signal in v1.
6. **`doc_summary` tool.** ✅ CONFIRMED — defer to v2. If the agent consistently struggles without summaries, revisit. Phase 1–3 gives enough signal to decide.
7. **Encrypted / password-protected files.** ✅ RESOLVED — skip + log + surface. File gets `status = 'error'` with `error_message = 'encrypted or password-protected'`. `doc_repos` shows an error count. The agent can surface this to the user: "3 files couldn't be indexed (2 encrypted, 1 corrupt)."
8. **Privacy posture.** ✅ CONFIRMED — local-only by default. `lib/helpers/embeddings.js` defaults to Transformers.js (local, no network). Voyage API only activates when `VOYAGE_API_KEY` is explicitly set. Legal/medical users can verify by checking that `EMBEDDING_PROVIDER` is not set (or is `transformers`). Add a note to the docgraph skill: "If you handle protected documents, confirm `EMBEDDING_PROVIDER` is `transformers` or unset before indexing."

### New open question (raised during review)

9. **Extraction parallelism.** The indexer walks files serially in codegraph, but document extraction is I/O-heavy (reading PDFs, parsing XML). For a 500-doc folder, serial extraction could take minutes. Should the docgraph indexer use a worker pool (e.g., `worker_threads` or a simple concurrency limiter)? **Recommendation:** Phase 1 (MD only) doesn't need it — MD extraction is near-instant. Add a concurrency limiter (default 4) in Phase 3 when PDF/DOCX extraction is added. Don't over-engineer in Phase 1.

---

## Success criteria

A non-coder user points Aperio at a folder of ~500 mixed documents. The agent can:

- Tell them what's in the folder (`doc_repos` → counts by mime).
- Answer "where did I write about X" with the right document and section, in one search call.
- Outline a 100-page PDF in under a second from cache.
- Find every document mentioning invoice `INV-204871` with one `doc_refs` call.
- Not load any full document into context unless the user explicitly asks for it.

If those five hold, the feature is real. If any of them require the agent to fall back to `read_file` + grep on >20% of queries, the extractor for that format isn't good enough yet.

---

## How to use this brief in a future session

Open with: *"Read `docgraph-feature.md`, confirm the open questions are still unresolved (or note which the user has since answered), then propose a Phase 1 implementation plan against the current state of `lib/codegraph/` for me to review."*

Do not start writing code until the user has signed off on Phase 0 decisions.