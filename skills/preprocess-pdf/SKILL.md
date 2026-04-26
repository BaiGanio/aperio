---
name: preprocess-pdf
description: "Use this skill when a .pdf file is uploaded or a file path points to a PDF. The skill extracts text from text-native PDFs and detects scanned (image-only) PDFs that need visual analysis instead. Triggers: any .pdf attachment in the web UI, any file path ending in .pdf, or when a user asks to summarize/analyze/search a PDF document. Do NOT use for creating, merging, splitting, or modifying PDFs — this skill is read-only extraction only."
compatibility: "Aperio MCP server — requires pdfjs-dist (npm install pdfjs-dist)"
---

# PDF Preprocessing

## Why this skill exists

PDFs come in two fundamentally different forms that require different
handling:

**Text-native PDFs** — created by Word, LibreOffice, LaTeX, browsers,
or any software that exports to PDF. Text is embedded as selectable
characters. Can be extracted and inlined into context directly.

**Scanned PDFs** — photographed or photocopied documents where each
page is a raster image. No embedded text. Must be treated as images
and passed to a vision model.

The `extractPdfText` function in `mcp/assets/preprocessPdf.js` detects
which type you have and returns a `type` field the router acts on.

## Result types

| Type       | Meaning | What the router does |
|------------|---------|----------------------|
| `"text"`   | All pages have extractable text | Inline as fenced text block |
| `"scanned"`| No pages have text (pure image PDF) | Save to disk, hint to use `preprocess-image` |
| `"mixed"`  | Some pages text, some scanned | Inline text pages, list scanned page numbers |
| `"empty"`  | PDF parsed but contains nothing | Hint only, no content block |

## Limits

| Limit | Value | Reason |
|-------|-------|--------|
| Max inline text | 80,000 chars (~20K tokens) | Context window safety |
| Min chars/page to count as text | 30 | Filters out pages with only page numbers or headers |
| Max PDF size (enforced upstream) | 20 MB | Matches the existing image upload limit |

When text is truncated, the result includes `truncated: true` and the
agent receives the saved file path to use `read_file` for the rest.

## Handling each result type

### `"text"` — normal PDF

The full text is inlined into the message as a fenced block. The agent
reads it directly, no tools needed.

The saved path is included in the system hint in case the agent needs
to reference the original file later (e.g., to pass to `read_image`
for a specific figure).

### `"scanned"` — image-only PDF

No text is available. The system hint tells the agent:
- The file has been saved to `uploads/<uuid>.pdf`
- To use `preprocess_image` or `read_image` with that path
- Or to ask the user to share individual page images

The agent should explain the situation to the user and offer options
rather than silently returning no content.

### `"mixed"` — partial extraction

Text from extractable pages is inlined. The hint lists which page
numbers were scanned (e.g., `Pages with no text: 1, 4, 7`).

The agent should note to the user that those pages were image-only and
offer to analyze them visually if the content matters.

### `"empty"` — blank or corrupted

Rare. Happens with corrupted PDFs, placeholder files, or PDFs that
contain only vector graphics with no text layer. The agent should
inform the user and suggest re-exporting the document.

## Tool workflow for scanned PDFs

When `extractPdfText` returns `"scanned"`, the recommended agent flow is:

```
1. Inform user: "This PDF appears to be a scanned document."
2. Ask if they want visual analysis of specific pages.
3. If yes: use preprocess_image with the saved PDF path.
   (Note: preprocess_image handles the first page of a PDF;
    for multi-page scans, ask the user to share individual pages.)
4. Use read_image on the preprocessed result to see the content.
```

## Implementation

- `mcp/assets/preprocessPdf.js` — `extractPdfText(buffer)` function
- Called from the attachment router in `server.js` (PDF path)
- Dependency: `pdfjs-dist` (`npm install pdfjs-dist`)

The Node.js worker is disabled (`GlobalWorkerOptions.workerSrc = ""`)
since pdfjs-dist runs in-process in the Aperio server context.

## What this skill does NOT cover

- Creating PDFs → not in scope
- Merging, splitting, rotating pages → not in scope
- OCR on scanned pages → use `preprocess_image` + `read_image` instead
- Extracting embedded images from PDFs → not currently implemented;
  if needed, add a `pdfimages`-equivalent pass using pdfjs page rendering
- Password-protected PDFs → `getDocument()` will throw; handle upstream
  by checking for a password prompt and returning a clear error hint