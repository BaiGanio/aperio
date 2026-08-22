import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { reconcileFacts, aggregateFacts } from "../../../../lib/docgraph/facts/aggregate.js";
import { toMinor } from "../../../../lib/docgraph/facts/money.js";

/** Build a fact the way createFact would, without re-parsing a document. */
function fact(overrides = {}) {
  const base = {
    document: "doc.txt", root: null, locator: null,
    amount: 120, currency: "BGN",
    period: "2026-06", assignment_date: "2026-06-09", dates: {},
    category: "Fuel", merchant: "PETROLMAX", description: null,
    evidence_kind: "receipt", payment_status: "paid",
    source_locators: {}, confidence: "high",
  };
  const merged = { ...base, ...overrides };
  merged.amount_minor = toMinor(merged.amount, merged.currency);
  return merged;
}

describe("deduplication: shared identifiers", () => {
  test("collapses three representations of one invoice into one charge", () => {
    // March's electricity invoice arrives as .txt, .html and an .eml resend,
    // all carrying invoice 0000424684. Three documents, one charge.
    const facts = ["bill.txt", "e-invoice.html", "reminder.eml"].map(document => fact({
      document, amount: 142.5, category: "Utilities", evidence_kind: "invoice",
      merchant: "СофияЕнерго ЕАД", source_locators: { invoice_no: "0000424684" },
    }));
    const { facts: kept, duplicates } = reconcileFacts(facts);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].document, "bill.txt");
    assert.equal(duplicates.length, 2);
    assert.ok(duplicates.every(d => d.basis === "shared_identifier" && d.confidence === "high"));
  });

  test("does not merge the same identifier at a different amount", () => {
    const facts = [
      fact({ document: "a.txt", amount: 142.5, source_locators: { invoice_no: "X-1" } }),
      fact({ document: "b.txt", amount: 38.2, source_locators: { invoice_no: "X-1" } }),
    ];
    assert.equal(reconcileFacts(facts).facts.length, 2);
  });
});

describe("deduplication: adjudicated receipt ↔ statement row", () => {
  const receipt = fact({ document: "fuel-receipt-09-jun.txt", merchant: "PETROLMAX" });
  const row = fact({
    document: "bank-statement-jun.txt", locator: "row:2",
    evidence_kind: "statement_row", merchant: "PetrolMax fuel station",
    description: "PetrolMax fuel station",
  });

  test("counts a purchase evidenced twice exactly once", () => {
    const { facts: kept, duplicates } = reconcileFacts([receipt, row]);
    assert.equal(kept.length, 1);
    // The charge document is kept: it carries the provider and identifiers.
    assert.equal(kept[0].document, "fuel-receipt-09-jun.txt");
    assert.equal(duplicates[0].basis, "adjudicated");
    assert.ok(duplicates[0].uncertainty.includes("no shared transaction identifier"));
    assert.ok(duplicates[0].evidence.some(e => e.startsWith("merchant overlap")));
  });

  test("tolerates a statement posting a few days after the receipt", () => {
    const posted = { ...row, assignment_date: "2026-06-11" };
    assert.equal(reconcileFacts([receipt, posted]).facts.length, 1);
    const late = { ...row, assignment_date: "2026-06-20" };
    assert.equal(reconcileFacts([receipt, late]).facts.length, 2);
  });

  test("equal amounts alone never establish duplication", () => {
    // Same amount, same day, same currency — but different merchants and
    // therefore two purchases.
    const other = { ...row, merchant: "EuroMarket groceries", description: "EuroMarket groceries", category: "Groceries" };
    assert.equal(reconcileFacts([receipt, other]).facts.length, 2);
  });

  test("never merges two receipts, however alike", () => {
    // The corpus's partial-overlap trap: both fuel receipts share a merchant
    // and a card. Merchant and card overlap is not identity.
    const second = fact({ document: "fuel-receipt-25-jun.txt", assignment_date: "2026-06-09" });
    assert.equal(reconcileFacts([receipt, second]).facts.length, 2);
  });

  test("never merges two statement rows", () => {
    const twin = { ...row, locator: "row:5", document: "bank-statement-jun.txt" };
    assert.equal(reconcileFacts([row, twin]).facts.length, 2);
  });

  test("flags a merge made without merchant evidence for review", () => {
    const anonymousRow = { ...row, merchant: null, description: null };
    const { duplicates } = reconcileFacts([receipt, anonymousRow]);
    assert.equal(duplicates[0].confidence, "adjudicated_weak");
  });
});

