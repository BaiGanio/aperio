// tests/unit/docgraph/extract-facts.test.js
// Unit tests for the date-role and amount/currency extractor (#311). Pure functions.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractDateCandidates, extractAmountCandidates } from "../../../lib/docgraph/extract-facts.js";

describe("extractDateCandidates", () => {
  test("labels a June invoice date and a May service period distinctly (the #311 fixture)", () => {
    const text = [
      "Invoice Date: 03.06.2026",
      "Service Period: 01.05.2026 to 31.05.2026",
      "Due Date: 20.06.2026",
    ].join("\n");
    const dates = extractDateCandidates(text);
    const byRole = Object.fromEntries(dates.map(d => [d.role, d]));
    assert.equal(byRole.invoice_date.value, "2026-06-03");
    assert.equal(byRole.service_period_start.value, "2026-05-01");
    assert.equal(byRole.service_period_end.value, "2026-05-31");
    assert.equal(byRole.due_date.value, "2026-06-20");
    assert.ok(dates.every(d => d.confidence === "high"));
  });

  test("recognizes ISO and month-name date shapes", () => {
    const dates = extractDateCandidates("Statement Date: 2026-06-03. Receipt Date: June 5, 2026.");
    const byRole = Object.fromEntries(dates.map(d => [d.role, d]));
    assert.equal(byRole.statement_date.value, "2026-06-03");
    assert.equal(byRole.receipt_date.value, "2026-06-05");
  });

  test("labels an unlabeled date as unlabeled_date with low confidence instead of dropping it", () => {
    const dates = extractDateCandidates("Printed on 03.06.2026 for internal records.");
    assert.equal(dates.length, 1);
    assert.equal(dates[0].role, "unlabeled_date");
    assert.equal(dates[0].confidence, "low");
    assert.equal(dates[0].value, "2026-06-03");
  });

  test("a single service-period date without a range end is reported without inventing the end", () => {
    const dates = extractDateCandidates("Billing Period: starting 01.05.2026, ongoing.");
    assert.deepEqual(dates.map(d => d.role), ["service_period_start"]);
  });

  test("a locale-ambiguous slash date keeps its raw token but reports value: null", () => {
    const dates = extractDateCandidates("Due Date: 06/03/2026");
    assert.equal(dates.length, 1);
    assert.equal(dates[0].raw, "06/03/2026");
    assert.equal(dates[0].value, null, "MM/DD vs DD/MM is genuinely ambiguous without a locale — must not guess");
  });

  test("empty / no-date text yields nothing", () => {
    assert.deepEqual(extractDateCandidates(""), []);
    assert.deepEqual(extractDateCandidates("no dates in this sentence at all"), []);
  });
});

describe("extractAmountCandidates", () => {
  test("tags amount, currency, and the nearest money label — not the first label in the document", () => {
    const text = "Amount Due: 142.50 BGN\nSubtotal: 130.00 BGN\nTotal: 272.50 BGN\n";
    const amounts = extractAmountCandidates(text);
    assert.deepEqual(amounts, [
      { value: 142.5, currency: "BGN", raw: "142.50 BGN", label: "amount_due" },
      { value: 130, currency: "BGN", raw: "130.00 BGN", label: "subtotal" },
      { value: 272.5, currency: "BGN", raw: "272.50 BGN", label: "total" },
    ]);
  });

  test("handles a currency symbol prefix and a European decimal comma", () => {
    const amounts = extractAmountCandidates("Paid $50.00 and later 42,50 EUR was refunded.");
    assert.deepEqual(amounts.map(a => ({ value: a.value, currency: a.currency })), [
      { value: 50, currency: "USD" },
      { value: 42.5, currency: "EUR" },
    ]);
  });

  test("reports a money-labeled bare number with currency: null instead of dropping it", () => {
    const amounts = extractAmountCandidates("Balance: 45.20\nno money here");
    assert.deepEqual(amounts, [{ value: 45.2, currency: null, raw: "45.20", label: "balance" }]);
  });

  test("empty / no-amount text yields nothing, never a fabricated zero", () => {
    assert.deepEqual(extractAmountCandidates(""), []);
    assert.deepEqual(extractAmountCandidates("no money mentioned here"), []);
  });
});
