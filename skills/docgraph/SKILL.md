---
name: docgraph
description: >
  Use this skill when finding, outlining, or quoting content in the user's
  indexed document folders — notes, write-ups, reports, Markdown, plain text,
  HTML, PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), and email
  (.eml) — but NOT code.
  Prefer the document graph (passage search, section outlines, text slices)
  over full-file reads and wide greps — it is cheaper and more precise. Covers
  when to reach for which tool and the canonical lookup sequence.
metadata:
  keywords: "find in my notes, where did I write about, what did I write, search my files, search my notes, which document mentions, which file mentions, which file references, find invoice, find ticket, outline this, table of contents, summarize this document, my docs, my documents, markdown notes, spreadsheet, slide deck, email, find the section about, look it up in my notes"
  category: "document-navigation"
  load: "on-demand"
---

# Document Graph

A pre-indexed graph over the user's **document** folders (Markdown, `.txt`/`.rst`, HTML, PDF, Word `.docx`, Excel `.xlsx`, PowerPoint `.pptx`, email `.eml`), exposed as five MCP tools:
`doc_repos`, `doc_search`, `doc_outline`, `doc_context`, `doc_refs`.

Reach for these **before** `read_file` or recursive grep whenever the question is about *what the user wrote* — where a topic is discussed, what a document contains, or the text of a particular section.

---

## Boundary with other tools (read this first)

- **Code files** (`.js`, `.ts`, configs, source) → use **`codegraph`** (`code_search` etc.), never docgraph. docgraph deliberately does not index code.
- **Curated knowledge base** (facts the user saved into a knowledge store) → use **`wiki`**. docgraph and wiki are peers: docgraph indexes *raw files on disk*; wiki holds *curated notes*. If the user is asking about a file in a folder, that's docgraph.
- **Discrete facts / preferences** (names, settings, "remember that…") → use **`memory`**.
- When unsure whether a folder is indexed, call **`doc_repos`** first — don't guess.

## When to use

- "Where did I write about X?" → `doc_search` → `doc_context`
- "What's in this document?" / "Outline this" / "Table of contents" → `doc_outline`
- "Show me the section on Y" → `doc_search` (or `doc_outline`) → `doc_context`
- "Which of my documents mention invoice/ticket/ID/URL Z?" → `doc_refs` (exact reference lookup) — for free-text topics use `doc_search` instead
- "What folders / how many documents do I have indexed?" → `doc_repos`
- Any time you'd otherwise `read_file` a long document to find one passage

## When NOT to use

- Document is not in an indexed folder (check with `doc_repos` first if unsure)
- Format not yet covered by an extractor (today: Markdown, `.txt`/`.rst`, HTML, PDF, `.docx`. XLSX, PPTX, EML are later phases). Fall back to `read_file` / the format-specific skill and say so plainly.
- Code → `codegraph`. Curated notes → `wiki`. Facts → `memory`.
- The whole document legitimately matters (e.g. the user asks you to read it end to end) → `read_file`.

---

## Canonical flow

```
unknown folder → doc_repos     (which folders are indexed; counts by mime)
find a topic    → doc_search    (ranked passages: {document, section, snippet})
map a document  → doc_outline   (section tree before fetching text)
read a slice    → doc_context   (section_id or chunk_id → just that text)
find a reference → doc_refs      (exact ID/URL/email/citation → every doc that mentions it)
```

A typical "find and quote" is two calls: `doc_search` → `doc_context` with the hit's `section.id`. To read a passage verbatim, pass the hit's `chunk_id` to `doc_context`.

---

## Reading results

`doc_search` returns ranked hits, each shaped:

```
{ score, document: { rel_path, title, mime, repo, root_path },
  section: { id, heading, level }, chunk_id, snippet }
```

- To fetch the surrounding section: `doc_context({ path: document.rel_path, section_id: section.id, folder: document.repo })`.
- To fetch just the matched passage: `doc_context({ path: document.rel_path, chunk_id })`.
- **Never infer which folder a relative path belongs to from the path itself.** Multiple folders can share a layout. Read `repo` / `root_path` straight off the result, and pass `folder` to follow-up calls so the lookup resolves in the right place. If a `folder` substring matches more than one indexed folder, the tool errors with the candidates — pass a longer substring.

---

## Gotchas

- **Indexing.** With `APERIO_DOCGRAPH=on` a watcher keeps the index live (re-indexes on save, ~400 ms debounce). Otherwise the index is a point-in-time snapshot — index/refresh manually with `node lib/docgraph/indexer.js <path>`. If a search clearly misses a doc the user just added, the folder may not be indexed yet.
- **Hybrid search ranking.** `doc_search` blends FTS with semantic embeddings when available. Distinctive keywords (names, IDs, error strings) rank best via FTS; conceptual queries ("notes about pricing strategy") lean on semantics. Narrow with `folder` or `mime` if results are broad.
- **Snippets are previews, not the whole section.** They're truncated (~320 chars). Always `doc_context` before quoting at length.
- **Sections follow headings.** Markdown/HTML/DOCX sections are a heading plus the body up to the next heading; content before the first heading is an untitled preamble (level 0). **PDF sections are one-per-page** (`heading: "Page N"`) — there's no font-based heading detection yet, so `doc_outline` on a PDF is a page list, not a true ToC.
- **Section model per format.** XLSX = one section per sheet (heading = sheet name; rows are `cell | cell | …`). PPTX = one section per slide (`Slide N`, speaker notes appended). EML = one section (header summary + decoded body). DOCX/HTML/Markdown = heading-based.
- **Scanned / image-only PDFs.** docgraph extracts only embedded text. If a PDF (or some of its pages) is scanned, those pages are skipped and `doc_outline`/`doc_repos` flag it via the document `summary` ("N/M pages have no extractable text…"). To read those, OCR on demand with the **`pdf`** / **`preprocess-image`** skills — docgraph won't have that text.
- **Unsupported formats fall through to file reads.** Images, audio, and raw binary aren't indexed. Don't silently miss results — say the format isn't indexed and fall back to `read_file` / the format-specific skill.