describe("deduplication: payment order ↔ the invoice it settles", () => {
  const invoice = fact({
    document: "January/heating-bill-15-jan.txt", amount: 235.27, category: "Utilities",
    evidence_kind: "invoice", merchant: "ТоплоСофия ЕАД",
    period: "2026-01", assignment_date: "2026-01-15",
  });
  const order = fact({
    document: "February/heating-payment-04-feb.docx", amount: 235.27, category: "Utilities",
    evidence_kind: "payment_order", merchant: "ТоплоСофия ЕАД",
    period: "2026-01", assignment_date: "2026-02-04",
  });

  test("counts the settled charge once, keeping the invoice", () => {
    const { facts: kept, duplicates } = reconcileFacts([invoice, order]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].document, "January/heating-bill-15-jan.txt");
    assert.ok(duplicates[0].evidence.some(e => e.includes("same period 2026-01")));
    assert.ok(duplicates[0].uncertainty.includes("payment order"));
  });

  test("tolerates a payment weeks after the invoice, unlike a card posting", () => {
    // The day window that fits a statement posting would reject this pair.
    assert.equal(Math.abs(Date.parse(order.assignment_date) - Date.parse(invoice.assignment_date)) / 86400000 > 3, true);
    assert.equal(reconcileFacts([invoice, order]).facts.length, 1);
  });

  test("does not merge a payment order into a charge from another month", () => {
    const otherMonth = { ...invoice, period: "2025-12", assignment_date: "2025-12-15" };
    assert.equal(reconcileFacts([otherMonth, order]).facts.length, 2);
  });

  test("keeps a payment order that settles nothing else in the corpus", () => {
    // June's internet bill exists only as a completed transfer form.
    const sole = fact({
      document: "June/internet-payment-12-jun.txt", amount: 29.99, category: "Internet",
      evidence_kind: "payment_order", merchant: "НетЛинк ЕООД",
      period: "2026-06", assignment_date: "2026-06-12",
    });
    const { facts: kept, duplicates } = reconcileFacts([sole]);
    assert.equal(kept.length, 1);
    assert.equal(duplicates.length, 0);
  });

  test("never merges two payment orders", () => {
    assert.equal(reconcileFacts([order, { ...order, document: "other.docx" }]).facts.length, 2);
  });
});

describe("deduplication is indexed, not a scan", () => {
  test("stays fast at the documented fact limit when nothing matches", () => {
    // 2,500 statement rows against 2,500 non-matching charge documents. A
    // per-row linear scan is 6.25M adjudications; the index makes each row
    // one failed lookup.
    const facts = [];
    for (let i = 0; i < 2500; i++) {
      facts.push(fact({
        document: "statement.txt", locator: `row:${i}`, evidence_kind: "statement_row",
        amount: 10 + i / 100, category: "Groceries", merchant: `Shop ${i}`, description: `Shop ${i}`,
      }));
      facts.push(fact({
        document: `receipt-${i}.txt`, amount: 5000 + i / 100, category: "Groceries", merchant: `Other ${i}`,
      }));
    }

    const started = performance.now();
    const { facts: kept, duplicates } = reconcileFacts(facts);
    const elapsed = performance.now() - started;

    assert.equal(kept.length, 5000);
    assert.equal(duplicates.length, 0);
    // Generous bound: the linear scan this replaced took ~5s on this corpus.
    assert.ok(elapsed < 1000, `reconcile took ${elapsed.toFixed(0)}ms at the 5000-fact limit`);
  });

  test("bounds a pathologically crowded bucket and reports giving up", () => {
    // Thousands of charges sharing an amount, category and date defeat the
    // index by construction. The search must stop and say so.
    const facts = Array.from({ length: 1000 }, (_, i) =>
      fact({ document: `charge-${i}.txt`, merchant: `Unrelated ${i}` }));
    facts.push(fact({
      document: "statement.txt", locator: "row:1", evidence_kind: "statement_row",
      merchant: "Nothing alike", description: "Nothing alike",
    }));

    const { facts: kept, conflicts } = reconcileFacts(facts);
    assert.equal(kept.length, 1001);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, "duplicate_search_truncated");
    assert.equal(conflicts[0].document, "statement.txt");
  });

  test("surfaces an abandoned search in the aggregate's review list", () => {
    const facts = Array.from({ length: 300 }, (_, i) =>
      fact({ document: `charge-${i}.txt`, merchant: `Unrelated ${i}` }));
    facts.push(fact({
      document: "statement.txt", locator: "row:1", evidence_kind: "statement_row",
      merchant: "Nothing alike", description: "Nothing alike",
    }));
    const result = aggregateFacts(facts, { period: "2026-06" });
    assert.ok(result.review.some(r => r.kind === "duplicate_search_truncated"));
  });

  test("still finds the match when the bucket is crowded", () => {
    // Many facts share an amount and category; only one is a real match, and
    // indexing must not lose it.
    const facts = [];
    for (let i = 0; i < 500; i++) {
      facts.push(fact({ document: `other-${i}.txt`, amount: 120, category: "Fuel", merchant: `Unrelated ${i}`, assignment_date: "2026-01-01", period: "2026-01" }));
    }
    facts.push(fact({ document: "fuel-receipt.txt", merchant: "PETROLMAX" }));
    facts.push(fact({
      document: "statement.txt", locator: "row:1", evidence_kind: "statement_row",
      merchant: "PetrolMax fuel station", description: "PetrolMax fuel station",
    }));

    const { duplicates } = reconcileFacts(facts);
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].kept.document, "fuel-receipt.txt");
  });
});

