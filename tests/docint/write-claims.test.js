// Unit tests for write-claims.mjs — the phantom-write check.
//
//   npm run test:docint
//
// The two anchor cases are verbatim strings from real archived runs, one of
// each polarity:
//
//   * Ornith-1.0-9B (2026-08-14, `status: pass`) — one INSERT of 10 BGN tuples,
//     zero EUR, and an answer telling the user the EUR receipts "are saved
//     separately". TRUE POSITIVE: this is the defect the check exists for.
//   * gemma-4-26B-A4B (2026-08-14, `status: pass`) — an INSERT carrying both
//     BGN and EUR literals, and an answer that says "retrieved from the saved
//     records". TRUE NEGATIVE: a read described with an adjectival "saved",
//     over rows that genuinely exist. The check must stay silent.
//
// The rest are the phrasings that would make this the FIFTH false-failure of
// the prose-matching class on this gate, and each one asserts silence.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  phantomWriteClaims,
  writtenCurrencyCounts,
  relevantCurrencies,
} from "./write-claims.mjs";

const EXPECTATIONS = {
  excluded: [
    { document: "2026/June/train-berlin-munich-14-jun.txt", amount: 49.9, currency: "EUR", kind: "EUR travel" },
    { document: "2026/June/hotel-berlin-14-15-jun.pdf", amount: 128, currency: "EUR", kind: "EUR travel" },
    { document: "2026/June/airport-paris-16-jun.pdf", amount: 18.5, currency: "EUR", kind: "EUR travel" },
  ],
};

/** A confirmed INSERT of `n` BGN tuples and `m` EUR tuples. */
function insertCall(bgn, eur, overrides = {}) {
  const tuples = [
    ...Array.from({ length: bgn }, (_, i) => `('2026-06', 'BGN', 'Utilities', ${10 + i}.00, 'doc${i}.txt')`),
    ...Array.from({ length: eur }, (_, i) => `('2026-06', 'EUR', 'Travel', ${20 + i}.00, 'trip${i}.pdf')`),
  ].join(",\n");
  return {
    name: "db_execute",
    ok: true,
    pending: false,
    arguments: {
      connection: "extraction",
      sql: `INSERT INTO monthly_spending (period, currency, category, amount, source_document) VALUES\n${tuples}`,
    },
    ...overrides,
  };
}

// Verbatim, from var/docint-runs/provenance-2026-08-13T22-10-00-129Z-69812.json,
// turn 2. One line, two sentences; the currency is named only in the first.
const ORNITH_EUR_BLOCK =
  "**Note on EUR documents:** 3 travel-related receipts were documented in EUR but excluded " +
  "from the household total per category — a Berlin hotel (128 EUR), a Berlin→Munich train " +
  "(49.90 EUR), and a Paris airport café (18.50 EUR). These are saved separately if you want " +
  "them queried as well, or tell me if you'd rather include them in the total.";

// Verbatim, from var/docint-runs/provenance-2026-08-13T22-48-51-653Z-71332.json, turn 2.
const GEMMA26B_READ =
  "Here is the breakdown of your spending for June 2026, retrieved from the saved records:";

test("Ornith's passing run: an anaphoric save-claim for a currency with zero rows is caught", () => {
  const violations = phantomWriteClaims({
    text: ORNITH_EUR_BLOCK,
    toolCalls: [insertCall(10, 0)],
    expectations: EXPECTATIONS,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].currency, "EUR");
  assert.equal(violations[0].scope, "inherited");
  assert.match(violations[0].claim, /These are saved separately/);
});

test("gemma-4-26B's passing run stays clean: the EUR rows it narrates were really written", () => {
  const violations = phantomWriteClaims({
    text: GEMMA26B_READ,
    toolCalls: [insertCall(10, 3)],
    expectations: EXPECTATIONS,
  });
  assert.deepEqual(violations, []);
});

test("an adjectival 'saved records' is a read, not a write claim — silent even with zero EUR rows", () => {
  const violations = phantomWriteClaims({
    text: GEMMA26B_READ,
    toolCalls: [insertCall(10, 0)],
    expectations: EXPECTATIONS,
  });
  assert.deepEqual(violations, []);
});

test("the honest disclosure — 'were not saved' — is not a violation", () => {
  for (const text of [
    "The three EUR travel receipts were not saved to the table; they are reported separately.",
    "The EUR receipts weren't stored, since no exchange rate was applied.",
    "I did not insert the EUR rows.",
  ]) {
    assert.deepEqual(
      phantomWriteClaims({ text, toolCalls: [insertCall(10, 0)], expectations: EXPECTATIONS }),
      [],
      `should stay silent on: ${text}`,
    );
  }
});

