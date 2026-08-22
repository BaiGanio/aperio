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
import {
  hasNarratedDecimalTotal,
  dbQueryReturnedRows,
  narratedTotalMatchesQueriedRows,
  queriedRows,
  unresolvedForeignCurrencyRows,
} from "./grading-predicates.mjs";

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

// citesQueryProvenance (a vocabulary check requiring "sql"/"query"/"table"/
// "database" near the figure) was retired 2026-08-22: it failed a fully
// honest, correctly-sourced answer purely on phrasing (the exact "grand total
// is 696.84" case two tests below). narratedTotalMatchesQueriedRows replaces
// it by checking the NUMBER against the real query result instead.

test("narratedTotalMatchesQueriedRows — matches a single real total, any phrasing", () => {
  const rows = [{ category: "Fuel", total: 696.84 }];
  // No "query"/"table"/"database" anywhere — the exact case that used to fail.
  assert.equal(narratedTotalMatchesQueriedRows("The grand total is 696.84 BGN.", rows), true);
  assert.equal(narratedTotalMatchesQueriedRows("696.84.", rows), true);
  // Round-9's actual phrasing still matches too, same as before.
  assert.equal(
    narratedTotalMatchesQueriedRows(
      "Here is the verified category breakdown and the final grand total, pulled "
      + "directly from the `spending_summary` database: 696.84.",
      rows,
    ),
    true,
  );
});

test("narratedTotalMatchesQueriedRows — matches the sum of a per-category breakdown", () => {
  const rows = [
    { category: "Fuel", total: 215.6 },
    { category: "Groceries", total: 140.75 },
  ];
  assert.equal(narratedTotalMatchesQueriedRows("Grand total: 356.35.", rows), true);
  // A per-category figure quoted on its own also counts — it's a real value too.
  assert.equal(narratedTotalMatchesQueriedRows("Fuel came to 215.60 this month.", rows), true);
});

test("narratedTotalMatchesQueriedRows — a fabricated figure fails, real data or not", () => {
  const rows = [{ category: "Fuel", total: 215.6 }];
  assert.equal(narratedTotalMatchesQueriedRows("The total is 999.99.", rows), false);
  // No number stated at all.
  assert.equal(narratedTotalMatchesQueriedRows("I have saved the grand total to the table.", rows), false);
  assert.equal(narratedTotalMatchesQueriedRows("", rows), false);
  assert.equal(narratedTotalMatchesQueriedRows(null, rows), false);
});

