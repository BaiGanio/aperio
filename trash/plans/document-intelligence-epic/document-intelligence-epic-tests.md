# Document Intelligence — Verification Plan

**Companion to:** [`document-intelligence-epic.md`](./document-intelligence-epic.md)  
**Status:** WS0-R tests are next  
**Reset:** 2026-07-23

Read this file before implementation. Establish red first, implement to green, and keep
the oracle outside every model-readable workspace.

## 1. Coverage map

| Plan step | Test group | Coverage |
|---|---|---|
| 1 | T-R0 harness | reproducible red, evidence, isolation, teardown |
| 2 | T-R1 design audit | failure trace, bounded design, lifecycle limits |
| 3 | T-R2 manifest | discovery, multi-folder behavior, deduplication, bounds |
| 4 | T-R3 batch retrieval | convergence, coverage, cancellation, oversized corpus |
| 5 | T-R4 task-shaped vision | inline-image extraction without malformed tool loops |
| 6 | T-R5 retrieval gate | P1/P2/P3 totals, coverage, timing, privacy |
| 7–8 | T-G1 destination | confirmed writes, round-trip, numeric normalization, currencies |
| 9–10 | T-G2 skill | bare routing, coverage, SQL provenance, autotune |
| 11 | T-G3 schema | mirrored migrations and backend lockstep |
| 12 | T-G4 handlers | CRUD, matching, extraction, learning, log |
| 13 | T-G5 MCP/output | schemas, `ctx`, Excel and DB e2e |
| 14–15 | T-G6 hero proof | exact S2, preview, multilingual and scan parity |

## 2. Test cases

### T-R0 — Isolated harness and measured red

#### T-R0.1 reproducible-baseline

- **Input/setup:** clean source snapshot; copied fictional corpus; fresh SQLite DB;
  free loopback ports; hero model; oracle outside allowed/readable paths.
- **Expected behavior:** P1/P2/P3 expose the current routing, corpus-assembly, or
  convergence failure before retrieval changes.
- **Assertions:** record prompt, commit, environment overrides, wall time, tool sequence,
  files touched, answer, per-category deltas, and timeout reason.
- **Run artifact:** write a fresh run file after each prompt completes (and again during
  cleanup), replacing—not appending to—the prior run's contents. Store the full prompt
  text, prompt label, wall time, tool sequence, status, and raw answer, plus the
  `expected` category/grand-total and retrieval-tool gate, in the ignored
  `trash/plans/document-intelligence-epic/document-intelligence-run-answers.json` so the
  next run can be adjusted from observed behavior. Initialize that file before the first
  model call so prompts and expectations remain available if a response hangs. The
  acceptance timeout is 300 seconds per prompt.
- **Edge cases:** a prompt unexpectedly passes—verify that `ground-truth.json` or a
  precomputed aggregate was not exposed.

#### T-R0.2 clean-teardown

- **Input/setup:** successful run, timed-out run, and interrupted run.
- **Expected behavior:** all child processes, ports, watchers, scratch DBs, and temporary
  workdirs are released.
- **Assertions:** no matching node/llama process; ports reusable; repo status unchanged.
- **Edge cases:** llama-server child outlives its parent; cleanup runs after partial boot.

### T-R1 — Retrieval design audit

#### T-R1.1 end-to-end-failure-trace

- **Input/setup:** trace P1 and P2 through intent classification, tool selection,
  `doc_repos`, `doc_search`, file reading, tool-result shaping, and provider turns.
- **Expected behavior:** each observed failure is tied to a concrete code seam.
- **Assertions:** decision record distinguishes routing, candidate coverage, content
  reading, model reasoning, and output aggregation.
- **Edge cases:** a generic document-inventory helper exists but does not trigger on the
  money question; do not count it as a fix.

#### T-R1.2 bounded-design-review

- **Input/setup:** proposed retrieval contract with limits.
- **Expected behavior:** design states maximum candidates, batch size/bytes, timeout,
  deduplication rule, skipped-file reporting, and abort propagation.
- **Assertions:** no fixture path, unbounded preload, silent truncation, or per-file model
  turn is required.
