// The T-R5 acceptance gate, run deterministically: no model, no server, no
// network. Given June's documents, application code alone must produce
// Utilities 260.50, Fuel 215.60, Groceries 140.75, Transport 50.00,
// Internet 29.99, BGN total 696.84, with EUR 196.40 reported separately.
//
// Two tests, deliberately:
//   • a hermetic composition test that runs everywhere, proving the pipeline
//     wires together and honours the traps;
//   • the real-corpus gate, which reads the household corpus when it is
//     present on this machine and skips otherwise. The corpus lives outside
//     the repository by design (it is model-readable; the oracle is not), so
//     CI cannot depend on it — but the number it produces is the one the
//     epic is graded on.
//
// The oracle is read in-process from the repo fixture and never copied into
// the corpus, per its own fence.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { aggregateDocuments } from "../../../../lib/docgraph/facts/index.js";

const ORACLE_PATH = "tests/fixtures/household-gen/ground-truth.json";
const CORPUS_ROOT = process.env.APERIO_HOUSEHOLD_CORPUS ?? "/Users/lk/Projects/household";
const PERIOD = "2026-06";

describe("deterministic aggregation composes end to end", () => {
  // A miniature of the June corpus: a partial statement, the receipt that
  // duplicates one of its rows, a receipt that appears nowhere else, a bill
  // whose service period is the previous month, a foreign-currency ticket,
  // an informational notice and a trade document.
  const documents = [
    {
      document: "bank-statement.txt",
      text: [
        "FIRST DIGITAL BANK", "Account Statement", "Currency:         BGN",
        "Opening balance:  4 250.00 BGN",
        " Date        Description                    Category     Amount (BGN)",
        " 07.06.2026  FreshMarket #218 groceries      Groceries          -87.45",
        " 09.06.2026  PetrolMax fuel station         Fuel              -120.00",
      ].join("\n"),
    },
    {
      document: "fuel-receipt-09.txt",
      text: "P E T R O L M A X\nFuel Station #17\nFISCAL RECEIPT\nDate: 09.06.2026\nReceipt No: 0417-000239\nTOTAL       120.00 BGN",
    },
    {
      document: "fuel-receipt-25.txt",
      text: "P E T R O L M A X\nFuel Station #22\nFISCAL RECEIPT\nDate: 25.06.2026\nReceipt No: 0422-000817\nTOTAL        95.60 BGN",
    },
    {
      document: "electricity-bill.txt",
      text: "СофияЕнерго ЕАД\nФАКТУРА ЗА ЕЛЕКТРОЕНЕРГИЯ\nФактура №: 0000451287\nДата на издаване: 03.06.2026\nПериод на отчитане: 01.05.2026 – 31.05.2026\nЗА ПЛАЩАНЕ (с ДДС): 142,50 лв",
    },
    {
      document: "train-ticket.txt",
      text: "BahnReise AG\nFahrkarte Berlin – München\n14.06.2026\nGesamtbetrag: 49,90 EUR",
    },
    {
      document: "tax-notice.txt",
      text: "СЪОБЩЕНИЕ\nУвеличение от 7,40 лв. считано от 01.07.2026\nНова цена: 107,40 лв.",
    },
    {
      document: "commercial-invoice.txt",
      text: "COMMERCIAL INVOICE\nInvoice Date: 2026-06-25\nIncoterms: CIF Göteborg\nTOTAL: EUR 1 266 250,00",
    },
  ];

  const result = aggregateDocuments(documents, { period: PERIOD, baseCurrency: "BGN" });

  test("counts the shared fuel purchase once and finds the receipt-only one", () => {
    assert.equal(result.by_currency.BGN.by_category.Fuel.total, 215.6);
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0].kept.document, "fuel-receipt-09.txt");
  });

  test("recovers groceries that exist only as a statement row", () => {
    assert.equal(result.by_currency.BGN.by_category.Groceries.total, 87.45);
  });

  test("files a bill by its issue date, not the month it bills for", () => {
    assert.equal(result.by_currency.BGN.by_category.Utilities.total, 142.5);
  });

  test("keeps the foreign fare out of the BGN total and invents no rate", () => {
    assert.equal(result.by_currency.EUR.total, 49.9);
    assert.equal(result.by_currency.BGN.total, 445.55);
  });

  test("excludes the notice and the trade document, each with a reason", () => {
    const reasons = Object.fromEntries(result.excluded.map(e => [e.document, e.reason]));
    assert.equal(reasons["tax-notice.txt"], "no_terminal_amount");
    assert.equal(reasons["commercial-invoice.txt"], "commercial_document");
  });
});

// ─── The real corpus ─────────────────────────────────────────────────────

