# Household corpus generator + oracle

Everything the Document Intelligence epic evaluates against, generated from one
specification so a document and the ground-truth row claiming it cannot drift.

```bash
# regenerate the documents (never touches the frozen slices)
node tests/fixtures/household-gen/gen-corpus.mjs [--dry-run] [--force]

# regenerate the oracle from the same model
node tests/fixtures/household-gen/gen-oracle.mjs

# check the oracle against the corpus on disk (exits non-zero on any failure)
node tests/fixtures/household-gen/validate-oracle.mjs

# prove the gate fails for the right reason on each deliberate defect
node --test "tests/fixtures/household-gen/*.test.mjs"
```

## Layout

| File | Role |
|---|---|
| `spec.mjs` | Declarative data: payer, providers, tariff regimes, per-month plan, trips, merchants. The only place to change a number. |
| `money.mjs` | Integer-minor-unit money and per-locale date/number formatting. |
| `render-bg.mjs` | Bulgarian household documents, laid out to match the frozen June 2026 files. |
| `render-travel.mjs` | Travel documents in seven languages and four currencies. |
| `render-media.mjs` | PNG / PDF / DOCX / XLSX / EML / HTML writers. |
| `build.mjs` | All arithmetic. Emits documents, economic events, deduplication groups and one disposition per file. No I/O. |
| `gen-corpus.mjs` | Writes documents to `/Users/lk/Projects/household`. |
| `gen-oracle.mjs` | Writes `ground-truth.json` beside the generator (schema_version 3). |
| `validate-oracle.mjs` | Re-derives every figure in integer minor units and checks it against the corpus. |
| `harness-gate.mjs` | The T-R5 gate as pure functions: category-associated figures, failure signatures, exclusions, coverage. |
| `harness-gate.test.js` | Mutation tests: each deliberate defect must fail for its own reason. Lives in `tests/docint/` so `npm test` runs it. |
| `generated-manifest.json` | What the last run wrote. The guard against overwriting hand-authored files. |

## Rules that are load-bearing

**Frozen slices are never rewritten.** `2026/June/*`, the three `2026/July` bills,
`2026/May/water-payment-12-may.txt` and `templates/*` were authored by hand before
this generator existed. The spec declares them with `frozen: true`, carrying only
the metadata the oracle needs. June's expected values — Utilities 260.50, Fuel
215.60, Groceries 140.75, Transport 50.00, Internet 29.99, total 696.84 BGN — are
unchanged so T-R5 results stay comparable with the recorded runs.

**The oracle never enters the corpus.** `/Users/lk/Projects/household` is a
model-readable location. There is exactly one authoritative oracle, in the repo
fixture folder beside the generator; the harness reads it in-process and asserts
it was not copied.

**The fixture set is not the whole corpus.** T-R5 copies `2026/June`, `templates`
and `trade-docs` only. A fixture set that grows with the corpus is not a
controlled input, and the eight other months would silently change what the gate
measures.

**Regeneration is deterministic.** No randomness, no timestamps in document
bodies. Re-running produces byte-identical documents, so a diff means somebody
changed the spec.

**The generator refuses to clobber.** A generated path that already exists but is
absent from `generated-manifest.json` aborts the run. `--force` overrides, and
should be needed roughly never.

## Coverage

Nine consecutive periods, 202 documents:

| Period | BGN total | Other currencies | Notable |
|---|---:|---|---|
| 2025-11 | 745.41 | GBP 402.25 | London trip; interim statement |
| 2025-12 | 1189.75 | EUR 347.00 | Helsinki trip; winter heating peak; +4.8% tariff notice |
| 2026-01 | 1114.43 | — | annual insurance premium; heating paid in February |
| 2026-02 | 961.09 | EUR 417.75 | **−34.20 credit note**; Barcelona trip |
| 2026-03 | 901.76 | CNY 3530.50 | invoice delivered three times; Shanghai trip |
| 2026-04 | 767.18 | EUR 79.90, USD 772.25 | EUR order off-statement; New York trip |
| 2026-05 | 912.84 | EUR 519.95 | frozen payment form pins the water bill at 41.10 |
| 2026-06 | **696.84** | EUR 196.40 | **frozen T-R5 gate slice** |
| 2026-07 | 828.77 | GBP 349.30 | current month; out-of-period trap for June questions |

Formats: 119 txt, 15 pdf, 9 png, 9 eml, 8 html, 8 docx, 8 xlsx. Languages: bg, en-GB,
en-US, de-DE, fr-FR, fi-FI, es-ES, zh-CN.

PNG is **not** in docgraph's extractor table, so scans are reachable only through
the vision path. Each disposition records `docgraph_indexable`, because "the model
never read it" and "retrieval could not have surfaced it" are different failures.

## Traps, and why each exists

Documented in full in the oracle's `corpus_design` block. In short: every bank
statement is partial and says so; June's statement total sits 0.25 BGN from the
true Utilities total on purpose; June's Internet exists only inside a payment
form; fuel is split so one payment overlaps the statement and one does not;
February carries a negative credit note; January's heating is settled from a
February-filed payment form; March's electricity invoice arrives three times;
every month carries a *planned* budget spreadsheet whose figures deliberately
differ from actuals; and `trade-docs/` holds a €1.27M steel invoice that a
recorded run once reported as household spending.
