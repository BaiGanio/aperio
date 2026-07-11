# Spike: Document Intelligence — Field Extraction Pipeline

**Author:** CodeWhale (DeepSeek-V4-Pro) · **Date:** 2026-07-09 · **Status:** Planning

---

## 1. The Vision (User's Words)

> Upload electricity bill, bank document → extract fields → Excel or DB table.
> Re-upload same document type → same fields auto-extracted.
> Query the DB table → graphics, tables, generated documents.
> Showcase in docs/evaluate/, docs/tours/, docs/exam/.

In Aperio terms: **chat models + vision models + memory + DB client + document
generation = a document intelligence pipeline.** Everything except the
"remember what fields to extract" part already exists in Aperio.

---

## 2. What Already Exists (Reuse)

| Capability | Existing Tool / System | How It Helps |
|---|---|---|
| Read text documents | `read_file` (.txt, .md) | Extract structured text from `commercial-invoice.txt`, `swift-mt700.txt` |
| Read scanned documents | `preprocess_image` → `describe_image` | VLM reads scanned invoices (`.png`) and returns text description |
| Read PDFs | `read_file` (built-in PDF extraction) | Text-native PDFs extracted inline; scanned PDFs routed to VLM |
| Generate Excel | `generate_xlsx` | Populate extracted fields into formatted spreadsheets |
| Generate Word | `generate_docx` | Produce reports from accumulated data |
| Query databases | `db_query`, `db_schema`, `db_execute` | Store extractions in a user's own DB; query/analyze later |
| Connect external DBs | `db_connections` | Point to the user's existing Postgres/SQLite/MySQL |
| Persistent knowledge | `remember`, `recall`, `self_remember` | Could store field templates, but → dedicated table recommended |
| Document index | `docgraph` (`doc_search`, `doc_outline`) | Find documents by content; useful for corpus management |
| Shell execution | `run_shell` | Run scripts for batch processing |
| PII redaction | `lib/privacy/redact.js` | Redact IBANs, emails, phones before cloud sends |
| Agent jobs | Background agents | Scheduled document ingestion (e.g., watch a folder) |

**Gap:** There is no persistent record of "for document type X, extract fields A, B, C."
The agent can do it once, but next session it starts from scratch.

---

## 3. Architecture

### 3.1 Pipeline Overview

