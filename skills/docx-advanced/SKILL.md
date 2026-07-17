---
name: docx-advanced
description: "Use this skill for complex Word document operations that go beyond simple creation: editing existing .docx files (tracked changes, comments, find-and-replace), inserting or replacing images, custom styles (headings, fonts, page size), footnotes, headers and footers, table of contents, multi-column layouts, numbered lists, bookmarks and hyperlinks, accepting or rejecting revisions, converting .doc to .docx, or when generate_docx is insufficient and a custom docx-js script is needed. Do NOT use for simple document creation — use the docx skill with generate_docx instead."
license: Proprietary. LICENSE.txt has complete terms
metadata:
  keywords: "tracked changes, existing word document, comments, revision, xml, edit existing, footnotes, headers, footers, custom styles, images, bookmarks, hyperlinks, table of contents, numbered list, multi-column, page size, letterhead, template"
  depends-on: docx
---

# DOCX Advanced — scripted creation, editing, and XML

## Creating New Documents with docx-js (Advanced)

Use this path when `generate_docx` is insufficient — images, footnotes, custom styles, headers/footers, TOC, etc.

**Workflow in Aperio:**
1. `write_file` a `.js` script into the session workspace.
2. `run_node_script` it to emit the `.docx`.
3. Validate: `run_python_script` → `<docx>/scripts/office/validate.py` with args `["/abs/doc.docx"]`.

**ESM only** — Aperio is `"type": "module"`. Use `import` (never `require`) and top-level `await`:

```javascript
import fs from "fs";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  Header, Footer, AlignmentType, PageOrientation, LevelFormat, ExternalHyperlink,
  InternalHyperlink, Bookmark, FootnoteReferenceRun, PositionalTab,
  PositionalTabAlignment, PositionalTabRelativeTo, PositionalTabLeader,
  TabStopType, TabStopPosition, Column, SectionType,
  TableOfContents, HeadingLevel, BorderStyle, WidthType, ShadingType,
  VerticalAlign, PageNumber, PageBreak,
} from "docx";

const doc = new Document({ sections: [{ children: [/* content */] }] });
const buffer = await Packer.toBuffer(doc);
fs.writeFileSync(new URL("./doc.docx", import.meta.url), buffer);
console.log("wrote doc.docx");
```

### Page Size

```javascript
// CRITICAL: docx-js defaults to A4 — always set explicitly
sections: [{
  properties: {
    page: {
      size: { width: 12240, height: 15840 }, // US Letter (8.5×11 in DXA)
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } // 1-inch margins
    }
  },
  children: [/* content */]
}]
```

**Landscape:** pass portrait dimensions and add `orientation: PageOrientation.LANDSCAPE` — docx-js swaps them internally.

### Styles

```javascript
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 24 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 } },
    ]
  },
  sections: [{ children: [] }]
});
```

### Lists (NEVER use unicode bullets)

```javascript
// ❌ WRONG
new Paragraph({ children: [new TextRun("• Item")] })

// ✅ CORRECT — use numbering config
const doc = new Document({
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("Bullet")] }),
      new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("Number")] }),
    ]
  }]
});
```

### Tables

**CRITICAL: Tables need dual widths** — set `columnWidths` on the table AND `width` on each cell.

```javascript
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

new Table({
  width: { size: 9360, type: WidthType.DXA }, // Always DXA — NEVER PERCENTAGE (breaks Google Docs)
  columnWidths: [4680, 4680],                  // Must sum to table width
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders,
          width: { size: 4680, type: WidthType.DXA },
          shading: { fill: "D5E8F0", type: ShadingType.CLEAR }, // CLEAR not SOLID
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [new Paragraph({ children: [new TextRun("Cell")] })]
        })
      ]
    })
  ]
})
```

### Images

```javascript
// CRITICAL: type is required
new Paragraph({
  children: [new ImageRun({
    type: "png",
    data: fs.readFileSync("image.png"),
    transformation: { width: 200, height: 150 },
    altText: { title: "Title", description: "Desc", name: "Name" }
  })]
})
```

### Headers / Footers

```javascript
sections: [{
  headers: {
    default: new Header({ children: [new Paragraph({ children: [new TextRun("Header")] })] })
  },
  footers: {
    default: new Footer({ children: [new Paragraph({
      children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] })]
    })] })
  },
  children: []
}]
```

### Footnotes

```javascript
const doc = new Document({
  footnotes: {
    1: { children: [new Paragraph("Footnote text")] },
  },
  sections: [{
    children: [new Paragraph({
      children: [new TextRun("Body text"), new FootnoteReferenceRun(1)]
    })]
  }]
});
```

### Hyperlinks

