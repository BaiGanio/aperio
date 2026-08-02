# Document Intelligence — WS3 Verification Plan

**Companion to:** [`document-intelligence-ws3-templates.md`](./document-intelligence-ws3-templates.md)
**Status:** T-G3 is next
**Reset:** none yet — new file

Read this file before implementation. Establish red first (stub the new handlers/tools so
their tests fail for the right reason), implement to green, then confirm the coverage map
still holds.

## 1. Coverage map

| Plan step | Test group | Coverage |
|---|---|---|
| Step 1 | T-G3 schema | mirrored migrations, column parity, idempotent rerun |
| Step 2 | T-G4 handlers | CRUD, matching, regex/LLM extraction, confidence, cold-start learning, log dedup |
| Step 3 | T-G5 MCP/output | schema validation, `ctx` byte-equality, Excel/DB e2e round-trip |

## 2. Test cases

### T-G3 — Schema lockstep

#### T-G3.1 fresh-apply-both

- **Input/setup:** empty SQLite DB (`SqliteStore.init()` against a throwaway file) and
  empty Postgres DB (`runMigrations(pool)` against a scratch database/container).
- **Expected behavior:** both migration runners apply `014_extraction_templates.sql`
  without error; a second run against the same DB is a no-op (via the existing
  `schema_migrations` tracking table — no new mechanism needed).
