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

```
docgraph_repos        (id, root_path, indexed_at, doc_count, chunk_count)
docgraph_documents    (id, repo_id, rel_path, mime, size, mtime, title, summary, indexed_at)
docgraph_sections     (id, document_id, parent_id, level, heading, start_offset, end_offset)
docgraph_chunks       (id, document_id, section_id, ord, text, token_count, embedding BLOB)
docgraph_refs         (id, document_id, section_id, kind, value)
docgraph_fts          FTS5 virtual table over chunks.text + sections.heading + documents.title
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

1. **Relationship to `wiki`.** Three options: (a) docgraph replaces wiki for file-backed content, wiki keeps the curated knowledge-base role; (b) wiki rewrites itself on top of docgraph as a backend; (c) they stay separate and the agent picks based on whether content is "curated note" vs "raw file." Recommendation: (a), but the user owns this call.
2. **Where do indexed folders come from?** Same `APERIO_CODEGRAPH_PATHS`-style env? A new settings UI entry? A `doc_index` MCP tool that lets the agent index on demand?
3. **Permissioning.** `isReadPathAllowed` already gates codegraph reads. Same allowlist, or separate? Doctors and lawyers will care.
4. **Chunk size / overlap.** Pick a default (suggest 512 tokens / 64 overlap) and revisit after Phase 2 measurements.
5. **OCR for scanned PDFs.** In scope for v1 or v2? OCR is expensive — probably v2, with a clear "this PDF has no extractable text" signal in v1.
6. **`doc_summary` tool.** Defer (see MCP tools section) — confirm.
7. **Encrypted / password-protected files.** Skip with a logged warning, or fail loudly? Probably skip + surface in `doc_repos` status.
8. **Privacy posture.** Embeddings of medical/legal/financial docs need to stay local. Confirm the embedding generator is local-only (check `lib/helpers/embeddings.js`) before shipping to those user segments.

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