- **Edge cases:** multiple indexed folders; 0 folders; 30+ documents; image/text twins.

### T-R2 — Candidate manifest

#### T-R2.1 unknown-location-discovery

- **Input/setup:** two indexed folders, only one containing the target month/category.
- **Expected behavior:** all locations are inventoried and the relevant candidates are
  selected or ambiguity is surfaced.
- **Assertions:** no hardcoded folder and no “first folder wins.”
- **Edge cases:** no indexed folders; relevant folder empty; same filename in two folders.

#### T-R2.2 deterministic-bounded-manifest

- **Input/setup:** shuffled index order with more candidates than the configured limit.
- **Expected behavior:** repeated calls return the same ordered bounded manifest and an
  explicit truncation/continuation indication.
- **Assertions:** path/id, type, date hint, size, and selection reason are available;
  twins are deduplicated by the documented rule.
- **Edge cases:** missing metadata; unsupported file type; duplicate content hash.

### T-R3 — Batch retrieval and coverage

#### T-R3.1 honest-corpus-batch

- **Input/setup:** manifest for the fictional household corpus.
- **Expected behavior:** candidates are read in bounded batches without one model turn per
  file.
- **Assertions:** coverage reports found/read/skipped counts and per-file status; all ten
  ledger sources needed for S2 are represented once.
- **Edge cases:** unreadable PDF, failed image extraction, one document over byte limit.

#### T-R3.2 oversized-corpus

- **Input/setup:** 30-document fixture containing relevant, irrelevant, duplicate, and
  unsupported files.
- **Expected behavior:** retrieval completes within the documented bound or returns an
  honest partial result with continuation guidance.
- **Assertions:** no silent drop, unbounded allocation, or abandoned work.
- **Edge cases:** all relevant documents sort after the first batch; limit is one.

#### T-R3.3 cancellation-lifecycle

- **Input/setup:** abort during inventory, text batch, image extraction, and result
  aggregation.
- **Expected behavior:** pending work stops and resources are released.
- **Assertions:** no retained listeners, workers, streams, file handles, sockets, or child
  processes.
- **Edge cases:** abort arrives between batches or while a tool result is being serialized.

### T-R4 — Task-shaped native vision

#### T-R4.1 inline-image-fields

- **Input/setup:** `electricity-bill-bg.png` already attached inline; no separate VLM
  configured; prompt asks for provider, date, total, and currency.
- **Expected behavior:** hero model returns all four fields without requesting redundant
  preprocessing.
- **Assertions:** date 03.06.2026 and total 142.50 BGN match the oracle; no malformed
  `preprocess_image` call appears.
- **Edge cases:** generic “describe this image” still works; text-only main model still
  uses the configured bridge.

### T-R5 — Retrieval gate

#### T-R5.1 bare-utilities-question

- **Input/setup:** fresh session, at least two indexed folders, prompt: “How much did I pay
  for utilities last month?”
- **Expected behavior:** documents are discovered without a supplied path.
- **Assertions:** Utilities = 260.50 BGN; four utility documents accounted for; coverage
  disclosed.
- **Edge cases:** zero relevant documents produces an honest no-data answer.

#### T-R5.2 full-month-total

- **Input/setup:** honest corpus, explicit monthly-spend prompt.
- **Expected behavior:** complete answer within 180 seconds, unless T-R0 establishes a
  stricter realistic budget before implementation.
- **Assertions:** Utilities 260.50; Fuel 215.60; Groceries 140.75; Transport 50.00;
  Internet 29.99; total 696.84 BGN; every included source counted once.
- **Edge cases:** 666.85 is a hard failure; 260.75 as Utilities means statement-only
  retrieval and is a hard failure.

#### T-R5.3 steered-diagnostic

- **Input/setup:** P3 diagnostic prompt naming the available retrieval and DB tools.
- **Expected behavior:** converges no slower than P2 and never attempts a write to the
  built-in read-only database.
- **Assertions:** same totals/coverage as T-R5.2; tool sequence recorded.
- **Edge cases:** no writable destination yet—the answer may return verified normalized
  rows without persistence, but must not perform hidden mental aggregation.

