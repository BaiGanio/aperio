import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { factsFromDocument, factsFromDocuments } from "../../../../lib/docgraph/facts/extract.js";
import { aggregateDocuments } from "../../../../lib/docgraph/facts/index.js";
import { isStatementLike, parseStatementRows, parseRowDate, parseRowAmount } from "../../../../lib/docgraph/facts/statement.js";

const STATEMENT = `FIRST DIGITAL BANK
Account Statement

IBAN:             BG80BNBG96611020345678
Currency:         BGN
Statement period: 01.06.2026 – 30.06.2026
Opening balance:  4 250.00 BGN
Closing balance:  3 989.25 BGN

===============================================================================
 Date        Description                          Category      Amount (BGN)
-------------------------------------------------------------------------------
 07.06.2026  FreshMarket #218 groceries            Groceries           -87.45
 09.06.2026  PetrolMax fuel station                Fuel               -120.00
 18.06.2026  EuroMarket groceries                  Groceries           -53.30
-------------------------------------------------------------------------------
 Total debits for period                                              -260.75
===============================================================================
`;

const FUEL_RECEIPT = `        P E T R O L M A X
     Fuel Station #17 - Sofia
       VAT No: BG204567890

-----------------------------------------
 FISCAL RECEIPT
-----------------------------------------
 Date: 09.06.2026        Time: 08:42
 Receipt No: 0417-000239
-----------------------------------------
 Diesel Pro       42.55 L      120.00 BGN
-----------------------------------------
 TOTAL                         120.00 BGN
 Card payment                  120.00 BGN
`;

const ELECTRICITY_BILL = `СофияЕнерго ЕАД
Продажба на електрическа енергия

------------------------------------------------------------
ФАКТУРА ЗА ЕЛЕКТРОЕНЕРГИЯ
------------------------------------------------------------

Фактура №:            0000451287
Дата на издаване:     03.06.2026
Период на отчитане:   01.05.2026 – 31.05.2026
Краен срок за плащане: 20.06.2026

Стойност без ДДС:     118,75 лв
ДДС 20%:               23,75 лв
ЗА ПЛАЩАНЕ (с ДДС):   142,50 лв
`;

describe("statement row parsing", () => {
  test("recognizes a transaction table by header and rows together", () => {
    assert.equal(isStatementLike(STATEMENT), true);
    // An invoice with line items is not a statement, however tabular.
    assert.equal(isStatementLike(ELECTRICITY_BILL), false);
    assert.equal(isStatementLike(""), false);
  });

  test("parses date, description, category column and signed amount", () => {
    const { rows, currency } = parseStatementRows(STATEMENT);
    assert.equal(currency, "BGN");
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map(r => [r.date, r.category, r.amount]),
      [["2026-06-07", "Groceries", -87.45], ["2026-06-09", "Fuel", -120], ["2026-06-18", "Groceries", -53.3]],
    );
    assert.equal(rows[0].description, "FreshMarket #218 groceries");
  });

  test("ignores the totals footer, which carries no date", () => {
    assert.ok(!parseStatementRows(STATEMENT).rows.some(r => r.amount === -260.75));
  });

  test("parses day-first and ISO dates, rejecting impossible ones", () => {
    assert.equal(parseRowDate("07.06.2026"), "2026-06-07");
    assert.equal(parseRowDate("2026-06-07"), "2026-06-07");
    assert.equal(parseRowDate("07/06/26"), "2026-06-07");
    assert.equal(parseRowDate("31.02.2026"), null);
    assert.equal(parseRowDate("nonsense"), null);
  });

  test("parses thousands-separated and comma-decimal amounts", () => {
    assert.equal(parseRowAmount("-1 234.56"), -1234.56);
    assert.equal(parseRowAmount("-1 234,56"), -1234.56);
    assert.equal(parseRowAmount("87.45"), 87.45);
  });
});

describe("facts from a statement", () => {
  test("emits one positive spending fact per debit row", () => {
    const { facts } = factsFromDocument({ document: "June/bank-statement-jun.txt", text: STATEMENT });
    assert.equal(facts.length, 3);
    assert.deepEqual(facts.map(f => f.amount), [87.45, 120, 53.3]);
    assert.ok(facts.every(f => f.evidence_kind === "statement_row"));
    assert.ok(facts.every(f => f.payment_status === "paid"));
    assert.deepEqual(facts.map(f => f.category), ["Groceries", "Fuel", "Groceries"]);
    assert.deepEqual(facts.map(f => f.locator), ["row:1", "row:2", "row:3"]);
  });

  test("never counts an incoming credit as spending", () => {
    const withSalary = STATEMENT.replace(
      " 18.06.2026  EuroMarket groceries                  Groceries           -53.30",
      " 18.06.2026  Salary payment                        Income             1850.00");
    const { facts, excluded } = factsFromDocument({ document: "s.txt", text: withSalary });
    assert.equal(facts.length, 2);
    assert.equal(excluded.find(e => e.reason === "incoming_credit").detail.includes("1850"), true);
  });
});