```javascript
// External
new Paragraph({
  children: [new ExternalHyperlink({
    children: [new TextRun({ text: "Click here", style: "Hyperlink" })],
    link: "https://example.com",
  })]
})
// Internal (bookmark)
new Paragraph({ heading: HeadingLevel.HEADING_1, children: [
  new Bookmark({ id: "chapter1", children: [new TextRun("Chapter 1")] }),
]})
new Paragraph({ children: [new InternalHyperlink({
  children: [new TextRun({ text: "See Chapter 1", style: "Hyperlink" })],
  anchor: "chapter1",
})]})
```

### Table of Contents

```javascript
// CRITICAL: Headings must use HeadingLevel only — no custom styles
new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" })
```

### Page Breaks

```javascript
new Paragraph({ children: [new PageBreak()] }) // must be inside a Paragraph
```

### Critical Rules for docx-js

- **Set page size explicitly** — default is A4; use US Letter (12240×15840 DXA) for US documents
- **Landscape:** pass portrait dimensions + `PageOrientation.LANDSCAPE`
- **Never use `\n`** — use separate Paragraph elements
- **Never use unicode bullets** — use `LevelFormat.BULLET` with numbering config
- **PageBreak must be in Paragraph**
- **ImageRun requires `type`**
- **Always use `WidthType.DXA` for tables** — never `PERCENTAGE` (breaks Google Docs)
- **Tables need dual widths** — `columnWidths` array AND cell `width`, both must match
- **Use `ShadingType.CLEAR`** — never SOLID for table shading
- **Never use tables as dividers** — use `border: { bottom: ... }` on a Paragraph instead
- **Override built-in styles** — use exact IDs: "Heading1", "Heading2", etc.
- **Include `outlineLevel`** — required for TOC (0 for H1, 1 for H2)

---

## Editing Existing Documents

**Follow all 3 steps in order.**

### Step 1: Unpack

`run_python_script` → `<docx>/scripts/office/unpack.py` with args `["/abs/document.docx", "/abs/unpacked"]`.

Add `"--merge-runs", "false"` to skip run merging. Extracts XML, pretty-prints, and converts smart quotes to XML entities.

### Step 2: Edit XML

Edit files in `unpacked/word/`. Use **`edit_file` directly** for string replacement — do not write Python scripts for this.

**Use "Claude" as the author** for tracked changes and comments.

**Smart quotes for new content:**
```xml
<w:t>Here&#x2019;s a quote: &#x201C;Hello&#x201D;</w:t>
```
| Entity | Character |
|--------|-----------|
| `&#x2018;` | ' (left single) |
| `&#x2019;` | ' (right single / apostrophe) |
| `&#x201C;` | " (left double) |
| `&#x201D;` | " (right double) |

**Adding comments:** `run_python_script` → `<docx>/scripts/comment.py` with args `["/abs/unpacked", "0", "Comment text"]`.

### Step 3: Pack

`run_python_script` → `<docx>/scripts/office/pack.py` with args `["/abs/unpacked", "/abs/output.docx", "--original", "/abs/document.docx"]`.

---

## XML Reference

### Schema Compliance

- **Element order in `<w:pPr>`**: `<w:pStyle>`, `<w:numPr>`, `<w:spacing>`, `<w:ind>`, `<w:jc>`, `<w:rPr>` last
- **Whitespace**: Add `xml:space="preserve"` to `<w:t>` with leading/trailing spaces
- **RSIDs**: Must be 8-digit hex (e.g., `00AB1234`)

### Tracked Changes

**Insertion:**
```xml
<w:ins w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>
```

**Deletion:**
```xml
<w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
```

**Minimal edits** — only mark what changes:
```xml
<w:r><w:t>The term is </w:t></w:r>
<w:del w:id="1" w:author="Claude" w:date="..."><w:r><w:delText>30</w:delText></w:r></w:del>
<w:ins w:id="2" w:author="Claude" w:date="..."><w:r><w:t>60</w:t></w:r></w:ins>
<w:r><w:t> days.</w:t></w:r>
```

**Deleting entire paragraphs** — add `<w:del/>` inside `<w:pPr><w:rPr>` to prevent empty paragraph remnants:
```xml
<w:p>
  <w:pPr><w:rPr><w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z"/></w:rPr></w:pPr>
  <w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
    <w:r><w:delText>Entire paragraph content</w:delText></w:r>
  </w:del>
</w:p>
```

### Comments

After running `comment.py`, add markers to document.xml. `<w:commentRangeStart>` and `<w:commentRangeEnd>` are siblings of `<w:r>`, never inside.

```xml
<w:commentRangeStart w:id="0"/>
<w:r><w:t>text</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
```

### Images (XML path)

1. Add image file to `word/media/`
2. Add relationship to `word/_rels/document.xml.rels`
3. Add content type to `[Content_Types].xml`
4. Reference in document.xml with `<w:drawing>`