#### T-R5.4 oracle-and-privacy-fence

- **Input/setup:** model-readable workspace listing plus harness environment.
- **Expected behavior:** oracle and private documents are inaccessible.
- **Assertions:** `ground-truth.json` absent from allowed paths; no real document copied
  into the repo; privacy-safe evidence contains no personal content.
- **Edge cases:** symlink to the oracle; broad parent-directory allowlist.

### T-G1 — Writable destination

#### T-G1.1 clean-profile-write

- **Input/setup:** clean profile with no hand-edited config.
- **Expected behavior:** create a non-`aperio` extraction table after confirmation.
- **Assertions:** built-in `aperio` still rejects writes; schema name is user-selected or
  provisioned, never path-derived.
- **Edge cases:** user declines confirmation; destination already exists.

#### T-G1.2 append-and-round-trip

- **Input/setup:** two extractions using the same schema.
- **Expected behavior:** second extraction appends; query returns both rows.
- **Assertions:** row count/values match; field drift warns rather than silently failing.
- **Edge cases:** duplicate source hash.

#### T-G1.3 locale-normalization

- **Input/setup:** `142.50 BGN`, `1 266 250,00 EUR`, a trailing currency symbol, and a
  negative debit.
- **Expected behavior:** JS produces numeric amount plus currency before SQL insert.
- **Assertions:** SQL sums are arithmetically correct; template source fields remain
  strings.
- **Edge cases:** ambiguous separators are rejected or flagged, never guessed silently.

#### T-G1.4 no-fx

- **Input/setup:** mixed BGN/EUR rows.
- **Expected behavior:** separate currency totals.
- **Assertions:** no blended figure; response says no conversion was applied.
- **Edge cases:** model volunteers a rate—fail.

### T-G2 — Skill

#### T-G2.1 bare-routing

- **Input/setup:** fresh session, only the document-intelligence skill selected.
- **Expected behavior:** bare P1 follows discovery → manifest → batch → coverage.
- **Assertions:** no folder path embedded in the skill.
- **Edge cases:** multiple/zero indexed folders.

#### T-G2.2 convergence-and-coverage

- **Input/setup:** honest corpus and 30-document fixture.
- **Expected behavior:** completes within T-R5 budget or reports an explicit bound.
- **Assertions:** candidates enumerated before reads; skipped inputs named.
- **Edge cases:** one unreadable input.

#### T-G2.3 sql-provenance

- **Input/setup:** writable destination available.
- **Expected behavior:** aggregate comes from `db_query`.
- **Assertions:** answer equals SQL result and cites row/category coverage.
- **Edge cases:** no destination—say so rather than doing an untraceable mental sum.

#### T-G2.4 no-fx-honesty

- **Input/setup:** mixed currencies.
- **Expected behavior/assertions:** same as T-G1.4, driven through the skill.
- **Edge cases:** missing currency.

#### T-G2.5 autotune-holdout

- **Input/setup:** trigger and non-trigger evaluation set.
- **Expected behavior:** autotune converges.
- **Assertions:** new-skill recall meets target; unrelated skill match rates do not fall.
- **Edge cases:** direct skill name, paraphrase, and negated request.

### T-G3 — Schema lockstep

#### T-G3.1 fresh-apply-both

- **Input/setup:** empty SQLite and Postgres databases.
- **Expected behavior:** both migration commands exit 0 and rerun safely.
- **Assertions:** table/column sets match after type normalization.
- **Edge cases:** only one mirror present—fail.

### T-G4 — Extraction handlers

#### T-G4.1 template-crud

- **Input/setup:** create, read, update, list, delete.
- **Expected behavior:** timestamps and validation behave consistently.
- **Assertions:** invalid field JSON rejected.
- **Edge cases:** concurrent update or missing template.

#### T-G4.2 matching-and-extraction

- **Input/setup:** text, PDF, and scan; regex hit/miss; stubbed LLM fallback.
- **Expected behavior:** correct template ranks first; regex hits are high confidence;
  misses invoke fallback and remain visible.
- **Assertions:** extracted values match the oracle.
- **Edge cases:** garbage vision description; empty source; near match.

