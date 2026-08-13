// Unit tests for grading-predicates.mjs — the two pure predicates that decide
// whether the provenance ladder (T-G2.3) stops and how its turns are graded.
// Run directly, same pattern as provenance-ladder.test.mjs:
//
//   node --test "trash/plans/document-intelligence-epic/llamacpp-latency/grading-predicates.test.mjs"
//
// Not part of the main `npm test` glob (tests/unit|integration|e2e|harness
// only) — this harness is a manual/isolated diagnostic on the developer's own
// hardware, not a CI assertion, matching the rest of this directory.
//
// The REGRESSION cases below are verbatim from the 2026-08-13 round-8 run
// (document-intelligence-run-answers.json). Every one of them scored false
// before the fix, which escalated the ladder past a correct answer and made
// four grading checks unscoreable. Do not relax them without re-reading the
// round-8 entry in ../document-intelligence-ws2-tg23-open-issues.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasNarratedDecimalTotal, dbQueryReturnedRows, citesQueryProvenance } from "./grading-predicates.mjs";

test("hasNarratedDecimalTotal — round-8 regressions (markdown emphasis)", () => {
  // Turn 3's actual total lines — the correct answer the ladder walked past.
  assert.equal(hasNarratedDecimalTotal("*   **Total in BGN:** 696.84"), true);
  assert.equal(hasNarratedDecimalTotal("**Total in BGN:** 696.84"), true);
  assert.equal(hasNarratedDecimalTotal("*   **Total in EUR:** 196.40"), true);
  // Turn 6's grand-total line.
  assert.equal(
    hasNarratedDecimalTotal(
      "The overall grand total across both currencies is **696.84 BGN** and **196.40 EUR**.",
    ),
    true,
  );
  // Turn 3 in full, as stored.
  assert.equal(
    hasNarratedDecimalTotal(
      "### Grand Total\n\nAs the documents contain expenses in both Bulgarian Lev (BGN) "
      + "and Euro (EUR), I have provided the totals separated by currency, as no exchange "
      + "rate was applied.\n\n*   **Total in BGN:** 696.84\n*   **Total in EUR:** 196.40",
    ),
    true,
  );
});

test("hasNarratedDecimalTotal — plain (unemphasised) forms still pass", () => {
  assert.equal(hasNarratedDecimalTotal("Total in BGN: 696.84"), true);
  assert.equal(hasNarratedDecimalTotal("Total: 696.84"), true);
  assert.equal(hasNarratedDecimalTotal("the grand total is 1 234.56"), true);
  assert.equal(hasNarratedDecimalTotal("total = 696,84"), true);
  assert.equal(hasNarratedDecimalTotal("696.84 BGN total"), true);
  assert.equal(hasNarratedDecimalTotal("The total was EUR 196.40"), true);
});

test("hasNarratedDecimalTotal — inflections models actually use", () => {
  assert.equal(hasNarratedDecimalTotal("Totals: 696.84"), true);
  assert.equal(hasNarratedDecimalTotal("**Utilities:** totaling **260.50 BGN**"), true);
  assert.equal(hasNarratedDecimalTotal("groceries totalling 140.75 BGN"), true);
  assert.equal(hasNarratedDecimalTotal("which totalled 140.75"), true);
});

test("hasNarratedDecimalTotal — still rejects what it was built to reject", () => {
  // The tool's own write ack: full of digits, narrates nothing.
  assert.equal(
    hasNarratedDecimalTotal('✅ Executed on extraction — {"rowsAffected":14,"lastInsertRowid":14}'),
    false,
  );
  assert.equal(hasNarratedDecimalTotal(""), false);
  assert.equal(hasNarratedDecimalTotal(null), false);
  assert.equal(hasNarratedDecimalTotal(undefined), false);
  // A total with no figure at all.
  assert.equal(hasNarratedDecimalTotal("I have saved the grand total to the table."), false);
  // Integers are not decimal totals — the gate wants a stated amount.
  assert.equal(hasNarratedDecimalTotal("total rows: 14"), false);
  // A bare figure with no total cue anywhere.
  assert.equal(hasNarratedDecimalTotal("Fuel was 215.60 BGN on the 9th."), false);
  // Prose must not bridge a cue to an unrelated number far away: the gap
  // classes admit emphasis and whitespace, never words beyond the 5-word run.
  assert.equal(
    hasNarratedDecimalTotal("total is what I would compute if you asked me again later on 696.84"),
    false,
  );
});

test("citesQueryProvenance — round-9 regression (table/database attribution)", () => {
  // Turn 2's actual opening line — the sole check that failed round 9, on an
  // answer that had queried 6 real rows and named the table it read them from.
  assert.equal(
    citesQueryProvenance(
      "Here is the verified category breakdown and the final grand total, pulled "
      + "directly from the `spending_summary` database.",
    ),
    true,
  );
  assert.equal(citesQueryProvenance("read back from the spending_summary table"), true);
  assert.equal(citesQueryProvenance("These totals come from the database, not my own arithmetic."), true);
});

test("citesQueryProvenance — SQL vocabulary still counts (pre-round-9 behaviour)", () => {
  assert.equal(citesQueryProvenance("I ran the following SQL:"), true);
  assert.equal(citesQueryProvenance("the db_query returned six rows"), true);
  assert.equal(citesQueryProvenance("I queried it per category"), true);
  assert.equal(citesQueryProvenance("this query groups by currency"), true);
  assert.equal(citesQueryProvenance("querying the summary per category"), true);
});

test("citesQueryProvenance — does not accept write-side or bare claims", () => {
  // "saved"/"stored" describe the WRITE. An answer reciting remembered figures
  // while pointing at a past save must not pass — the 2026-08-02 failure mode.
  assert.equal(citesQueryProvenance("Here are the totals I saved for you earlier."), false);
  assert.equal(citesQueryProvenance("I have stored and recorded the results."), false);
  // No provenance claim at all.
  assert.equal(citesQueryProvenance("The grand total is 696.84 BGN."), false);
  assert.equal(citesQueryProvenance(""), false);
  assert.equal(citesQueryProvenance(null), false);
  assert.equal(citesQueryProvenance(undefined), false);
});

test("dbQueryReturnedRows — rows vs empty vs wrong tool", () => {
  const call = (name, detail) => [{ name, detail, summary: "" }];
  assert.equal(dbQueryReturnedRows(call("db_query", '{"rowCount": 6, "rows": [{"a":1}]}')), true);
  assert.equal(dbQueryReturnedRows(call("db_query", '{"rowCount": 0, "rows": []}')), false);
  // rowCount can fall outside a capped detail; a non-empty rows array suffices.
  assert.equal(dbQueryReturnedRows(call("db_query", '{"rows": [{"category":"Fuel"}]')), true);
  assert.equal(dbQueryReturnedRows(call("db_execute", '{"rowCount": 6, "rows": [{"a":1}]}')), false);
  assert.equal(dbQueryReturnedRows([]), false);
  assert.equal(dbQueryReturnedRows(undefined), false);
});