describe("facts from a charge document", () => {
  test("takes the terminal total, not the line items or the subtotal", () => {
    const { facts } = factsFromDocument({ document: "June/electricity-bill-03-jun.txt", text: ELECTRICITY_BILL });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].amount, 142.5);
    assert.equal(facts[0].amount_minor, 14250);
    assert.equal(facts[0].category, "Utilities");
    assert.equal(facts[0].evidence_kind, "invoice");
    // Issued in June for May consumption — the charge belongs to June.
    assert.equal(facts[0].period, "2026-06");
    assert.equal(facts[0].payment_status, "amount_due_documented");
    assert.equal(facts[0].source_locators.invoice_no, "0000451287");
  });

  test("reads a receipt's own date and marks it paid", () => {
    const { facts } = factsFromDocument({ document: "June/fuel-receipt-09-jun.txt", text: FUEL_RECEIPT });
    assert.equal(facts[0].amount, 120);
    assert.equal(facts[0].category, "Fuel");
    assert.equal(facts[0].assignment_date, "2026-06-09");
    assert.equal(facts[0].payment_status, "paid");
    assert.equal(facts[0].merchant, "PETROLMAX");
  });

  test("excludes a notice that announces future prices but charges nothing", () => {
    const { facts, excluded } = factsFromDocument({
      document: "June/tax-increase-notice.txt",
      text: "СЪОБЩЕНИЕ\nУвеличение от 7,40 лв. считано от 01.07.2026\nНова цена: 107,40 лв.",
    });
    assert.equal(facts.length, 0);
    assert.equal(excluded[0].reason, "no_terminal_amount");
  });

  test("excludes trade finance whatever its size", () => {
    const { facts, excluded } = factsFromDocument({
      document: "trade-docs/commercial-invoice.txt",
      text: "COMMERCIAL INVOICE\nInvoice Date: 2026-06-25\nIncoterms: CIF Göteborg\nTOTAL: EUR 1 266 250,00",
    });
    assert.equal(facts.length, 0);
    assert.equal(excluded[0].reason, "commercial_document");
  });

  test("reports an image-only document as coverage loss, not as zero", () => {
    const { facts, excluded } = factsFromDocument({ document: "June/grocery-receipt.png", text: "" });
    assert.equal(facts.length, 0);
    assert.equal(excluded[0].reason, "no_text");
  });

  test("refuses to pick between two different totals in one document", () => {
    const { facts, excluded } = factsFromDocument({
      document: "two-invoices.txt",
      text: "ФАКТУРА\nДата на издаване: 03.06.2026\nЗА ПЛАЩАНЕ (с ДДС): 142,50 лв\nЗА ПЛАЩАНЕ (с ДДС): 38,20 лв",
    });
    assert.equal(facts.length, 0);
    assert.equal(excluded[0].reason, "ambiguous_total");
  });

  test("keeps a credit note negative so it reduces its category", () => {
    const { facts } = factsFromDocument({
      document: "Feb/electricity-credit-note.txt",
      text: "СофияЕнерго ЕАД\nКРЕДИТНО ИЗВЕСТИЕ към ФАКТУРА ЗА ЕЛЕКТРОЕНЕРГИЯ\nДата на издаване: 12.02.2026\nЗА ПЛАЩАНЕ (с ДДС): -34,20 лв",
    });
    assert.equal(facts[0].amount, -34.2);
    assert.equal(facts[0].amount_minor, -3420);
    assert.equal(facts[0].payment_status, "credit_documented");
  });
});

