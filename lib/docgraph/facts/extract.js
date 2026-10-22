// lib/docgraph/facts/extract.js
// Document → facts. The seam between "what the extractor found in the text"
// and "what can be counted".
//
// Two shapes of document produce facts, and they are genuinely different:
//   • a charge document (invoice, receipt, payment order, notice) evidences
//     ONE charge — its terminal total. Its line items are components, not
//     purchases, and summing them double-counts the document against itself.
//   • a statement evidences MANY charges, one per row, and carries no total
//     of its own that belongs in a category.
//
// Everything a document cannot evidence — no terminal amount, no currency, no
// resolvable month — is returned as an explicit exclusion with a reason. The
// caller reports those; it never silently drops them, because a missing 29.99
// internet bill is exactly the failure this pipeline exists to catch.

import { extractAmountCandidates, extractDateCandidates } from "../extract-facts.js";
import { filenameDateHint } from "../retrieval.js";
import {
  FACT_LIMITS, TERMINAL_AMOUNT_LABELS, createFact, classifyCategory,
  detectEvidenceKind, extractBeneficiary, extractLocators, extractMerchant,
  isCommercialDocument, resolveAssignmentDate, settledChargePeriod,
} from "./contract.js";
import { isStatementLike, parseStatementRows } from "./statement.js";
import { toMinor } from "./money.js";

/**
 * Extract every countable fact from one document.
 *
 * Two field-name shapes are accepted, and they are the same document:
 *   • the pipeline's own shape: {document, root?, title?, text, ...}
 *   • a doc_batch record:       {rel_path, root_path?, title?, text, status,
 *                               dates, amounts, ...}
 * doc_batch (mcp/tools/docgraph.js → retrieveInBatches) names its records
 * rel_path/root_path and never document/root, so the extractor must accept
 * those aliases or every batch handoff would hit the missing-document early
 * return and produce no facts.
 *
 * @param {{document?: string, root?: string, rel_path?: string, root_path?: string,
 *          title?: string, text: string,
 *          amounts?: Array<object>, dates?: Array<object>}} doc
 *   `amounts`/`dates` may be supplied when the caller already ran the
 *   extractor (doc_batch does), avoiding a second pass over the text.
 * @returns {{facts: Array<object>, excluded: Array<object>}}
 */
export function factsFromDocument(doc) {
  const {
    rel_path, root_path,
    document = rel_path,
    root = root_path,
    title = null,
    text = "",
  } = doc ?? {};
  if (!document) return { facts: [], excluded: [] };

  if (!text) {
    return { facts: [], excluded: [{ document, reason: "no_text", detail: "no extractable text (image or empty document)" }] };
  }

  // Trade finance is work material, not household spending, whatever its
  // currency or size. Checked before anything else so a EUR 1.27M commercial
  // invoice never reaches the amount picker.
  if (isCommercialDocument(text)) {
    return { facts: [], excluded: [{ document, reason: "commercial_document", detail: "business trade-finance document" }] };
  }

  if (isStatementLike(text)) return statementFacts({ document, root, title, text });

  return chargeFacts({
    document, root, title, text,
    amounts: doc.amounts ?? extractAmountCandidates(text),
    dates: doc.dates ?? extractDateCandidates(text),
  });
}

/**
 * Many documents in one call, bounded on every axis that can grow.
 *
 * A fact cap alone does not bound the work: a folder of ten thousand scanned
 * images or blank templates produces no facts at all, so a fact-only limit
 * never trips while every document still parses and appends an exclusion.
 * Documents processed and exclusions retained are therefore capped
 * independently, and exceeding any cap is reported rather than hidden —
 * a truncated answer that looks complete is the failure mode this whole
 * pipeline exists to prevent.
 *
 * @returns {{facts, excluded, truncated: boolean, truncation?: object}}
 */
export function factsFromDocuments(docs, {
  limit = FACT_LIMITS.maxFactsTotal,
  documentLimit = FACT_LIMITS.maxDocuments,
  exclusionLimit = FACT_LIMITS.maxExclusions,
} = {}) {
  const facts = [];
  const excluded = [];
  const list = docs ?? [];
  const truncation = { facts: false, documents: false, exclusions: false };
  let documentsProcessed = 0;

  for (const doc of list) {
    if (facts.length >= limit) { truncation.facts = true; break; }
    if (documentsProcessed >= documentLimit) { truncation.documents = true; break; }
    documentsProcessed++;

    const result = factsFromDocument(doc);
    for (const fact of result.facts) {
      if (facts.length >= limit) { truncation.facts = true; break; }
      facts.push(fact);
    }
    for (const exclusion of result.excluded) {
      // Exclusions are diagnostics, not results: past the cap they are
      // counted rather than retained, so the reason list cannot itself
      // become the unbounded array.
      if (excluded.length >= exclusionLimit) { truncation.exclusions = true; break; }
      excluded.push(exclusion);
    }
  }

  const truncated = truncation.facts || truncation.documents || truncation.exclusions;
  return {
    facts, excluded, truncated,
    ...(truncated ? { truncation: { ...truncation, documents_processed: documentsProcessed, documents_supplied: list.length } } : {}),
  };
}

// ─── Statements ──────────────────────────────────────────────────────────

