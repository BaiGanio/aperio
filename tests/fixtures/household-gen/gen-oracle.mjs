// Emits ground-truth.json (schema_version 3) from the same build model that
// produced the documents.
//
//   node tests/fixtures/household-gen/gen-oracle.mjs
//
// The oracle is written to the REPO, never into the corpus: the corpus is a
// model-readable location, and an oracle sitting inside it would hand away the
// answer key. There is exactly one authoritative oracle path and this script
// owns it.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCorpus } from "./build.mjs";
import { categories, trips, months } from "./spec.mjs";

const ORACLE = resolve(import.meta.dirname, "ground-truth.json");
const bgn = minorUnits => Number((minorUnits / 100).toFixed(2));

/** "142.50 + 64.80 + (-34.20) = 260.50" — auditable in the oracle itself. */
function equation(amounts, total) {
  const terms = amounts.map(amount => amount < 0 ? `(${bgn(amount).toFixed(2)})` : bgn(amount).toFixed(2));
  return `${terms.join(" + ")} = ${bgn(total).toFixed(2)}`;
}

const { artifacts, events, periods } = buildCorpus();

const periodsOut = {};
for (const [period, data] of Object.entries(periods)) {
  const categoryTotals = {};
  const reconciliation = {};
  for (const [category, total] of Object.entries(data.categoryTotals).sort()) {
    categoryTotals[category] = bgn(total);
    const contributing = data.events
      .filter(event => event.category === category && event.currency === "BGN" && !event.excluded_from_bgn_total)
      .sort((left, right) => left.transaction_date.localeCompare(right.transaction_date));
    reconciliation[category] = equation(contributing.map(event => event.amount), total);
  }
  reconciliation.monthly_total = equation(
    Object.values(data.categoryTotals).map(total => total),
    data.monthlyTotal,
  ).replace(/ = /, " = ");

  const otherCurrency = {};
  for (const [currency, total] of Object.entries(data.otherCurrency)) {
    const contributing = data.events.filter(event => event.currency === currency);
    otherCurrency[currency] = {
      total: bgn(total),
      documents: contributing.length,
      note: "reported in its own currency; never converted into BGN and never added to the BGN total",
      items: contributing.map(event => ({
        document: event.primary_document,
        merchant: event.merchant_or_provider,
        date: event.transaction_date,
        amount: bgn(event.amount),
        language: event.language ?? null,
      })),
    };
  }

  periodsOut[period] = {
    label: new Date(`${period}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
    unit: "BGN",
    frozen: period === "2026-06" || undefined,
    category_totals_bgn: categoryTotals,
    monthly_total_bgn: bgn(data.monthlyTotal),
    reconciliation,
    other_currency_totals: otherCurrency,
    bank_statement: data.statement,
    included_events: data.events
      .filter(event => event.currency === "BGN" && !event.excluded_from_bgn_total)
      .map(event => ({
        id: event.id,
        category: event.category,
        amount_bgn: bgn(event.amount),
        currency: "BGN",
        transaction_date: event.transaction_date,
        document_date: event.document_date,
        due_date: event.due_date ?? null,
        service_period: event.service_period ?? null,
        merchant_or_provider: event.merchant_or_provider,
        evidence_kind: event.evidence_kind,
        payment_status: event.payment_status,
        primary_document: event.primary_document,
        source_documents: event.source_documents,
        source_locators: event.source_locators,
        on_bank_statement: event.on_bank_statement ?? null,
        deduplication_group: event.deduplication_group ?? null,
        classification_reason: event.classification_reason,
        verification_status: event.verification_status,
        ...(event.amortised_monthly_bgn ? { amortised_monthly_bgn: event.amortised_monthly_bgn } : {}),
      })),
    excluded_events: data.events
      .filter(event => event.excluded_from_bgn_total)
      .map(event => ({
        id: event.id,
        category: event.category,
        amount: bgn(event.amount),
        currency: event.currency,
        date: event.transaction_date,
        merchant_or_provider: event.merchant_or_provider,
        document: event.primary_document,
        language: event.language ?? null,
        reason: event.classification_reason,
      })),
    deduplication_groups: data.groups.map(group => ({
      id: group.id,
      kind: group.kind,
      canonical_event: group.canonical_event,
      count_once_bgn: group.count_once_bgn ?? null,
      records: group.records,
      match_basis: group.match_basis,
      role: group.role,
      verification_status: group.verification_status ?? "verified",
    })),
  };
}

const totalsByYear = {};
for (const [period, data] of Object.entries(periods)) {
  const year = period.slice(0, 4);
  totalsByYear[year] = bgn(((totalsByYear[year] ?? 0) * 100) + data.monthlyTotal);
}

const dispositions = artifacts
  .map(artifact => ({
    document: artifact.relPath,
    period: artifact.period ?? null,
    disposition: artifact.disposition,
    role: artifact.role,
    event: artifact.eventId,
    duplicates_document: artifact.duplicatesDocument ?? undefined,
    format: artifact.format,
    language: artifact.language,
    docgraph_indexable: artifact.indexable,
    hand_authored: artifact.frozen || undefined,
    locators: Object.keys(artifact.locators).length ? artifact.locators : undefined,
    reason: artifact.reason,
  }))
  .sort((left, right) => left.document.localeCompare(right.document));

const oracle = {
  schema_version: 3,
  generator: "tests/fixtures/household-gen/gen-oracle.mjs",
  description:
    "Ground truth for the fictional household corpus at /Users/lk/Projects/household, covering nine consecutive periods (2025-11 … 2026-07). Derived mechanically from the same specification that renders the documents, so a document and the oracle row claiming it cannot drift apart. June 2026 is a FROZEN slice: its documents were hand-authored before this generator existed, its figures are declared rather than computed, and its expected values (Utilities 260.50, Fuel 215.60, Groceries 140.75, Transport 50.00, Internet 29.99, total 696.84 BGN) are unchanged so that T-R5 results stay comparable with the recorded runs.",
  authoritative_oracle_path: "tests/fixtures/household-gen/ground-truth.json",
  oracle_fence:
    "This file must never be copied into a workspace, allowlist or index the model can read. The harness reads it in-process only. There is exactly one authoritative copy — the path above. Earlier drafts also expected an oracle at /Users/lk/Projects/household/ground-truth.json; that second source of truth is retired and must not be recreated, because the household folder is model-readable.",

  policy: {
    total_label:
      "Documented in-scope BGN household charges and payments evidenced by the period's records. NOT a claim that these documents capture the household's complete spending: the bank statements are partial by design.",
    period_assignment:
      "A charge belongs to the month of its own issue/due date, NOT to the consumption period it bills. Every utility bill in this corpus bills the PREVIOUS month's consumption, so a pass keyed on the consumption period slides every utility total one month backwards. The corpus tests this deliberately: 2026/July holds electricity and water bills for JUNE consumption, and 2026/February holds a payment order settling JANUARY's heating charge.",
    payment_document_assignment:
      "A payment order evidences the charge it settles; it is a duplicate representation of that charge, not a second event, and it does NOT move the charge into the month the payment was made. 2026/February/heating-payment-04-feb.docx is filed under February but belongs to the 2026-01 heating event.",
    payment_semantics:
      "Invoices and notices prove an amount DUE, not a completed payment; receipts and completed payment orders prove payment. Each event carries payment_status (amount_due_documented | paid | credit_documented) so the two are never silently equated. The declared totals count documented in-scope charges and payments alike — the benchmark measures document understanding, not settlement status.",
    signed_amounts:
      "Credit notes carry NEGATIVE amounts and reduce their category. 2026-02 contains a -34.20 BGN electricity credit note: reading it as a positive charge overstates Utilities by 68.40 BGN, and dropping it overstates by 34.20.",
    annual_items:
      "An annual charge falls wholly in its issue month (2026-01 insurance, 240.00 BGN). The amortised reading (20.00 BGN/month) is reported on the event as amortised_monthly_bgn and must never be mixed into a monthly total.",
    currency:
      "Per-currency totals only. No FX conversion anywhere, and no blended figure. BGN household spending, EUR/GBP/USD/CNY travel and the one EUR online order are reported separately.",
    deduplication:
      "Equal amounts NEVER establish duplication. Records collapse into one event only when a stable shared identifier (invoice number, receipt number, policy number) or a sufficiently specific identity tuple — merchant/provider, transaction date, amount and currency, account/card evidence, and document role — supports the conclusion that they describe the same economic event. Where no shared transaction identifier exists (receipt vs bank-statement row), the match is recorded as an ADJUDICATED benchmark duplicate with its evidence and its uncertainty, not as a joined identity.",
    taxonomy_status:
      "The category set is benchmark policy, not universal accounting truth. Utilities folds in the municipal waste fee; Internet is kept out of Utilities; Mobile, Health, Dining, Shopping, Vehicle and Insurance are separate. A different-but-defensible taxonomy would produce different category totals from the same documents.",
    travel_exclusion:
      "Travel is excluded from the BGN total by DECLARED BENCHMARK POLICY, not because travel stops being spending. Under the ordinary reading of 'total spending this month', travel is spending. The policy exists so the BGN gate stays currency-pure; travel is reported in full under other_currency_totals.",
    commercial_exclusion:
      "B2B trade-finance documents under trade-docs/ are work material, not household spending, regardless of currency.",
    categories,
  },

  corpus_design: {
    provenance:
      "Anti-shortcut design, first applied 2026-07-20 after a baseline probe proved the corpus could be solved without extraction, and extended 2026-07-26 when the corpus grew from one month to nine. Do not undo any of it without reading the reasoning below.",
    original_problem:
      "The June bank statement once carried the full ten-row ledger AND a precomputed category-totals footer, so 'what did I pay last month, by category?' could be answered by copying one table. A probe proved it: it reported Groceries 140.75 while both grocery scans were absent from the workspace. No extraction was exercised, yet the totals matched.",
    partial_statement:
      "Every statement in the corpus is partial. June's is limited to three card-payment rows. The other months alternate between an INTERIM extract (card payments up to the 20th only) and a full-month statement that still omits counter, transfer, cash and foreign-currency payments. A model that trusts any statement as complete is wrong in every month, for a reason the statement itself states.",
    near_collision_trap:
      "June's statement total debits (260.75) sit 0.25 BGN from the true Utilities total (260.50) BY DESIGN. A shortcut to the statement produces an answer that looks almost right. When diagnosing a failure, 260.75 means 'read only the statement'.",
    missing_row_trap:
      "June's Internet 29.99 exists ONLY in a completed payment form, not an obvious 'bill'. A documented baseline probe missed it and reported 666.85 instead of 696.84.",
    partial_overlap_trap:
      "June's fuel is split: the 09.06 payment (120.00) appears on the statement AND as a receipt, while the 25.06 payment (95.60) is receipt-only. A correct answer must neither double-count the first (240.00 is the failure signature) nor miss the second. The same merchant and the same card suffix on both receipts is the point: merchant+card overlap is not identity.",
    scan_parity:
      "Groceries stay on the statement, so the .png scans are a scan-vs-text parity check rather than a hard dependency. PNG is NOT docgraph-indexable, so a scan is reachable only through the vision path — 'the model never read it' and 'retrieval could not have surfaced it' are different failures and the dispositions distinguish them.",
    negative_amount_trap:
      "2026-02 carries a -34.20 BGN electricity credit note. Signed arithmetic is the test; most extraction paths drop the sign.",
    cross_month_payment_trap:
      "January's heating charge (235.27) is settled by a payment order dated 2026-02-04 and FILED under 2026/February. Assigning it to February both inflates February and empties January.",
    duplicate_resend_trap:
      "March's electricity invoice arrives three times: the .txt bill, an .html e-invoice, and an .eml reminder resend — all carrying invoice 0000424684. Three representations, one charge.",
    annual_premium_trap:
      "2026-01's insurance premium (240.00) covers 2026-02-01 … 2027-01-31. Both a whole-month reading and a 20.00/month amortised reading are defensible, so the oracle states which one it uses and records the other.",
    foreign_currency_traps:
      "Travel spans seven destinations in seven languages and four currencies (GBP, EUR, USD, CNY), plus one German EUR online order settled from a EUR wallet so it never touches the BGN statement. Nothing is convertible; a blended total is always wrong. Finnish, Spanish and Chinese documents deliberately fall outside extract-facts.js's modelled amount labels (EN/BG/DE/FR), exercising the language-agnostic likely_total fallback.",
    planned_budget_distractor:
      "Every month carries a PLANNED budget .xlsx whose figures deliberately differ from actuals. A model that reports the sheet's total is reporting an intention, not a fact — this is the answer-key shortcut in its most tempting form.",
    informational_distractors:
      "Regulatory tariff-change notices (+4.8% effective 2026-01-01, +7.4% effective 2026-07-01) announce future prices and are not transactions. The tariff steps are real in the corpus: bills issued after each date use the higher rates, so a bill's arithmetic can be re-checked against its own issue date.",
    commercial_distractor:
      "trade-docs/ holds a ~EUR 1.27M steel/freight commercial invoice and its SWIFT MT700. A recorded T-R5.2 run ranked it inside the retrieval cap and reported it as a household spending category — a worse false positive than the travel leak that tier was designed to catch. The fixture is kept precisely because it caught something.",
  },

  fixture_sets: {
    "T-R5": {
      description:
        "The controlled input set for the T-R5 gate: June 2026 plus the shared templates and the B2B distractor. Deliberately NOT the whole household folder — a fixture set that grows whenever the corpus grows is not a controlled input, and the eight other months would silently change what T-R5 measures.",
      target_period: "2026-06",
      primary_paths: ["2026/June", "templates", "trade-docs"],
      secondary_paths: ["2026/June/tax-increase-notice-bg-30-jun.txt"],
      expected: {
        category_totals_bgn: periodsOut["2026-06"].category_totals_bgn,
        monthly_total_bgn: periodsOut["2026-06"].monthly_total_bgn,
      },
      prompt_anchor:
        "The prompt must name June 2026 explicitly, or the evaluation clock must be frozen to June. The harness runs in late July 2026 against a corpus that now contains July records, so under ordinary time semantics 'this month' means July — the earlier bare 'this month' prompt was asking a question the oracle did not answer.",
    },
    "multi-month": {
      description:
        "The full nine-period corpus, for the temporal tiers that T-R5 does not cover: trailing-window totals, month-over-month comparison, seasonality, and the year boundary.",
      target_period: null,
      primary_paths: ["2025", "2026", "templates", "trade-docs"],
      secondary_paths: [],
      expected: { totals_by_year_bgn: totalsByYear, monthly_totals_bgn: Object.fromEntries(Object.entries(periodsOut).map(([period, data]) => [period, data.monthly_total_bgn])) },
    },
  },

  periods: periodsOut,
  totals_by_year_bgn: totalsByYear,

  travel: {
    note: "Seven destinations, seven languages, four currencies. Every document is excluded from the BGN totals by declared policy and reported in its own currency.",
    trips: Object.fromEntries(Object.entries(trips).map(([id, trip]) => [id, {
      place: trip.place, country: trip.country, language: trip.language, currency: trip.currency,
      period: months.find(month => month.trip === id)?.period ?? null,
      documents: trip.docs.length,
      total: trip.docs.reduce((sum, doc) => sum + doc.amount, 0) / 100,
      kinds: [...new Set(trip.docs.map(doc => doc.kind))],
    }])),
    frozen_june_2026: {
      place: "Berlin / Munich / Paris", languages: ["de-DE", "fr-FR"], currency: "EUR",
      documents: 3, total: 196.4, kinds: ["train", "hotel", "airport"],
    },
  },

  dispositions,

  known_extractor_gaps: [
    {
      finding:
        "lib/docgraph/extract-facts.js drops the SIGN of a negative amount: 2026/February/electricity-credit-note-10-feb.txt yields 34.20 under likely_total instead of -34.20, and no label is recognised for 'СУМА ЗА ВЪЗСТАНОВЯВАНЕ' (credit/refund).",
      found: "2026-07-26, by running extractAmountCandidates over the newly generated months",
      effect: "Any aggregation built on those candidates will overstate 2026-02 Utilities by 68.40 BGN (34.20 counted positive instead of negative).",
      status: "reported, NOT fixed here — extract-facts.js carries uncommitted changes from another session",
    },
  ],

  verification: {
    arithmetic: "All figures computed in integer стотинки; validate-oracle.mjs re-derives every category total, every monthly total and every bill's own net/VAT/total from the specification and compares in integer minor units.",
    corpus_coverage: "validate-oracle.mjs asserts that every file present in the corpus has exactly one disposition, and that every disposition points at a file that exists.",
    frozen_slice: "The frozen June figures and the frozen July bills are asserted to appear verbatim in their own documents, so a hand-edit to those files fails validation instead of silently diverging from the oracle.",
    gate_direction: "harness-gate.test.mjs mutates a correct answer six ways — omitted source, doubled fuel, wrong-category total, leaked travel, leaked B2B, out-of-period July record — and asserts the gate fails for the correct reason each time.",
  },
};

await writeFile(ORACLE, `${JSON.stringify(oracle, null, 2)}\n`);

console.log(`wrote ${ORACLE}`);
console.log(`  periods: ${Object.keys(periodsOut).length}`);
console.log(`  events: ${events.length} (${Object.values(periodsOut).reduce((sum, period) => sum + period.included_events.length, 0)} BGN-included, ${Object.values(periodsOut).reduce((sum, period) => sum + period.excluded_events.length, 0)} excluded)`);
console.log(`  dedup groups: ${Object.values(periodsOut).reduce((sum, period) => sum + period.deduplication_groups.length, 0)}`);
console.log(`  dispositions: ${dispositions.length}`);
console.log(`  June 2026 gate: ${JSON.stringify(periodsOut["2026-06"].category_totals_bgn)} total ${periodsOut["2026-06"].monthly_total_bgn}`);