describe("everyday Bulgarian terminal amounts", () => {
  test("recognizes 'Сума за плащане' as the amount due", () => {
    const { facts } = factsFromDocument({
      document: "water-bill.txt",
      text: "ВодаСофия ЕАД\nФАКТУРА ЗА ВОДОСНАБДЯВАНЕ\nДата на издаване: 05.06.2026\nОбща сума за плащане: 38,20 лв",
    });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].amount, 38.2);
    assert.equal(facts[0].amount_label, "amount_due");
  });

  test("recognizes a credit note's refund line and keeps it negative", () => {
    const { facts } = factsFromDocument({
      document: "electricity-credit-note.txt",
      text: [
        "СофияЕнерго ЕАД",
        "КРЕДИТНО ИЗВЕСТИЕ КЪМ ФАКТУРА ЗА ЕЛЕКТРОЕНЕРГИЯ",
        "Дата на издаване:     10.02.2026",
        "Стойност без ДДС:    -28,50 лв",
        "ДДС 20%:              -5,70 лв",
        "СУМА ЗА ВЪЗСТАНОВЯВАНЕ (с ДДС): -34,20 лв",
      ].join("\n"),
    });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].amount, -34.2);
    assert.equal(facts[0].amount_label, "refund_due");
    assert.equal(facts[0].category, "Utilities");
    assert.equal(facts[0].payment_status, "credit_documented");
  });

  test("treats an unsigned credit-note refund line as a credit, not spending", () => {
    // The printer omits the minus; the refund label is still the document's
    // claim of money coming back. A positive refund_due would inflate the
    // category total instead of reducing it.
    const { facts } = factsFromDocument({
      document: "electricity-credit-note-unsigned.txt",
      text: [
        "СофияЕнерго ЕАД",
        "КРЕДИТНО ИЗВЕСТИЕ КЪМ ФАКТУРА ЗА ЕЛЕКТРОЕНЕРГИЯ",
        "Дата на издаване:     10.02.2026",
        "СУМА ЗА ВЪЗСТАНОВЯВАНЕ (с ДДС): 34,20 лв",
      ].join("\n"),
    });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].amount, -34.2);
    assert.equal(facts[0].amount_label, "refund_due");
    assert.equal(facts[0].payment_status, "credit_documented");

    // End to end: the refund reduces its category's total rather than adding
    // to it (regression for the unsigned-sign bug).
    const { by_currency } = aggregateDocuments([
      { document: "Feb/electricity-bill.txt", text: "СофияЕнерго ЕАД\nФАКТУРА ЗА ЕЛЕКТРОЕНЕРГИЯ\nДата на издаване: 12.02.2026\nЗА ПЛАЩАНЕ (с ДДС): 142,50 лв" },
      { document: "Feb/electricity-credit-note-unsigned.txt", text: "СофияЕнерго ЕАД\nКРЕДИТНО ИЗВЕСТИЕ\nДата на издаване: 12.02.2026\nСУМА ЗА ВЪЗСТАНОВЯВАНЕ (с ДДС): 34,20 лв" },
    ], { period: "2026-02" });
    assert.equal(by_currency.BGN.by_category.Utilities.total, 142.5 - 34.2);
  });
});

describe("payment orders", () => {
  const HEATING_PAYMENT = [
    "ПЛАТЕЖНО НАРЕЖДАНЕ / ВНОСНА БЕЛЕЖКА",
    "ПОЛУЧАТЕЛ (Beneficiary)",
    "  Име (Name):                 ТоплоСофия ЕАД",
    "ПЛАЩАНЕ (Payment)",
    "  Сума (Amount):        235,27",
    "  Валута (Currency):          BGN",
    "  Основание (Payment details):Парно 12/2025, аб. № 8800123",
    "  Дата (Date):                04.02.2026",
  ].join("\n");

  test("files a settled charge in its own month, not the payment month", () => {
    const { facts } = factsFromDocument({ document: "February/heating-payment-04-feb.docx", text: HEATING_PAYMENT });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].amount, 235.27);
    assert.equal(facts[0].period, "2026-01");
    // The payment date is still recorded — it is simply not the charge month.
    assert.equal(facts[0].assignment_date, "2026-02-04");
    assert.equal(facts[0].evidence_kind, "payment_order");
    assert.equal(facts[0].merchant, "ТоплоСофия ЕАД");
    assert.equal(facts[0].category, "Utilities");
  });

  test("keeps a payment order that is the sole evidence of its charge", () => {
    // June's internet bill exists only as this completed transfer form.
    const { facts } = factsFromDocument({
      document: "June/internet-payment-12-jun.txt",
      text: [
        "ПЛАТЕЖНО НАРЕЖДАНЕ / ВНОСНА БЕЛЕЖКА",
        "ПОЛУЧАТЕЛ (Beneficiary)",
        "  Име (Name):                 НетЛинк ЕООД",
        "  Сума (Amount):        29,99",
        "  Валута (Currency):          BGN",
        "  Основание (Payment details):Интернет 05/2026, кл. № N-4821",
        "  Дата (Date):                12.06.2026",
      ].join("\n"),
    });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].amount, 29.99);
    assert.equal(facts[0].period, "2026-06");
    assert.equal(facts[0].category, "Internet");
  });

  test("reads a longer padded currency-less amount to the end of its line", () => {
    const { facts } = factsFromDocument({
      document: "June/wide-payment-form.txt",
      text: [
        "ПЛАТЕЖНО НАРЕЖДАНЕ / ВНОСНА БЕЛЕЖКА",
        "ПОЛУЧАТЕЛ (Beneficiary)",
        "  Име (Name):                 ТоплоСофия ЕАД",
        `  Сума (Amount):${" ".repeat(15)}1234,56`,
        "  Валута (Currency):          BGN",
        "  Основание (Payment details):Парно 06/2026",
        "  Дата (Date):                04.07.2026",
      ].join("\n"),
    });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].amount, 1234.56);
    assert.equal(facts[0].currency, "BGN");
  });
});