- **Assertions:**
  - `extraction_templates` and `extraction_log` exist on both backends with the columns
    listed in the plan (Step 1), after type-family normalization (`INTEGER`/`SERIAL` →
    `int`, `TEXT` timestamp / `TIMESTAMPTZ` → `text`, matching
    `migration-lockstep.test.js`'s existing `TYPE_FAMILY` map).
  - `extraction_log.source_hash` is `UNIQUE` on both backends.
  - `extraction_log.template_id` is `REFERENCES extraction_templates(id) ON DELETE SET NULL`
    on both backends.
  - `extraction_templates.confidence` and any other bounded numeric column carries an
    equivalent `CHECK` range constraint on both backends (mirror the `010`
    `confidence_score >= 0 AND <= 1` precedent).
  - New `describe("014_extraction_templates ...")` block in
    `tests/unit/db/migration-lockstep.test.js` passes, and the existing
    `"every Postgres migration has a SQLite mirror and vice versa"` filename-lockstep test
    still passes with the new pair present.
- **Edge cases:** only one mirror present (temporarily delete one side in a throwaway
  branch and confirm the filename-lockstep test fails loudly — proves the guard has teeth
  before trusting it); re-running `npm run migrate` / `npm run migrate:sqlite` twice in a
  row does not error or duplicate rows in `schema_migrations`.

### T-G4 — Extraction handlers

#### T-G4.1 template-crud

- **Input/setup:** mock store (SQLite in-memory, migrated) exercising
  `templateHandlers.create/get/update/list/delete`.
- **Expected behavior:** create returns the new row with server-set `created_at`/
  `updated_at`; update bumps `updated_at` and leaves `created_at` untouched; list returns
  all templates; delete removes the row and a subsequent `get` returns not-found.
- **Assertions:**
  - Invalid `fields` JSON (malformed JSON, or a field entry missing both `amount_label` and
    `date_role`) is rejected with a specific error, never silently coerced or stored.
  - `name` must match the slug shape (`/^[a-z0-9][a-z0-9-]*$/`); a non-conforming name is
    rejected before any DB write.
  - Duplicate `name` on create is rejected (the `UNIQUE` constraint surfaces as a clean
    userFacing error, not a raw DB exception).
- **Edge cases:** update on a missing template id; delete on a missing template id (no-op,
  not an error); concurrent update (two updates racing — last-write-wins is acceptable, but
  neither call may throw an unhandled exception).

#### T-G4.2 matching-and-extraction

- **Input/setup:** three templates seeded (BG utility bill, DE/EN invoice, one with narrow
  keywords); three documents: a matching text bill, a matching PDF-derived text, and a scan
  whose vision-derived description is noisy/partial. A stubbed LLM fallback for fields with
  no regex/label hit.
- **Expected behavior:**
  - `matchHandlers` ranks the correct template first for each of the two clean documents,
    and returns a full ranked list (not just the top pick) so a near-match is visible.
  - `extractHandlers` extraction: fields with a real `extract-facts.js` label match are
    reported at high confidence; fields resolved only via the `likely_total`/
    `unlabeled_date` fallback are reported at lower confidence, distinguishably (a
    `provenance` marker per field: `"label" | "fallback" | "llm"`).
  - A regex/label miss invokes the stubbed LLM fallback for exactly the unresolved field(s)
    — assert the fallback stub was called with only the missing field names, not the whole
    document re-sent for full re-extraction.
  - Extracted values match the household-gen oracle for the fixture documents used.
- **Assertions:** per-field `provenance` is present and correct for every extracted field;
  overall extraction confidence is a function of the field-level mix (a document with all
  labeled fields scores higher than one leaning on fallback/LLM).
- **Edge cases:** garbage/empty vision description (extraction returns an honest
  "no fields resolved" rather than fabricating values); empty source text; a near-match
  where two templates score within a small margin (extraction should ask/report ambiguity
  rather than silently picking the higher-ranked one when the caller requested strict
  matching).

#### T-G4.3 confirmed-cold-start-learning

- **Input/setup:** empty `extraction_templates` table; two documents of the same
  previously-unseen shape (e.g. two bills from a provider with no existing template),
  processed in sequence within one test.
- **Expected behavior:**
  - First document: `matchHandlers` returns no confident match. The propose flow (reusing
    `createInterruptService` per the plan) creates a pending interrupt with a
    `toolName` distinct from `db_execute` (e.g. `extraction_template_save`) and proposed
    `canonicalArguments` (name/keywords/fields inferred from the document's own labeled
    evidence) — no row exists in `extraction_templates` yet.
  - Confirming (`decide("approve")` → `claimAndExecute`) calls `templateHandlers.create`
    exactly once and the template now exists.
  - Second document of the same shape: `matchHandlers` now returns this template as a
    confident top match — no confirmation prompt for the *match* itself.
- **Assertions:** exactly one row exists in `extraction_templates` after the whole sequence
  (not two, not zero); the interrupt's `digest` check (from `interruptService.js`) rejects a
  claim whose canonical arguments were tampered with between propose and confirm, same
  protection `db_execute` already gets.
- **Edge cases:** rejecting the first document's proposal (`decide("reject")`) leaves
  `extraction_templates` empty — no partial/draft row of any kind; a genuinely ambiguous
  near-match (close to but not clearly the same shape as an existing template) surfaces as
  "ask" rather than either auto-matching or silently proposing a near-duplicate template.

#### T-G4.4 extraction-log

- **Input/setup:** one document extracted and its rows confirmed-written via (a stubbed)
  `db_execute`; then the *same* document (identical text) processed again; then a
  same-named but content-modified document processed a third time.
- **Expected behavior:**
  - First pass: `extraction_log` gains one row, `verification_state` starts `'unverified'`
    and moves to `'verified'` only after the caller confirms the write succeeded (not
    optimistically, at hash-compute time).
  - Second pass (identical hash): `extraction_log_check`-equivalent handler call reports
    "already extracted," citing the prior log row — no new row, no duplicate write proposed.
  - Third pass (same path/filename, different hash): treated as a genuinely new source — a
    new `extraction_log` row, independent extraction proposed.
- **Assertions:** no silent duplicate row for the identical-hash case; `source_path` is
  never used as the dedup key on its own (a hash comparison must gate the "already
  extracted" branch, not a path/filename string match).
- **Edge cases:** a write that the user declines at the `db_execute` confirm step must not
  leave a `'verified'` (or even `'unverified'`-but-implying-success) log row — either no row,
  or a `'rejected'` one, but never a false positive that later dedup logic reads as "this is
  already safely stored."

### T-G5 — MCP contract and outputs

#### T-G5.1 schemas-and-context

- **Input/setup:** register `mcp/tools/extraction.js` against a test `McpServer` instance
  the way existing tool-registration tests exercise `mcp/tools/database.js`.
- **Expected behavior:** every new tool's `zod` schema accepts its documented representative
  input and rejects a structurally invalid one with a clean validation error (not a crash).
- **Assertions:**
  - `createContext()`'s returned object has exactly the fields `store`, `generateEmbedding`,
    `vectorEnabled`, `embeddingQueue`, `providerIsLocal` — diff against a snapshot taken
    before this change; any added/removed/renamed field fails the test.
  - `mcp/index.js`'s diff (outside the new one-line dynamic import) is empty.
  - Existing memory-tool and database-tool tests (`npm run test:memory`, the `database.js`
    tool tests) stay green with no changes required on their side.
- **Edge cases:** an optional field (e.g. `extraction_apply`'s template-name override) is
  genuinely optional in the schema — omitting it must not be rejected.

#### T-G5.2 Excel-and-database-e2e

- **Input/setup:** one sample bill (household-gen fixture, or a dedicated WS3 fixture if the
  existing corpus doesn't cover a clean "first-of-its-shape" case) run through the full
  chain: `doc_batch` read → `extraction_template_match` (no match) →
  `extraction_template_propose` → confirm → `extraction_apply` → `db_execute` propose →
  confirm → existing Excel export path.
- **Expected behavior:** the Excel workbook and the `extraction` connection's table both
  contain the same verified row(s), matching the household-gen oracle values.
- **Assertions:** workbook header names match the template's field names; workbook cell
  values and DB column values agree to the cent/exact string as applicable; the
  confirmation gate is exercised at both the template-save step and the `db_execute` step
  (assert the interrupt/decide calls actually happened — a test that only checks the final
  state could pass even if a shortcut skipped confirmation).
- **Edge cases:** a second run against the same source (T-G1.2/T-G4.4 overlap) appends
  rather than duplicates in both destinations; a field present in the template but absent
  from this particular document is reported as missing/low-confidence in both outputs, not
  silently zero-filled.

## 3. Execution order

```text
T-G3 (schema)
  → T-G4.1 (CRUD, needs the tables)
  → T-G4.2 (matching/extraction, needs CRUD to seed templates)
  → T-G4.3 (cold-start learning, needs matching + CRUD + the confirm-service reuse)
  → T-G4.4 (log dedup, independent of T-G4.3 but needs T-G3's extraction_log)
  → T-G5.1 (MCP schemas/ctx, needs all T-G4 handlers to bind)
  → T-G5.2 (full e2e, needs everything above green)
```

T-G4.1/T-G4.2/T-G4.4 may be implemented and verified in parallel once T-G3 is green;
T-G4.3 depends on T-G4.1 (CRUD) and T-G4.2 (matching) both being done first.

## 4. Required setup

- SQLite: in-memory or throwaway-file `SqliteStore.init()`, migrated through `014`.
- Postgres: scratch database/container, migrated through `014`, for T-G3.1 and any
  Postgres-side T-G4/T-G5 parity checks (mirroring
  `tests/integration/{codegraph,docgraph}/backends/postgres.test.js`'s recording-mock-pool
  convention for the handler-level tests; a real Postgres is only needed for T-G3.1 itself).
- `lib/docgraph/extract-facts.js` imported as-is (no modification expected in this
  workstream) for regex-first field resolution.
- The existing `agent_interrupts` table/`createInterruptService` — no new fixture beyond
  what `databaseHandlers.js`'s own tests already set up.
- Household-gen fixtures (`tests/fixtures/household-gen/`) and its oracle for T-G4.2/T-G5.2
  value checks, read by the test process only.
- A stubbed LLM-fallback function injected via DI (never a live model call in unit/
  integration tests, per the testing guide's mocking policy).
