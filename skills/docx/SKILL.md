---
name: docx
description: "Use this skill whenever the user wants to create, read, or convert Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce a document, report, memo, letter, summary, or template as a Word file. Also use when reading or extracting content from an existing .docx file, or converting a .docx to PDF. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks. For complex operations on existing documents (tracked changes, comments, XML editing, inserting images, custom styles), use the docx-advanced skill instead."
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX — create, read, and convert

## IMPORTANT: Use the `generate_docx` Tool to Create New Documents

When the user asks to **create** a new Word document, report, summary, memo, or any `.docx` file from scratch, call the `generate_docx` MCP tool directly. Do NOT write a script. The tool generates the `.docx` binary, saves it, and surfaces a one-click download card in the chat.

```
Tool: generate_docx
Input: {
  filename: "report.docx",
  sections: [
    {
      heading: "Section Title",       // optional — renders as Heading 1
      paragraphs: [
        "Plain text paragraph.",
        { type: "table", rows: [["Col A", "Col B"], ["val1", "val2"]] }
      ]
    }
  ]
}
```

Use `write_file` + `run_node_script` (see `docx-advanced` skill) only for documents that require images, footnotes, custom styles, headers/footers, or other advanced formatting. For everything else, `generate_docx` is faster and simpler.

## Running in Aperio

- **Create new document (simple):** `generate_docx` MCP tool — no script needed.
- **Create new document (advanced):** load the `docx-advanced` skill.
- **Edit existing document** (tracked changes, comments, XML): load the `docx-advanced` skill.
- **Read/analyze content:** `run_python_script` → `<repo>/skills/docx/scripts/office/unpack.py` with args `["/abs/document.docx", "/abs/unpacked"]`. Then read the XML files.
- **Convert .docx → PDF:** `run_python_script` → `<repo>/skills/docx/scripts/office/soffice.py` with args `["--headless", "--convert-to", "pdf", "<source.docx>", "--outdir", "<scratch workspace>"]` (needs LibreOffice).
  - Use the **absolute path** of the source `.docx` — for a file you just made with `generate_docx`, that is the path printed on the `Saved at:` line of the tool result (the on-disk name is uuid-prefixed inside the scratch workspace, **not** the clean `filename` shown in the download card, so do not reconstruct it yourself).
  - Set `--outdir` to this conversation's **scratch workspace** (the absolute path given to you in the system prompt). The resulting PDF lands there and is surfaced to the user as a download card automatically — no extra step needed.

**Dependencies:**
- `generate_docx` — always available, zero setup.
- `lxml`, `defusedxml` (pip) — needed for unpack/pack/validate. Install via Settings → Extras.
- LibreOffice (`soffice`) — needed for PDF conversion and accepting tracked changes. Install via Settings → Extras.