function statementFacts({ document, root, title, text }) {
  const facts = [];
  const excluded = [];
  const { rows } = parseStatementRows(text, { limit: FACT_LIMITS.maxFactsPerDocument });
  const merchantOfStatement = extractMerchant(text);

  for (const [index, row] of rows.entries()) {
    // A positive row is money arriving — salary, refund, transfer in. It is
    // not spending and must never be added to a category total.
    if (row.amount > 0) {
      excluded.push({
        document, locator: `row:${index + 1}`, reason: "incoming_credit",
        detail: `${row.date} ${row.description} +${row.amount}`,
      });
      continue;
    }

    const category = row.category
      ?? classifyCategory({ relPath: document, title, merchant: row.description, description: row.description }).category;

    const { fact, issue } = createFact({
      document, root, locator: `row:${index + 1}`,
      // Debits are written negative; spending is stated positive so category
      // totals read as amounts spent. A credit note in a charge document
      // keeps its negative sign (see chargeFacts) — that asymmetry is
      // deliberate: there the sign is the document's own claim.
      amount: Math.abs(row.amount),
      currency: row.currency,
      label: "statement_debit",
      assignmentDate: row.date,
      dates: { transaction: row.date },
      category,
      merchant: row.description || merchantOfStatement,
      description: row.description,
      evidenceKind: "statement_row",
      // A posted debit is money that has left the account.
      paymentStatus: "paid",
      confidence: "high",
    });

    if (fact) facts.push(fact);
    else excluded.push({ ...issue, locator: `row:${index + 1}` });
  }

  return { facts, excluded };
}

// ─── Charge documents ────────────────────────────────────────────────────

function chargeFacts({ document, root, title, text, amounts, dates }) {
  const excluded = [];

  const picked = pickTerminalAmount(amounts);
  if (picked.issue) return { facts: [], excluded: [{ document, ...picked.issue }] };

  const filenameHint = filenameDateHint({ rel_path: document, title });
  const assignment = resolveAssignmentDate(dates, { filenameHint });
  const evidenceKind = detectEvidenceKind(text);

  // A payment order's own header is the form title ("ПЛАТЕЖНО НАРЕЖДАНЕ"),
  // not a provider — the provider is in its beneficiary block, and it is what
  // any duplicate match against the settled invoice needs.
  const merchant = (evidenceKind === "payment_order" ? extractBeneficiary(text) : null) ?? extractMerchant(text);
  const locators = extractLocators(text);
  const { category } = classifyCategory({ relPath: document, title, merchant, text });

  // A payment order evidences a charge that already existed; it must not
  // create a new one in the month the payment cleared.
  const settledPeriod = evidenceKind === "payment_order" && !dateRoleValue(dates, "invoice_date")
    ? settledChargePeriod(text, assignment.date)
    : null;

  const { fact, issue } = createFact({
    document, root,
    amount: picked.amount.value,
    currency: picked.amount.currency,
    label: picked.amount.label,
    assignmentDate: assignment.date,
    period: settledPeriod ?? (assignment.date ? null : (assignment.period ?? null)),
    dates: rolesOf(dates),
    category,
    merchant,
    description: picked.amount.description ?? null,
    evidenceKind,
    paymentStatus: paymentStatusOf({ amounts, picked: picked.amount, evidenceKind }),
    locators,
    confidence: assignment.confidence,
  });

  if (!fact) {
    excluded.push({ ...issue, detail: issue.detail ?? assignment.issue });
    return { facts: [], excluded };
  }
  return { facts: [fact], excluded };
}

/**
 * The one amount that represents what this document charges.
 *
 * `amount_due` beats `total` beats `grand_total`: a partly paid invoice
 * showing grand_total 100 and amount_due 20 charges 20. Two DIFFERENT values
 * under the winning label mean the document evidences more than one charge —
 * reported as ambiguous rather than resolved by picking one.
 */
function pickTerminalAmount(amounts) {
  const list = Array.isArray(amounts) ? amounts : [];
  for (const label of TERMINAL_AMOUNT_LABELS) {
    const matches = list.filter(a => a.label === label && a.value != null);
    if (!matches.length) continue;

    const distinct = new Map(matches.map(a => [`${toMinor(a.value, a.currency)}|${a.currency}`, a]));
    if (distinct.size > 1) {
      return { issue: { reason: "ambiguous_total", detail: `${distinct.size} distinct ${label} values in one document` } };
    }
    return { amount: distinct.values().next().value };
  }
  return { issue: { reason: "no_terminal_amount", detail: "no amount_due / total / grand_total found" } };
}

/** Whether the document proves payment or only that money is owed. A
 *  negative terminal amount is a credit note, which is neither. */
function paymentStatusOf({ amounts, picked, evidenceKind }) {
  if (picked.value < 0) return "credit_documented";
  const paidMatch = (amounts ?? []).some(
    a => a.label === "paid" && toMinor(a.value, a.currency) === toMinor(picked.value, picked.currency));
  if (paidMatch) return "paid";
  if (evidenceKind === "receipt" || evidenceKind === "payment_order") return "paid";
  return "amount_due_documented";
}

/** The value of one high-confidence date role, or null. */
function dateRoleValue(dates, role) {
  return (Array.isArray(dates) ? dates : []).find(d => d?.role === role && d.value)?.value ?? null;
}

/** Collapse the extractor's date list into the roles a fact carries. */
function rolesOf(dates) {
  const out = {};
  for (const d of Array.isArray(dates) ? dates : []) {
    if (!d?.value || !d.role || d.role === "unlabeled_date") continue;
    if (out[d.role] == null) out[d.role] = d.value;
  }
  return out;
}