#### T-G4.3 confirmed-cold-start-learning

- **Input/setup:** empty template table, two same-type documents.
- **Expected behavior:** first proposes fields and persists only after confirmation;
  second auto-matches.
- **Assertions:** exactly one template exists.
- **Edge cases:** rejection persists nothing; near match asks rather than guesses.

#### T-G4.4 extraction-log

- **Input/setup:** extract and re-extract the same source.
- **Expected behavior:** hash and verification state round-trip; duplicate is flagged or
  deduplicated.
- **Assertions:** no silent duplicate row.
- **Edge cases:** same filename, changed content.

### T-G5 — MCP contract and outputs

#### T-G5.1 schemas-and-context

- **Input/setup:** tool registration.
- **Expected behavior:** all planned extraction schemas validate.
- **Assertions:** `createContext()` fields remain `store`, `generateEmbedding`,
  `vectorEnabled`, `embeddingQueue`, `providerIsLocal`; memory tests stay green.
- **Edge cases:** optional fields are not accidentally required.

#### T-G5.2 Excel-and-database-e2e

- **Input/setup:** sample bill → template → extraction → Excel and DB.
- **Expected behavior:** both destinations contain the same verified row.
- **Assertions:** workbook headers/values and DB values match the oracle; confirmation
  gate exercised.
- **Edge cases:** append and field drift from T-G1.2.

### T-G6 — Hero-model proof

#### T-G6.1 S2-exactness

- **Input/setup:** hero model, skill, templates, writable destination, honest corpus.
- **Expected behavior:** complete monthly table and explicit coverage.
- **Assertions:** category and grand totals match T-R5.2; SQL provenance present.
- **Edge cases:** previous-month document excluded.

#### T-G6.2 chart-preview

- **Input/setup:** verified S2 rows.
- **Expected behavior:** standalone HTML pie chart renders through the preview path.
- **Assertions:** labels/values match SQL output; developer approval precedes integration.
- **Edge cases:** empty or single-category data.

#### T-G6.3 multilingual-currency

- **Input/setup:** BG/EN/DE/FR documents.
- **Expected behavior:** common rows with currency-separated totals.
- **Assertions:** language does not alter field mapping; no FX conversion.
- **Edge cases:** Cyrillic scan and accented PDF in one run.

#### T-G6.4 scan-text-parity

- **Input/setup:** PNG/TXT twins.
- **Expected behavior:** extracted fields agree or differences carry low-confidence flags.
- **Assertions:** no silent conflict.
- **Edge cases:** scan unreadable while text twin succeeds.

## 3. Execution order

```text
T-R0 red
  → T-R1 audit/design
  → T-R2 manifest
  → T-R3 batch/coverage
  → T-R4 task-shaped vision
  → T-R5 retrieval gate
      → pass: T-G1 → T-G2 → T-G3 → T-G4 → T-G5 → T-G6
      → fail: revise WS0-R; do not start extraction plumbing
```

Tests within a group should be independent. A downstream group may rely only on a green
upstream gate.

## 4. Required setup

- Oracle: `tests/fixtures/household-gen/ground-truth.json`, read by the harness
  process only and never copied into or allowlisted for the model workspace.
- A scratch copy of the fictional corpus.
- Fresh SQLite DB per run; Postgres only when T-G3/T-G5 begins.
- Free loopback ports and a throwaway workdir outside the repository.
- Hero model cached locally:
  `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`.
- Docgraph enabled only for the scratch corpus; unrelated graph roots disabled.
- Full process-group teardown verification after every live run.

## 5. Corpus-honesty assertion

The previous test incorrectly required every category-total numeral to be absent from
every source document. That is impossible for single-row categories: the legitimate
Transport source contains 50.00 and the legitimate Internet source contains 29.99.

The corrected rule is:

1. no document may contain a labeled category-total table, monthly total, or S3 computed
   result copied from the oracle;
2. legitimate row-level source amounts may equal a category total;
3. reconciliation must prove every oracle ledger row maps to a source document exactly
   once;
4. scans/PDFs must be checked through extracted text or field-aware inspection rather
   than substring search alone.