const corpusPresent = existsSync(join(CORPUS_ROOT, "2026", "June"));

describe("T-R5 gate against the household corpus", { skip: corpusPresent ? false : `corpus not present at ${CORPUS_ROOT}` }, () => {
  test("reproduces every June figure the oracle declares", async () => {
    const oracle = JSON.parse(readFileSync(ORACLE_PATH, "utf8"));
    const expected = oracle.periods[PERIOD];

    // The T-R5 fixture set: June, plus the two distractor folders. Not the
    // whole corpus — a fixture set that grows with the corpus is not a
    // controlled input.
    const documents = await loadDocuments([
      join(CORPUS_ROOT, "2026", "June"),
      join(CORPUS_ROOT, "trade-docs"),
      join(CORPUS_ROOT, "templates"),
    ]);

    const result = aggregateDocuments(documents, { period: PERIOD, baseCurrency: "BGN" });

    const categories = Object.fromEntries(
      Object.entries(result.by_currency.BGN.by_category).map(([name, entry]) => [name, entry.total]));
    assert.deepEqual(categories, expected.category_totals_bgn);
    assert.equal(result.by_currency.BGN.total, expected.monthly_total_bgn);

    // Travel is reported in its own currency, never converted, never merged.
    assert.equal(result.by_currency.EUR.total, expected.other_currency_totals.EUR.total);

    // The statement shortcut (260.75) and the double-counted fuel (240.00)
    // are the two recorded failure signatures; neither may appear.
    assert.notEqual(result.by_currency.BGN.total, expected.bank_statement.total_debits_bgn);
    assert.notEqual(result.by_currency.BGN.by_category.Fuel.total, 240);

    // Every trade document is excluded by policy, not by accident.
    const excludedFor = Object.fromEntries(result.excluded.map(e => [e.document, e.reason]));
    for (const document of Object.keys(excludedFor)) {
      if (document.includes("trade-docs")) assert.equal(excludedFor[document], "commercial_document");
    }
  });

  test("reproduces all nine periods from the whole corpus at once", async () => {
    // The realistic case: every month loaded together, so a payment order and
    // the invoice it settles are both present, an invoice resent three times
    // is seen three times, and a question about one month must not pick up
    // charges from its neighbours.
    const oracle = JSON.parse(readFileSync(ORACLE_PATH, "utf8"));
    const documents = await loadDocuments([
      ...["2025", "2026"].flatMap(year => monthFolders(join(CORPUS_ROOT, year))),
      join(CORPUS_ROOT, "trade-docs"),
      join(CORPUS_ROOT, "templates"),
    ]);
    assert.ok(documents.length > 150, `expected the full corpus, loaded ${documents.length}`);

    for (const [period, expected] of Object.entries(oracle.periods)) {
      const result = aggregateDocuments(documents, { period, baseCurrency: "BGN" });
      const categories = Object.fromEntries(
        Object.entries(result.by_currency.BGN.by_category).map(([name, entry]) => [name, entry.total]));
      assert.deepEqual(categories, expected.category_totals_bgn, `category totals for ${period}`);
      assert.equal(result.by_currency.BGN.total, expected.monthly_total_bgn, `monthly total for ${period}`);
    }
  });
});

/** Month folders under a year directory, in name order. */
function monthFolders(yearDir) {
  if (!existsSync(yearDir)) return [];
  return readdirSync(yearDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(yearDir, entry.name))
    .sort();
}

/** Read a folder into `{document, title, text}` records using the same
 *  format extractors docgraph indexes with. Images yield no text and are
 *  reported as coverage loss rather than silently skipped. */
async function loadDocuments(dirs) {
  const extractors = {
    ".pdf": await import("../../../../lib/docgraph/extract-pdf.js"),
    ".html": await import("../../../../lib/docgraph/extract-html.js"),
    ".eml": await import("../../../../lib/docgraph/extract-eml.js"),
    ".docx": await import("../../../../lib/docgraph/extract-docx.js"),
    ".xlsx": await import("../../../../lib/docgraph/extract-xlsx.js"),
  };

  const documents = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const ext = extname(name).toLowerCase();
      const abs = join(dir, name);
      const rel = `${dir.split("/").pop()}/${name}`;
      let text = "";
      try {
        if (ext === ".txt") text = readFileSync(abs, "utf8");
        else if (extractors[ext]) {
          const parsed = await extractors[ext].extract(readFileSync(abs), rel);
          text = typeof parsed === "string"
            ? parsed
            : [parsed?.title, ...(parsed?.sections ?? []).map(s => s.text)].filter(Boolean).join("\n");
        }
      } catch { text = ""; }
      documents.push({ document: rel, title: name, text });
    }
  }
  return documents;
}