describe("aggregation", () => {
  test("sums by category and currency without merging currencies", () => {
    const result = aggregateFacts([
      fact({ document: "electricity.txt", amount: 142.5, category: "Utilities" }),
      fact({ document: "water.txt", amount: 38.2, category: "Utilities" }),
      fact({ document: "train.txt", amount: 49.9, currency: "EUR", category: null }),
    ], { period: "2026-06", baseCurrency: "BGN" });

    assert.equal(result.by_currency.BGN.total, 180.7);
    assert.equal(result.by_currency.BGN.by_category.Utilities.total, 180.7);
    assert.equal(result.by_currency.EUR.total, 49.9);
    // No invented exchange rate, no merged total.
    assert.equal(result.by_currency.BGN.by_category.EUR, undefined);
    assert.deepEqual(Object.keys(result.by_currency), ["BGN", "EUR"]);
  });

  test("counts an unclassifiable charge rather than dropping it", () => {
    const result = aggregateFacts([fact({ amount: 12.4, category: null })], { period: "2026-06" });
    assert.equal(result.by_currency.BGN.by_category.Uncategorized.total, 12.4);
    assert.equal(result.by_currency.BGN.total, 12.4);
  });

  test("lets a credit note reduce its category", () => {
    const result = aggregateFacts([
      fact({ document: "bill.txt", amount: 142.5, category: "Utilities" }),
      fact({ document: "credit.txt", amount: -34.2, category: "Utilities", payment_status: "credit_documented" }),
    ], { period: "2026-06" });
    assert.equal(result.by_currency.BGN.by_category.Utilities.total, 108.3);
  });

  test("excludes other periods with a reason instead of silently", () => {
    const result = aggregateFacts([
      fact({ document: "june.txt", period: "2026-06" }),
      fact({ document: "july.txt", period: "2026-07", assignment_date: "2026-07-02" }),
    ], { period: "2026-06" });
    assert.equal(result.by_currency.BGN.total, 120);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].reason, "out_of_period");
    assert.equal(result.excluded[0].document, "july.txt");
  });

  test("reports coverage so a partial answer cannot look complete", () => {
    const result = aggregateFacts(
      [fact({ document: "a.txt" }), fact({ document: "b.txt", locator: "row:1", evidence_kind: "statement_row", merchant: "PetrolMax fuel" })],
      { period: "2026-06", documentsSeen: 4, excluded: [{ document: "c.png", reason: "no_text" }] },
    );
    assert.deepEqual(result.coverage, {
      documents_seen: 4,
      facts_extracted: 2,
      facts_in_period: 2,
      facts_counted: 1,
      duplicates_merged: 1,
      excluded: 1,
    });
  });

  test("is deterministic regardless of input order", () => {
    const facts = [
      fact({ document: "electricity.txt", amount: 142.5, category: "Utilities" }),
      fact({ document: "fuel.txt", amount: 120 }),
      fact({ document: "groceries.txt", amount: 87.45, category: "Groceries", merchant: "FreshMarket" }),
    ];
    const forward = aggregateFacts(facts, { period: "2026-06", baseCurrency: "BGN" });
    const reverse = aggregateFacts([...facts].reverse(), { period: "2026-06", baseCurrency: "BGN" });
    assert.equal(forward.by_currency.BGN.total, reverse.by_currency.BGN.total);
    assert.deepEqual(Object.keys(forward.by_currency.BGN.by_category), Object.keys(reverse.by_currency.BGN.by_category));
  });

  test("totals an empty month as zero facts, not as a failure", () => {
    const result = aggregateFacts([], { period: "2026-06" });
    assert.deepEqual(result.by_currency, {});
    assert.equal(result.coverage.facts_counted, 0);
  });
});
