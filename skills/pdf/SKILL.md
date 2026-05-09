---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.
license: Proprietary. LICENSE.txt has complete terms
---

# PDF Processing Guide

## Overview

This guide covers PDF processing using the Node.js libraries already in this project. All scripts are in `skills/pdf/scripts/` and run with `node <script>.js`. If you need to fill out a PDF form, read FORMS.md and follow its instructions.

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
| Render PDF pages to PNG | `convert_pdf_to_images.js` |
| Visualize bounding boxes on a page image | `create_validation_image.js` |
| Merge / split / rotate | `qpdf` CLI |
| OCR scanned PDFs | `preprocess-pdf` skill + vision model |
| Fill PDF forms (full workflow) | See FORMS.md |

## Next Steps

- For filling PDF forms, follow the instructions in FORMS.md
- For reading PDFs uploaded by the user, use the `preprocess-pdf` skill (already wired into the server)
