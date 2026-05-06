---
name: working-with-files
description: >
  Use this skill when editing non-code files: Markdown, DOCX, PDF, YAML, JSON,
  TOML, plaintext, or any other document format. Covers surgical editing
  principles that don't apply cleanly through coding-standards alone. Matched
  by file extension when the target isn't a code file.
metadata:
  keywords: "editing, markdown, docx, pdf, json, yaml, plaintext, files, documents, surgical edit, file modification"
  category: "file-management"
  load: "on-demand"
---

# Working With Files

## Layer 1 — Universal Principles (all file types, always)

### Read Before Edit
- Always read the current state on disk before making any change. Guessing what's in a file leads to broken content.
- For binary formats (DOCX, PDF), read the parsed structure — not raw bytes.

### Smallest Possible Diff
- Change exactly what's wrong. Leave everything else untouched.
- If a file needs many isolated fixes, apply them one at a time. Never batch unrelated changes into a single rewrite.

### Patch Size Tiers

| Fix size | Method |
|----------|--------|
| 1–2 lines/blocks | Inline markdown patch block (no write needed) |
| 3–20 lines | Targeted replacement on the exact changed section |
| 20+ lines or structural refactor | Full read verification first, then edit in stages |

### Verify After Every Edit
- Re-read the affected section after writing to confirm correctness.
- For structured formats (JSON, YAML), validate syntax after change.
- For rendered formats (DOCX, PDF), note that verification may require opening in the native application.

---

## Layer 2 — File-Type-Specific Guidance

### Markdown / Plaintext / RST / AsciiDoc
Same surgical approach as code:
- Target specific paragraphs, list items, or code blocks by content or heading context.
- Use str_replace on the exact text block.
- Preserve whitespace and formatting — trailing spaces, line breaks, and indentation matter in Markdown.

### JSON / YAML / TOML
- Parse first, modify in memory, write back. Do not string-replace blindly — you risk breaking structure.
- Validate syntax after every write. A malformed config file is worse than no change.
- Preserve comments if the format supports them (YAML, TOML). JSON has no comments — do not try to inject them.

### DOCX (.docx)
DOCX is a ZIP of XML files. Treat it as a structured document, not raw text:
- Use `python-docx` (or equivalent library) to read the document tree.
- Find the target paragraph by content matching, structural position, or style.
- Modify only that paragraph/run in memory, then write the full document back.
- Do **not** attempt raw XML edits unless you understand the OpenXML schema — easy to corrupt.
- If the change affects headers, footers, or styles, note that these live in separate XML parts inside the archive.

### PDF
PDFs are presentation-layer documents, not editable text:
- **Text-native PDFs**: Use `extractPdfText` (from preprocess-pdf skill) to read content. To modify, regenerate from the source (Markdown, DOCX, etc.) — PDF was never meant for surgical text edits.
- **Scanned PDFs**: No text layer exists. Use `preprocess-image` + `read-image` for visual analysis. Modification requires OCR → edit source → re-export.
- **Minor annotations** (comments, highlights): Can use `pypdf` or similar to add annotation layers without touching content.
- **Never** try to str_replace inside a PDF binary — it will corrupt the file.

### Plain Binary Files (.bin, .dat, custom formats)
- No surgical text editing. These require format-specific tools or full regeneration.
- State the limitation clearly: binary format, can't edit as text.

### Images (.png, .jpg, .gif, .webp)
- Out of scope for text-based editing. Use `preprocess-image` + `read-image` for analysis.
- For modifications, use image editing tools — don't attempt pixel manipulation through text.

---

## When to Use Which Skill

| File type | Skill to match |
|-----------|----------------|
| .js, .ts, .py, .go, .rs, .cs, .java, etc. | coding-standards |
| .md, .txt, .rst, .adoc | working-with-files |
| .json, .yaml, .yml, .toml | working-with-files |
| .docx | working-with-files |
| .pdf | working-with-files + preprocess-pdf |
| .png, .jpg, .gif, .webp | preprocess-image + read-image |
| .bin, .dat, .exe | working-with-files (to state limitation) |

---

## Relationship to Other Skills

| Skill | Role |
|-------|------|
| coding-standards | Handles surgical editing for code files only — see its Surgical File Editing section |
| working-with-files | This skill — same principle, different file types |
| preprocess-pdf | Use alongside this skill when PDF content needs extracting before editing |
| preprocess-image | Use alongside for image analysis — image files cannot be surgically edited as text |
