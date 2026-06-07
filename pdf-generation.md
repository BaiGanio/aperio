# PDF Generation Reference

## Why This Isn't Implemented Yet

- Current tools (`generate_xlsx`, `generate_docx`) only support Excel/Word file generation
- The `pdf` skill **only processes existing PDFs** (fills/merges/extracts), does not *generate* new PDFs
- No PDF generation library (e.g. `pdfkit`, `puppeteer`) is integrated

---

## Implementation Roadmap

### 1. Short-Term (0 New Code)

Use existing workflow:
1. Copy text → paste into Word/Google Docs
2. Export as PDF via `File → Export as PDF`

> *Most users do this daily – no code needed.*

---

### 2. Long-Term Fix (Add `generate_pdf` Skill)

| Step | Action | Tech | Why |
|------|--------|------|-----|
| **1. Choose library** | Install `pdfkit` | `npm install pdfkit` | Lightweight, fits Node.js stack | 
| **2. Create skill** | `skills/pdf/generate_pdf.js` | `pdfkit` | Reuse existing PDF infrastructure | 
| **3. Add tool** | Extend protocol with `generate_pdf` | `content: string, filename: string` | Matches current `generate_xlsx` format | 
| **4. Integrate** | Call via `run_node_script` | `skills/pdf/generate_pdf.js` | Uses existing safe workflow | 

---

## Critical Checks

- **Don't over-engineer**: Generate *only* plain text → PDF (no complex formatting)
- **Write to scratch**: Output must go to `/var/scratch/` (not project root)
- **Avoid reinventing**: `pdfkit` handles all PDF generation (0% new lib code)

---

## Why It's Not Here Yet

| Reason | Technical Reality |
|--------|-------------------|
| Low priority | Word/Excel workflows are standard for users |
| Cost | ~500KB npm package (negligible for modern servers) |
| Current workflow sufficient | Document editors already handle text→PDF conversion |

> ✅ **Actionable**: This is a **≤2 hour task**. I’d implement it now if asked.

---

## Sample Implementation Snippet

```javascript
// skills/pdf/generate_pdf.js
const PDFDocument = require('pdfkit');

const generatePdf = (content, filename) => {
  const doc = new PDFDocument();
  // ... (generate PDF from content)
  doc.pipe(fs.createWriteStream(`/var/scratch/${filename}`));
  doc.end();
};
```

> Save this under `/var/scratch/` like all other outputs. Use `generate_xlsx` protocol for seamless integration.