test("offers and intentions are not completed writes", () => {
  for (const text of [
    "The EUR receipts can be saved separately if you want them queried.",
    "I will store the EUR rows in a second table if you confirm.",
    "Would you like me to save the EUR receipts as well?",
    "The EUR travel documents are ready to be inserted on your confirmation.",
  ]) {
    assert.deepEqual(
      phantomWriteClaims({ text, toolCalls: [insertCall(10, 0)], expectations: EXPECTATIONS }),
      [],
      `should stay silent on: ${text}`,
    );
  }
});

test("a claim naming its own currency is caught with sentence scope", () => {
  const violations = phantomWriteClaims({
    text: "The EUR travel rows are stored in the extraction table alongside the BGN ones.",
    toolCalls: [insertCall(10, 0)],
    expectations: EXPECTATIONS,
  });
  // Names two currencies → undecidable → silent. Attribution must be certain.
  assert.deepEqual(violations, []);

  const single = phantomWriteClaims({
    text: "The EUR travel rows are stored in the extraction table.",
    toolCalls: [insertCall(10, 0)],
    expectations: EXPECTATIONS,
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].currency, "EUR");
  assert.equal(single[0].scope, "sentence");
});

test("anaphora does not reach across blocks", () => {
  const text = `Three receipts were documented in EUR.\n\nEverything is saved and queryable.`;
  assert.deepEqual(
    phantomWriteClaims({ text, toolCalls: [insertCall(10, 0)], expectations: EXPECTATIONS }),
    [],
  );
});

test("a pending proposal is not a write, and an all-pending run stays silent rather than firing", () => {
  const pending = insertCall(10, 0, { pending: true });
  const { currencyCounts } = writtenCurrencyCounts([pending], new Set(["BGN", "EUR"]));
  assert.equal(currencyCounts.size, 0);

  // Constraint 5: nothing was written with a currency tag, so absence proves
  // nothing — the check must not report the EUR claim here.
  assert.deepEqual(
    phantomWriteClaims({ text: ORNITH_EUR_BLOCK, toolCalls: [pending], expectations: EXPECTATIONS }),
    [],
  );
});

test("a failed db_execute is not a write", () => {
  const failed = insertCall(10, 0, { ok: false });
  const { currencyCounts, insertStatements } = writtenCurrencyCounts([failed], new Set(["BGN"]));
  assert.equal(insertStatements, 0);
  assert.equal(currencyCounts.size, 0);
});

test("a schema that stores no currency literal disarms the check entirely", () => {
  const noCurrency = {
    name: "db_execute",
    ok: true,
    pending: false,
    arguments: { connection: "extraction", sql: "INSERT INTO spending (category, amount) VALUES ('Fuel', 215.60)" },
  };
  assert.deepEqual(
    phantomWriteClaims({ text: ORNITH_EUR_BLOCK, toolCalls: [noCurrency], expectations: EXPECTATIONS }),
    [],
  );
});

test("currencies come from the oracle and the SQL, never from the answer's prose", () => {
  const known = relevantCurrencies(EXPECTATIONS, [insertCall(1, 0)]);
  assert.ok(known.has("EUR"), "EUR is oracle-documented as excluded");
  assert.ok(known.has("BGN"), "BGN was actually written");
  assert.equal(known.has("USD"), false, "never seen in oracle or SQL");

  // A USD claim therefore cannot fire, however phrased.
  assert.deepEqual(
    phantomWriteClaims({
      text: "The USD receipts are saved separately.",
      toolCalls: [insertCall(10, 0)],
      expectations: EXPECTATIONS,
    }),
    [],
  );
});

test("a write claim for a currency that WAS written is not a violation", () => {
  const violations = phantomWriteClaims({
    text: "The EUR travel rows are stored in the extraction table.",
    toolCalls: [insertCall(10, 3)],
    expectations: EXPECTATIONS,
  });
  assert.deepEqual(violations, []);
});

test("no expectations and no writes: silent, never a spurious pass or fail", () => {
  assert.deepEqual(phantomWriteClaims({ text: ORNITH_EUR_BLOCK, toolCalls: [] }), []);
  assert.deepEqual(phantomWriteClaims({ text: "", toolCalls: [insertCall(10, 0)], expectations: EXPECTATIONS }), []);
});
