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

  test("labels the Bulgarian final-total line, not an itemized breakdown line above it (household corpus fixture)", () => {
    const text = [
      "Краен срок за плащане: 30.06.2026",
      "Топлинна енергия за отопление:     0,310 MWh x 152,00 лв  =  47,12 лв",
      "Стойност без ДДС:                               54,00 лв",
      "ДДС 20%:                                        10,80 лв",
      "ЗА ПЛАЩАНЕ (с ДДС):                              64,80 лв",
      "Основание за плащане: Парно 05/2026, аб. № 8800123",
    ].join("\n");
    const amounts = extractAmountCandidates(text);
    const total = amounts.find(a => a.label === "amount_due");
    assert.ok(total, "expected an amount_due label from 'ЗА ПЛАЩАНЕ'");
    assert.equal(total.value, 64.8);
    const subtotal = amounts.find(a => a.label === "subtotal");
    assert.equal(subtotal.value, 54);
    // "Краен срок за плащане" (payment deadline) and "Основание за плащане"
    // (payment reference) both contain the same words but are NOT the total
    // — must not produce a spurious second amount_due from the date/text.
    assert.equal(amounts.filter(a => a.label === "amount_due").length, 1);
  });

  test("labels the German grand-total and subtotal lines", () => {
    const text = "Zwischensumme   128,00\nGESAMTBETRAG:   128,00 EUR";
    const amounts = extractAmountCandidates(text);
    assert.ok(amounts.some(a => a.label === "subtotal" && a.value === 128));
    assert.ok(amounts.some(a => a.label === "grand_total" && a.value === 128));
  });

  test("labels a French subtotal as 'subtotal', not 'total', despite the shared substring, in document order", () => {
    const amounts = extractAmountCandidates("Sous-total HT:   15,42\nTOTAL:   18,50 EUR");
    assert.deepEqual(amounts.map(a => ({ label: a.label, value: a.value })), [
      { label: "subtotal", value: 15.42 },
      { label: "total", value: 18.5 },
    ]);
  });

  test("likely_total fallback tags the last currency-bearing unlabeled amount for an unmodeled language", () => {
    // Simulated invoice in a language with no AMOUNT_LABELS coverage: a
    // breakdown line, then a final total, neither carrying a recognized word
    // (and no accidental substring overlap with any existing pattern).
    const amounts = extractAmountCandidates("Articol: 100.00 EUR\nSumă de plată: 120.00 EUR");
    assert.deepEqual(amounts.map(a => ({ label: a.label, value: a.value })), [
      { label: null, value: 100 },
      { label: "likely_total", value: 120 },
    ]);
  });

  test("likely_total fallback never fires when every candidate already has a real label or no currency", () => {
    const labeled = extractAmountCandidates("Total: 100.00 BGN");
    assert.equal(labeled[0].label, "total");
    const noCurrency = extractAmountCandidates("Reference number 4471203 printed here.");
    assert.deepEqual(noCurrency, []);
  });
});
