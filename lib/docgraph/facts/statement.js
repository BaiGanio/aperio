// lib/docgraph/facts/statement.js
// Bank-statement row parsing.
//
// A statement is the one document type whose amounts are NOT a single total:
// it is a table of transactions, each of which is its own charge. The generic
// amount extractor sees only the opening and closing balances, so a statement
// contributes nothing to a monthly total unless its rows are parsed — and in
// the June corpus that is where both grocery purchases live (the receipts
// themselves are images) and where the fuel purchase that must NOT be counted
// twice appears alongside its receipt.
//
// Rows are also the only place a currency is stated once for many amounts,
// so the header is read for the statement's currency before any row is built.

import { categoryByName } from "./contract.js";

/** A statement row: a date, a description, and an amount in the trailing
 *  column. Middle columns (category, reference, balance-after) vary by bank,
 *  so everything between the description and the amount is captured and
 *  split on column gaps afterwards rather than positionally. */
const ROW_RE = new RegExp(
  "^\\s*(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4})" + // date
  "\\s+(\\S.*?)" +                                                   // description + any middle columns
  "\\s{2,}(-?\\s?[\\d\\u00a0 ']*\\d[.,]\\d{2})" +                    // signed amount, thousands-separated
  "\\s*([A-Z]{3})?\\s*$",                                            // optional per-row currency
);

const HEADER_CURRENCY_RE = /(?:currency|валута)\s*:?\s*([A-Z]{3})\b/i;
const COLUMN_CURRENCY_RE = /(?:amount|сума|оборот)\s*\(([A-Z]{3})\)/i;

const STATEMENT_SIGNALS = [
  /account statement/i, /bank statement/i, /банково извлечение/i, /извлечение по сметка/i,
  /statement period/i, /период на извлечението/i,
  /opening balance/i, /closing balance/i, /начално салдо/i, /крайно салдо/i,
];

/** Minimum rows before a document is treated as a transaction table. One
 *  matching line is far more likely to be a coincidence in prose than a
 *  statement. */
const MIN_ROWS = 2;

/**
 * Is this document a transaction table whose rows are the charges?
 * Requires both a statement-shaped header and at least two parsable rows —
 * either signal alone produces false positives on invoices with line items.
 */
export function isStatementLike(text) {
  if (!text) return false;
  const head = String(text).slice(0, 1500);
  if (!STATEMENT_SIGNALS.some(re => re.test(head))) return false;
  return parseStatementRows(text).rows.length >= MIN_ROWS;
}

/** The currency every row is denominated in, from the header or the amount
 *  column caption. Returns null when the statement never says. */
export function statementCurrency(text) {
  const head = String(text ?? "").slice(0, 2000);
  return (head.match(HEADER_CURRENCY_RE)?.[1] ?? head.match(COLUMN_CURRENCY_RE)?.[1] ?? null)?.toUpperCase() ?? null;
}

/**
 * Parse transaction rows.
 *
 * Debits print negative in every statement this targets; the sign is
 * preserved exactly as written and interpreted by the caller, because a
 * positive row is an incoming credit and must never be added to spending.
 *
 * @param {string} text
 * @param {{limit?: number}} [opts]
 * @returns {{rows: Array<object>, currency: string|null, skipped: number}}
 */
export function parseStatementRows(text, { limit = 500 } = {}) {
  const rows = [];
  let skipped = 0;
  if (!text) return { rows, currency: null, skipped };

  const currency = statementCurrency(text);
  const lines = String(text).split(/\r?\n/);

  for (const line of lines) {
    if (rows.length >= limit) { skipped++; continue; }
    const m = ROW_RE.exec(line);
    if (!m) continue;

    const date = parseRowDate(m[1]);
    if (!date) { skipped++; continue; }

    const amount = parseRowAmount(m[3]);
    if (amount == null) { skipped++; continue; }

    // Everything between the date and the amount, split on column gaps. The
    // last segment is a category when it names one; otherwise it is part of
    // the description (some banks print a reference there instead).
    const segments = m[2].split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
    let category = null;
    if (segments.length > 1) {
      const named = categoryByName(segments[segments.length - 1]);
      if (named) { category = named; segments.pop(); }
    }

    rows.push({
      date,
      description: segments.join(" — "),
      category,
      amount,
      currency: (m[4] ?? currency)?.toUpperCase() ?? null,
      raw: line.trim(),
    });
  }

  return { rows, currency, skipped };
}

/**
 * "07.06.2026" / "2026-06-07" → "2026-06-07".
 *
 * Day-first is assumed for separator forms, which is correct for this corpus
 * and for European statements generally. A US month-first statement would
 * mis-order days 1–12 within the same month; the month — which is what period
 * assignment actually uses — stays correct either way for those, and any row
 * whose parts cannot both be valid is rejected rather than coerced.
 */
export function parseRowDate(raw) {
  const iso = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return validDate(+iso[1], +iso[2], +iso[3]);

  const parts = String(raw).match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!parts) return null;
  const year = parts[3].length === 2 ? 2000 + Number(parts[3]) : Number(parts[3]);
  return validDate(year, Number(parts[2]), Number(parts[1]));
}

function validDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "-87.45", "-1 234,56", "- 87.45" → number. */
export function parseRowAmount(raw) {
  const cleaned = String(raw).replace(/[  ']/g, "").replace(",", ".");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}