describe("bounded extraction", () => {
  test("stops at the fact limit and says so", () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      document: `bill-${i}.txt`,
      text: ELECTRICITY_BILL,
    }));
    const { facts, truncated } = factsFromDocuments(docs, { limit: 4 });
    assert.equal(facts.length, 4);
    assert.equal(truncated, true);
  });

  test("bounds a folder that yields no facts at all", () => {
    // Ten thousand scanned images produce zero facts, so a fact-only cap
    // never trips: every document would still be parsed and would still
    // append an exclusion.
    const docs = Array.from({ length: 10_000 }, (_, i) => ({ document: `scan-${i}.png`, text: "" }));
    const { facts, excluded, truncated, truncation } = factsFromDocuments(docs, {
      documentLimit: 50, exclusionLimit: 20,
    });
    assert.equal(facts.length, 0);
    assert.equal(excluded.length, 20);
    assert.equal(truncated, true);
    assert.equal(truncation.exclusions, true);
    assert.equal(truncation.documents_processed, 50);
    assert.equal(truncation.documents_supplied, 10_000);
  });

  test("does not report truncation when everything fits", () => {
    const { truncated, truncation } = factsFromDocuments([{ document: "a.txt", text: ELECTRICITY_BILL }]);
    assert.equal(truncated, false);
    assert.equal(truncation, undefined);
  });

  test("collects exclusions across documents without throwing", () => {
    const { facts, excluded } = factsFromDocuments([
      { document: "a.txt", text: ELECTRICITY_BILL },
      { document: "b.png", text: "" },
      { document: null, text: "ignored" },
    ]);
    assert.equal(facts.length, 1);
    assert.equal(excluded.length, 1);
  });
});

// ─── doc_batch-shaped records ────────────────────────────────────────────────
//
// doc_batch (mcp/tools/docgraph.js → retrieveInBatches) names its records
// rel_path/root_path — never document/root — and attaches the extractor's own
// `dates`/`amounts` candidates plus status/bytes/bookkeeping fields. The
// extractor must treat those as the same document, or the batch handoff hits
// the missing-document early return and every record yields no facts.

describe("facts from doc_batch-shaped records", () => {
  test("extracts a fact from a batch record without requiring `document`", () => {
    // The record carries only the batch's own fields; the extractor re-runs
    // its candidates when none are supplied.
    const { facts } = factsFromDocument({
      rel_path: "June/electricity-bill-03-jun.txt",
      root_path: "/repo/household",
      title: "electricity-bill-03-jun.txt",
      text: ELECTRICITY_BILL,
      status: "read",
    });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].document, "June/electricity-bill-03-jun.txt");
    assert.equal(facts[0].root, "/repo/household");
    assert.equal(facts[0].amount, 142.5);
  });

  test("reuses the batch's pre-extracted amounts and dates", () => {
    // The batch already ran the extractor; supplying its candidates must not
    // re-parse the text, and a terminal amount it found still counts.
    const { facts } = factsFromDocument({
      rel_path: "June/fuel-receipt-09-jun.txt",
      root_path: "/repo/household",
      text: FUEL_RECEIPT,
      status: "read",
      dates: [{ role: "receipt_date", raw: "09.06.2026", value: "2026-06-09", confidence: "high" }],
      amounts: [{ value: 120, currency: "BGN", raw: "120.00 BGN", label: "total" }],
    });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].amount, 120);
    assert.equal(facts[0].assignment_date, "2026-06-09");
  });

  test("factsFromDocuments accepts batch records and keeps root_path", () => {
    const { facts } = factsFromDocuments([
      { rel_path: "June/electricity-bill.txt", root_path: "/repo/household", text: ELECTRICITY_BILL, status: "read" },
      { rel_path: "June/scan.png", root_path: "/repo/household", text: "", status: "read", dates: [], amounts: [] },
    ]);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].root, "/repo/household");
  });

  test("a batch record with no text is coverage loss, not a silent zero", () => {
    const { facts, excluded } = factsFromDocument({
      rel_path: "June/scan.png",
      root_path: "/repo/household",
      text: "",
      status: "read",
      dates: [],
      amounts: [],
    });
    assert.equal(facts.length, 0);
    assert.equal(excluded[0].document, "June/scan.png");
    assert.equal(excluded[0].reason, "no_text");
  });
});