```
┌─────────────────────────────────────────────────────────┐
│                   DOCUMENT INTELLIGENCE                   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  UPLOAD                    EXTRACTION                    │
│  ┌──────┐    ┌─────────┐   ┌──────────┐   ┌──────────┐  │
│  │.png  │───▶│Preprocess│──▶│ Describe │──▶│ Extract  │  │
│  │.jpg  │    │ (sharp)  │   │  (VLM)   │   │ (LLM)    │  │
│  └──────┘    └─────────┘   └──────────┘   └─────┬────┘  │
│                                                  │       │
│  ┌──────┐                                    ┌───▼────┐  │
│  │.txt  │───────────────────────────────────▶│ Parse  │  │
│  │.pdf  │    (read_file extracts text)       │ text   │  │
│  └──────┘                                    └───┬────┘  │
│                                                  │       │
│                  TEMPLATE LOOKUP                  │       │
│                  ┌──────────────┐                 │       │
│                  │ Match doc    │◀────────────────┘       │
│                  │ type → tmpl  │                         │
│                  └──────┬───────┘                         │
│                         │                                 │
│                  ┌──────▼───────┐                         │
│                  │ Apply field  │                         │
│                  │ extractions  │                         │
│                  └──────┬───────┘                         │
│                         │                                 │
│  OUTPUT          ┌──────┴───────┐                         │
│  ┌──────────┐    │              │    ┌────────────────┐   │
│  │  Excel   │◀───┤  Structured  │───▶│  DB table      │   │
│  │ (.xlsx)  │    │    fields    │    │ (accumulated)  │   │
│  └──────────┘    └──────────────┘    └───────┬────────┘   │
│                                              │            │
│  ANALYTICS                          ┌───────▼────────┐   │
│  ┌──────────┐                       │ db_query       │   │
│  │ Chart/   │◀──────────────────────│ → chart data   │   │
│  │ report   │                       │ → Excel export │   │
│  └──────────┘                       └────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 3.2 The Template System (Only New Code)

A lightweight `extraction_templates` table is the sole new persistence layer.
Everything else is tool orchestration.

**New DB table** (`db/migrations/003_extraction_templates.sql` + SQLite mirror):

```sql
CREATE TABLE extraction_templates (
  id          TEXT PRIMARY KEY,       -- UUID
  name        TEXT NOT NULL,          -- "Commercial Invoice"
  doc_type    TEXT NOT NULL,          -- "commercial-invoice", "electricity-bill"
  description TEXT,                   -- human-readable, used for VLM matching
  fields      TEXT NOT NULL,          -- JSON array: [{name, key, type, description, pattern}]
  match_hints TEXT,                   -- JSON: {headers: [...], patterns: [...]}
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Field schema** (each entry in `fields` JSON array):
```json
{
  "name": "Invoice Number",
  "key": "invoice_no",
  "type": "string",
  "description": "The invoice reference number like INV-2026-...",
  "pattern": "INV-\\d{4}-\\d{2}-\\d{4}"
}
```

**New MCP tools:**

| Tool | Purpose |
|---|---|
| `list_extraction_templates` | List all templates with doc_type, name, field count |
| `create_extraction_template` | Define a new template (name, doc_type, fields) |
| `get_extraction_template` | Get one template by ID with all fields |
| `delete_extraction_template` | Remove a template |
| `update_extraction_template` | Edit template fields |
| `match_document_to_template` | Given a document (path or text), return best-matching template(s) |
| `extract_with_template` | Given document path + template ID, return extracted fields as JSON |
| `list_extractions` | List past extractions (query the extraction log — see §3.3) |

**Match logic** (in `match_document_to_template`):
1. For text docs: grep `match_hints.headers` against first 20 lines, score matches
2. For image docs: call `describe_image` with prompt "What type of document is this?" → match against template `description` + `doc_type`
3. Fallback: return all templates, let the chat model pick

**Extraction logic** (in `extract_with_template`):
1. Load template → get field definitions
2. For text docs: regex extraction using field `pattern`, fallback to LLM extraction
3. For image docs: call `describe_image` with structured prompt ("Extract these fields: ...")
4. Return JSON: `{template_id, template_name, fields: {key: value, ...}, confidence: {...}}`

### 3.3 Extraction Log (Audit Trail)

A companion table to track what was extracted and when:

```sql
CREATE TABLE extraction_log (
  id          TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES extraction_templates(id),
  source_path TEXT NOT NULL,           -- original file path
  source_hash TEXT,                    -- SHA-256 for dedup
  extracted   TEXT NOT NULL,           -- JSON snapshot of extracted fields
  confidence  TEXT,                    -- JSON: per-field confidence
  verified    INTEGER DEFAULT 0,       -- user confirmed?
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

This allows: "show me all invoices from June 2026", "re-extract document X",
"what was the confidence on field Y?"

### 3.4 Output Destinations

**Option A: Excel (generate_xlsx)**
- No setup needed. `extract_with_template` returns JSON → agent calls `generate_xlsx`.
- Works for one-off extractions.

**Option B: Database table (db_execute + db_query)**
- User defines a target connection + table via template config.
- Auto-create table on first extraction matching template fields.
- Accumulated data enables: "total invoice value by quarter", "average unit price per HS code".
- This is where the analytics/visualization payoff lives.

**Recommendation:** Both. Excel for ad-hoc, DB for accumulation. Template config
lets the user choose.

### 3.5 Template Auto-Learning (Stretch)

The user's "when I upload the same document again" implies template reuse.
The above handles this: template matches → auto-extracts. But what about
*creating* the template?

**Flow:**
1. User uploads first invoice → "I don't have a template for this"
2. Agent asks: "Which fields do you want to extract?"
3. User replies: "Invoice number, date, buyer, total amount"
4. Agent: extracts fields using VLM + chat, shows results, asks to save as template
5. User: "Yes, call it 'Commercial Invoice'"
6. Agent calls `create_extraction_template`
7. Next upload → auto-matched, auto-extracted

---

## 4. Sample Data Walkthrough

Using the files already in `trash/trade-docs/`:

### 4.1 `commercial-invoice.txt` (Text-native)

```bash
Template: "Commercial Invoice"
Fields:
  - Invoice Number (pattern: ^Invoice No:\s+(.+)$)
  - Invoice Date   (pattern: ^Invoice Date:\s+(.+)$)
  - Seller Name    (pattern: ^Company:\s+(.+)$  — first occurrence)
  - Buyer Name     (pattern: ^Company:\s+(.+)$  — second occurrence)
  - Total CIF      (pattern: ^TOTAL CIF GÖTEBORG:\s+EUR\s+(.+)$)
  - Currency       (pattern: ^Currency:\s+(.+)$)
```

Extracted JSON:
```json
{
  "invoice_no": "INV-2026-06-5021",
  "invoice_date": "2026-06-25",
  "seller": "Deutsche Edelstahl GmbH",
  "buyer": "Scandinavian Steel Importers AB",
  "total": "1 266 250,00",
  "currency": "EUR"
}
```

### 4.2 `scanned-invoice.png` (Image — same template, different data)

This is the same template (Deutsche Edelstahl commercial invoice), different
invoice (`INV-2026-06-5021`). The VLM reads it, the template matches, and the
same fields are extracted. **This proves the "re-upload, same fields" workflow.**

### 4.3 `scanned-invoice-2.png` (Different template)

This is a different invoice format — tool steel (H13, D2, D3), EXW Essen,
different buyer (Aciers Spéciaux du Rhône). A different template or a
generic "invoice" template with common fields (invoice #, date, total)
would match here.

### 4.4 `letter-of-credit.txt` + `swift-mt700.txt`

Different document types entirely — would need their own templates.
The SWIFT MT700 is a machine-readable format; a template with:
- LC Number (field :20:)
- Issue Date (field :31C:)
- Amount (field :32B:)
- Applicant (field :50:)
- Beneficiary (field :59:)

---

## 5. Showcase Pages Plan

### 5.1 New Tour Page: `docs/tours/document-intelligence.html`

**Title:** "Your Documents, Your Data — Extract Fields, Build a Database, Get Answers"

**Structure:**
1. **Hero:** "Upload once. Extract forever." — the core promise.
2. **Try It Now** — copy-paste prompts using the trade-docs samples.
3. **How It Works** — the pipeline diagram (simplified).
4. **Use Cases:**
   - Electricity bills → monthly cost tracking
   - Invoices → spend analytics by supplier
   - Bank statements → cashflow dashboard
   - Trade documents → LC/invoice reconciliation
5. **Model Recommendations** — Qwen2.5VL for vision, DeepSeek/Gemma for extraction.
6. **Setup** — "One `db_execute` call to create your table, then every upload adds a row."

### 5.2 New Evaluate Page: `docs/evaluate/document-extraction.html`

**Title:** "Document Extraction — Model Evaluation for Visual Field Extraction"

**Structure:**
1. **What This Tests** — can the VLM+chat combo reliably extract structured fields
   from scanned documents?
2. **Test Suite** (6 tests):
   - Test 1: Text invoice extraction (structured .txt)
   - Test 2: Scanned invoice extraction (VLM on .png)
   - Test 3: Same-template consistency (two invoices, same template)
   - Test 4: Cross-template extraction (different document types)
   - Test 5: Handwritten/annotated documents
   - Test 6: Multi-page PDF extraction
3. **Scorecard** — per-model results (pass/fail per test).
4. **Setup Prompts** — ready-to-paste prompts using the trade-docs samples.

### 5.3 Updates to Existing Pages

- **`docs/tours/model-qwen2.5vl-7b.html`** — Add § "Real-world: Read My Invoices" with a trade-doc example.
- **`docs/tours/databases.html`** — Add § "Document Fields → Database" showing the extraction-to-DB flow.
- **`docs/evaluate/doc-graph.html`** — Link to new document-extraction page under "Related Tests."
- **`FEATURES.md`** — Add Document Intelligence section (after § Doc Graph or as § Document Pipeline).

---

## 6. Implementation Phases

### Phase 1: Template System (Core) — ~1 day

**Files to create:**
- `db/migrations/003_extraction_templates.sql`
- `db/migrations-sqlite/003_extraction_templates.sql`
- `mcp/tools/extraction.js` — 8 tools registered
- `lib/tools/extraction/` — handler implementations:
  - `templateStore.js` — CRUD over `extraction_templates` table
  - `extractionLog.js` — write/read extraction log
  - `matcher.js` — `matchDocumentToTemplate` logic
  - `extractor.js` — `extractWithTemplate` (regex + LLM fallback)

**Files to modify:**
- `mcp/index.js` — register extraction tools
- `db/sqlite.js` / `db/postgres.js` — add table to known tables whitelist
- `db/tables.js` — type definitions

**Tests:**
- `tests/mcp/extraction.test.js` — CRUD + match + extract

### Phase 2: Agent Workflow Skill — ~½ day

**Files to create:**
- `skills/document-intelligence/SKILL.md`

**Content:** Teaches the agent the full pipeline:
1. Detect document type (ask `match_document_to_template`)
2. If template exists → `extract_with_template` → show results → offer Excel/DB output
3. If no template → ask user which fields → extract → show → offer to save template
4. DB output flow: check `db_connections` → `db_schema` → `db_execute` CREATE TABLE IF NOT EXISTS → INSERT
5. Excel output flow: `generate_xlsx` with extracted fields
6. Analytics flow: `db_query` to aggregate → present as table or suggest Excel export

### Phase 3: Showcase Pages — ~1 day

**Files to create:**
- `docs/tours/document-intelligence.html` — tour page
- `docs/evaluate/document-extraction.html` — evaluation page

**Files to modify:**
- `docs/tours/model-qwen2.5vl-7b.html` — add invoice example
- `docs/tours/databases.html` — add document→DB flow
- `docs/evaluate/doc-graph.html` — add cross-link
- `FEATURES.md` — add Document Intelligence section

### Phase 4: Polish & Integration — ~½ day

- Sample templates pre-seeded from trade-docs
- `npm run migrate` + `npm run migrate:sqlite` tested
- E2E test: upload scanned invoice → extract → Excel output
- Background agent job template: "watch folder, auto-extract"

---

## 7. Questions & Clarifications Needed

### 🔴 Must Answer Before Coding

**Q1: Template persistence scope.** Templates live in the Aperio DB (survive
restarts). But should they be:
- **(A) Global** — one set of templates for all conversations.
- **(B) Per-session** — each chat session has its own templates.

> *Lean: (A) Global. The whole point is "same document next week, same fields."*

**Q2: Field typing.** Should fields have types beyond `string`? Adding `number`,
`date`, `currency` enables:
- Numeric validation ("EUR 1 250 000,00" → 1250000.0)
- Date normalization ("2026-06-25" → Date object)
- Currency conversion

But adds complexity. Start with `string` only, add typing later?

> *Lean: Start string-only. Type coercion is the agent's job (LLM handles it).*

**Q3: Output DB — auto-create table or user-managed?**
- **(A)** `db_execute` CREATE TABLE on first extraction — seamless but DDL is scary.
- **(B)** User explicitly creates table first — safe but friction.

> *Lean: (A) with confirmation gate. `db_execute` already has confirm-before-write.*

**Q4: Confidence threshold for auto-insert?** If regex extraction fails (no match)
and LLM fallback gives low confidence, should we:
- Still insert with a flag?
- Skip and ask user?
- Insert all, user reviews later?

> *Lean: Always show results. Auto-insert only if user opts in per template.*

**Q5: Scanned image quality.** The three invoices in `trash/trade-docs/` are
clean, well-lit photos. Real-world documents vary wildly. Should Phase 1 include
image quality warnings (too blurry, too dark) or is that Phase 2?

> *Lean: Phase 2. `describe_image` already has success/failure signals.*

### 🟡 Nice to Have Answers

**Q6: File watching (background agent).** "Drop files in a folder, they auto-extract."
Should this be in Phase 1 or a follow-up?

> *Lean: Follow-up. Core extraction pipeline first.*

**Q7: Multi-language.** The trade-docs are in English, but real invoices come in
every language. Should templates support `locale`?

> *Lean: Not now. The VLM handles multilingual text natively.*

**Q8: Should the `examine` tool (which already chains VLM + chat for image analysis)
be the entry point for image-based extraction?** It already does "describe then analyze."

> *Lean: Yes — `extract_with_template` should use the same VLM→chat chain that
> `describe_image` provides. No need for a new image pipeline.*

### 🔵 Process Questions

**Q9: Should this be built on `dev` branch or a feature branch?**

**Q10: Do you want the showcase pages to use the actual trade-docs files (committed to
the repo) or synthetic examples?**

> *Lean: Use real trade-docs. They're already in `trash/` — move the relevant ones
> to a `docs/assets/samples/` directory and reference them from the tour page.*

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| VLM extraction is unreliable on poor-quality scans | Medium | User trust | Show confidence scores; let user review before DB insert |
| Regex extraction breaks on format variations | High | Silent wrong data | Always fall back to LLM when regex fails; flag low-confidence fields |
| DB schema drift (user changes template fields after table created) | Medium | INSERT errors | Template versioning; ALTER TABLE on field change (or warn user) |
| Token cost — describe_image + extraction on every upload | Low (local VLM) / Medium (cloud) | Cost | Cache extracted results; dedup by file hash |
| User expects OCR-level accuracy from 7B VLM | Medium | Disappointment | Clear docs: "This is a vision model, not ABBYY. 95%+ on clean docs, expect errors on handwritten." |

---

## 9. Success Criteria

A user (non-technical) should be able to:
1. Upload `scanned-invoice.png` → see extracted fields
2. Say "save this as a template" → template persists
3. Upload `scanned-invoice-2.png` → same fields auto-extracted (different data)
4. Say "put it in a database" → fields inserted into a table
5. Ask "what's my total spend on Deutsche Edelstahl?" → `db_query` returns the sum
6. Say "export to Excel" → `generate_xlsx` produces a formatted spreadsheet

All demonstrated in `docs/tours/document-intelligence.html` with copy-paste prompts.

---

## 10. File Manifest

### New files
```
db/migrations/003_extraction_templates.sql
db/migrations-sqlite/003_extraction_templates.sql
mcp/tools/extraction.js                          # Tool registration (8 tools)
lib/tools/extraction/templateStore.js            # CRUD over extraction_templates
lib/tools/extraction/extractionLog.js            # Write/read extraction_log
lib/tools/extraction/matcher.js                  # match_document_to_template
lib/tools/extraction/extractor.js                # extract_with_template
skills/document-intelligence/SKILL.md            # Agent workflow skill
docs/tours/document-intelligence.html            # Tour page
docs/evaluate/document-extraction.html            # Evaluate page
docs/assets/samples/scanned-invoice.png          # Moved from trash/trade-docs/
docs/assets/samples/commercial-invoice.txt       # Moved from trash/trade-docs/
tests/mcp/extraction.test.js                     # Template system tests
```

### Modified files
```
mcp/index.js                                     # Register extraction tools
db/sqlite.js                                     # Add table to whitelist
db/postgres.js                                   # Add table to whitelist
db/tables.js                                     # Type definitions
docs/tours/model-qwen2.5vl-7b.html               # Add invoice example
docs/tours/databases.html                        # Add document→DB flow
docs/evaluate/doc-graph.html                     # Cross-link
FEATURES.md                                      # Document Intelligence section
```

---

*Spike filed. Grill away — I'll refine based on your answers to §7.*
