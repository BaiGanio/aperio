---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.
license: Proprietary. LICENSE.txt has complete terms
metadata:
  keywords: "pdf, pdf file, pdf document, pdf form, scanned pdf, pdf attachment, pdf pages, pdf text, pdf extraction, create pdf, generate pdf, merge pdf, split pdf"
  category: "file-generation"
  load: "on-demand"
---

# PDF Processing Guide

## Overview

This guide covers PDF processing using the Node.js libraries already in this project. All scripts are in `skills/pdf/scripts/` and run with `node <script>.js` (via the `run_node_script` tool). If you need to fill out a PDF form, read FORMS.md and follow its instructions.

## Generating a new PDF

When the user asks to **produce / generate a PDF**, pick the route by content:

- **Formatted document (report, letter, memo, anything with headings, tables, page flow) — preferred:** author it as a Word doc first, then convert to PDF. Use the `generate_docx` MCP tool (or the `docx-advanced` skill for images/footnotes/custom styles), then convert with `run_python_script` → `skills/docx/scripts/office/soffice.py` with args `["--headless", "--convert-to", "pdf", "<source.docx>", "--outdir", "<scratch workspace>"]`. For `<source.docx>` use the absolute path from the `Saved at:` line of the `generate_docx` result (the real on-disk name is uuid-prefixed in the scratch workspace — do **not** reconstruct it from the clean filename). Set `--outdir` to this conversation's scratch workspace (given in the system prompt); the PDF lands there and auto-surfaces as a download card. Requires LibreOffice (`soffice`). This gives proper typography and layout for free.

- **Simple / programmatic PDF (zero extra deps):** build it directly with `pdf-lib` via `write_file` + `run_node_script`. Good for single-page output, certificates, stamping text/images onto a blank page, or precise coordinate-based drawing:

```javascript
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "fs";

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]); // US Letter
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText("Hello, PDF", { x: 72, y: 700, size: 24, font, color: rgb(0, 0, 0) });
writeFileSync("output.pdf", await doc.save());
```

Do **not** reach for Python/reportlab — those libraries are not installed. `pdf-lib`, `pdfjs-dist`, and `sharp` are.

## Dependencies

| Package | Purpose | Already installed? |
|---------|---------|-------------------|
| `pdfjs-dist` | Read/inspect PDFs, extract text and graphics | ✅ Yes |
| `pdf-lib` | Write/fill PDFs, embed text | ✅ Yes |
| `sharp` | Image manipulation (validation images) | ✅ Yes |
| `poppler` (`pdftoppm`) | Render PDF pages to PNG | Install: `brew install poppler` |

## Scripts (`skills/pdf/scripts/`)

### check_fillable_fields.js
Detects whether a PDF has AcroForm fields (fillable form) or is a static layout.

```bash
node skills/pdf/scripts/check_fillable_fields.js input.pdf
```

### extract_form_field_info.js
Outputs a JSON array of all fillable fields with type, page, rect, and allowed values. Add a `"value"` key to each entry before passing to `fill_fillable_fields.js`.

```bash
node skills/pdf/scripts/extract_form_field_info.js input.pdf fields.json
```

Field types: `text`, `checkbox` (includes `checked_value`/`unchecked_value`), `radio_group` (includes `radio_options`), `choice` (includes `choice_options`).

### fill_fillable_fields.js
Fills an AcroForm PDF using the JSON produced by `extract_form_field_info.js` (with `"value"` added to each field).

```bash
node skills/pdf/scripts/fill_fillable_fields.js input.pdf fields_with_values.json output.pdf
```

Validates field IDs and value types before writing. Exits with an error if any value is invalid.

### extract_form_structure.js
Analyzes a **non-fillable** PDF to find text label positions, horizontal rule lines, and small checkbox rectangles. Used to determine where to place annotations when filling static forms.

```bash
node skills/pdf/scripts/extract_form_structure.js input.pdf structure.json
```

Output: `{ pages, labels, lines, checkboxes, row_boundaries }` all with page-relative coordinates (top-left origin, matching pdfplumber convention).

### fill_pdf_form_with_annotations.js
Fills a non-fillable PDF by drawing text at specified coordinates. Takes a JSON with `pages` and `form_fields` entries that include `entry_bounding_box` and `entry_text`. Supports both PDF-coord bounding boxes (`pdf_width` in page info) and image-coord bounding boxes (`image_width`/`image_height`).

```bash
node skills/pdf/scripts/fill_pdf_form_with_annotations.js input.pdf fields.json output.pdf
```

Font names map to standard PDF fonts (Arial → Helvetica, Times New Roman → Times Roman, Courier → Courier). Font colors are hex strings (e.g. `"000000"`).

### check_bounding_boxes.js
Validates a `fields.json` (used by `fill_pdf_form_with_annotations.js`) for overlapping bounding boxes and entries that are too short for their font size.

```bash
node skills/pdf/scripts/check_bounding_boxes.js fields.json
```

### convert_pdf_to_images.js
Converts each page of a PDF to a PNG image at 200 DPI, capped at 1000px on the longest side. **Requires poppler** (`brew install poppler`).

```bash
node skills/pdf/scripts/convert_pdf_to_images.js input.pdf ./output_dir/
```

### create_validation_image.js
Draws red (entry) and blue (label) bounding boxes on a rendered page image for visual inspection. Reads the same `fields.json` format as `fill_pdf_form_with_annotations.js`.

```bash
node skills/pdf/scripts/create_validation_image.js 1 fields.json page_1.png validation.png
```

## Command-Line Tools (system)

### qpdf — merge / split / rotate / decrypt
```bash
# Merge PDFs
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split pages 1-5
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf

# Rotate page 1 by 90 degrees
qpdf input.pdf output.pdf --rotate=+90:1

# Remove password
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
```

### pdftotext — extract text
```bash
pdftotext -layout input.pdf output.txt
```

### pdfimages — extract embedded images
```bash
pdfimages -j input.pdf output_prefix
```

## Quick Reference

| Task | Tool |
|------|------|
| Check if PDF has form fields | `check_fillable_fields.js` |
| List fillable fields + positions | `extract_form_field_info.js` |
| Fill AcroForm fields | `fill_fillable_fields.js` |
| Find text/line/checkbox positions in static PDF | `extract_form_structure.js` |
| Fill static PDF by overlaying text | `fill_pdf_form_with_annotations.js` |
| Validate overlay coordinates | `check_bounding_boxes.js` |
| Generate a new PDF (formatted doc) | `generate_docx` → `soffice.py --convert-to pdf` |
| Generate a new PDF (simple/programmatic) | `pdf-lib` via `write_file` + `run_node_script` |
| Render PDF pages to PNG | `convert_pdf_to_images.js` |
| Visualize bounding boxes on a page image | `create_validation_image.js` |
| Merge / split / rotate | `qpdf` CLI |
| OCR scanned PDFs | Aperio auto-preprocesses uploads; for scanned result type, use vision model |
| Fill PDF forms (full workflow) | See FORMS.md |
| Convert a Word doc → PDF | Use the **docx** skill (LibreOffice via `soffice.py` + `run_python_script`) — the pdf libraries here do not render `.docx` |

## Next Steps

- For filling PDF forms, follow the instructions in FORMS.md
- PDFs uploaded via the web UI are automatically pre-processed by Aperio's attachment router (text extraction and scanned detection). The router's result types are documented in `skills/preprocess-pdf/SKILL.md` as an internal reference.