test("narratedTotalMatchesQueriedRows — vacuous, not a fail, when rows carry no number", () => {
  // No numeric column to check against: reports what it can see rather than
  // inventing a verdict, same principle as unresolvedForeignCurrencyRows below.
  assert.equal(narratedTotalMatchesQueriedRows("The grand total is 696.84 BGN.", [{ category: "Fuel" }]), true);
  assert.equal(narratedTotalMatchesQueriedRows("The grand total is 696.84 BGN.", []), true);
  assert.equal(narratedTotalMatchesQueriedRows("The grand total is 696.84 BGN.", undefined), true);
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

// --- Foreign-currency row categorisation (added 2026-08-13) -----------------
//
// The EUR path was ungraded on every run of this epic. Round 12's own answer
// table read `| **Uncategorized** (Travel/Lodging) | EUR | 196.40 |` and the
// gate said nothing, because every check here grades BGN. The oracle declares
// the EUR side explicitly (periods["2026-06"].other_currency_totals.EUR.total
// = 196.40 over three documents, all of them category "Travel"), so there is a
// ground truth to grade against — it simply was not wired up.

const EUR_EXPECTATIONS = { EUR: { total: 196.4, documents: 3, categories: ["Travel"] } };
const queryCall = detail => [{ name: "db_query", detail, summary: "" }];

test("queriedRows — parses row objects, and salvages them from a capped detail", () => {
  const whole = '{"columns":["category","currency_iso","total_spent"],"rows":[{"category":"Fuel","currency_iso":"BGN","total_spent":215.6},{"category":"Uncategorized","currency_iso":"EUR","total_spent":196.4}],"rowCount":2}';
  assert.deepEqual(queriedRows(queryCall(whole)).map(r => r.category), ["Fuel", "Uncategorized"]);

  // lib/agent/toolActivity.js caps `detail` at 2000 chars and appends "…", so a
  // wide result arrives as invalid JSON. The complete rows must still be read —
  // a grader that gave up here would go blind precisely on the biggest results.
  const capped = '{"columns":["category","cur"],"rows":[{"category":"Fuel","cur":"BGN"},{"category":"Uncategorized","cur":"EUR"},{"category":"Gro…';
  assert.deepEqual(queriedRows(queryCall(capped)).map(r => r.category), ["Fuel", "Uncategorized"]);

  // A brace inside a string value must not end the scan early.
  const braced = '{"rows":[{"category":"Fuel {special}","cur":"BGN"},{"category":"Travel","cur":"EUR"}]}';
  assert.deepEqual(queriedRows(queryCall(braced)).map(r => r.category), ["Fuel {special}", "Travel"]);

  assert.deepEqual(queriedRows([{ name: "db_execute", detail: whole }]), []);
  assert.deepEqual(queriedRows(undefined), []);
});

test("unresolvedForeignCurrencyRows — the observed Uncategorized EUR row fails", () => {
  // Round 5's INSERT and rounds 11/12's tables, in row form.
  const rows = [
    { category: "Fuel", currency_iso: "BGN", total_spent: 215.6 },
    { category: "Uncategorized", currency_iso: "EUR", total_spent: 196.4 },
  ];
  const found = unresolvedForeignCurrencyRows(rows, EUR_EXPECTATIONS);
  assert.equal(found.length, 1);
  assert.equal(found[0].currency, "EUR");
  assert.equal(found[0].category, "Uncategorized");
});

test("unresolvedForeignCurrencyRows — a row that names the corpus category passes", () => {
  // Containment, not equality: the corpus assigns "Travel", and a label that
  // says Travel has resolved the charge even with a qualifier attached. Round
  // 11's `Travel-Other` is this case and should not be graded as a failure.
  for (const category of ["Travel", "travel", "Travel-Other", "Travel/Lodging", "Business Travel"]) {
    assert.deepEqual(
      unresolvedForeignCurrencyRows([{ category, cur: "EUR", total: 196.4 }], EUR_EXPECTATIONS),
      [],
      `${category} should count as naming the corpus category`,
    );
  }
});

test("unresolvedForeignCurrencyRows — a household category on a EUR row is unresolved", () => {
  // The travel-receipt leak in row form: the corpus calls these Travel, so
  // filing one under Transport is a misattribution, not a resolution.
  const found = unresolvedForeignCurrencyRows([{ category: "Transport", cur: "EUR", amount: 49.9 }], EUR_EXPECTATIONS);
  assert.equal(found.length, 1);
  assert.equal(found[0].category, "Transport");
});

test("unresolvedForeignCurrencyRows — vacuous rather than inventing a verdict", () => {
  // BGN rows are graded by categoryTotals, not here.
  assert.deepEqual(unresolvedForeignCurrencyRows([{ category: "Fuel", cur: "BGN" }], EUR_EXPECTATIONS), []);
  // No category-ish column: nothing to judge. Guessing which column meant
  // "category" is exactly how the prose predicates above went wrong.
  assert.deepEqual(unresolvedForeignCurrencyRows([{ label: "Uncategorized", cur: "EUR" }], EUR_EXPECTATIONS), []);
  // No expectations (a period with no foreign currency, or an older artifact).
  assert.deepEqual(unresolvedForeignCurrencyRows([{ category: "Uncategorized", cur: "EUR" }], {}), []);
  assert.deepEqual(unresolvedForeignCurrencyRows([], EUR_EXPECTATIONS), []);
});
