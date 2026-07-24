// lib/docgraph/extract-facts.js
// Pure, regex-based date-role and amount/currency extraction over already-read
// document text. Sibling to extract-refs.js: same "heuristic, source-labeled,
// never fabricate" contract, different domain (dates/money instead of IDs).
//
// Runs during doc_batch (real content is available there) — never during
// doc_manifest, which is metadata-only by design (see retrieval.js).
//
// A date or amount this module can't confidently label is still reported
// (role "unlabeled_date", currency null) rather than dropped — an explicit
// "found but ambiguous" beats a silent omission that reads as "not present".

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_RE_SRC = MONTH_NAMES.map((m) => m.slice(0, 3)).join("|");

// Token shapes, broadest-first isn't required since we scan with matchAll and
// sort by index; each alternative is unambiguous on its own syntax.
const DATE_TOKEN_RE = new RegExp(
  "\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b" +                                    // 2026-06-03 (ISO)
  "|\\b\\d{1,2}\\.\\d{1,2}\\.\\d{4}\\b" +                               // 03.06.2026 (EU dot)
  "|\\b\\d{1,2}/\\d{1,2}/\\d{4}\\b" +                                   // 03/06/2026 (ambiguous order)
  `|\\b(?:${MONTH_RE_SRC})[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}\\b` +      // June 3, 2026
  `|\\b\\d{1,2}\\s+(?:${MONTH_RE_SRC})[a-z]*\\.?,?\\s+\\d{4}\\b`,       // 3 June 2026
  "gi"
);

// Labels are checked in order; the first that matches near a date wins the
// role. `period: true` labels expect a two-date range and split into
// `<role>_start` / `<role>_end` (or a single `<role>_start` when only one
// date follows — never invent the missing end).
const LABELS = [
  { role: "invoice_date", re: /invoice\s*date/gi },
  { role: "statement_date", re: /statement\s*date/gi },
  { role: "receipt_date", re: /receipt\s*date/gi },
  { role: "payment_date", re: /payment\s*date/gi },
  { role: "due_date", re: /\bdue\s*date\b/gi },
  { role: "document_date", re: /\bdocument\s*date\b/gi },
  { role: "service_period", re: /service\s*period|billing\s*period|\bperiod\b/gi, period: true },
];

const LABEL_WINDOW = 100; // chars scanned after a label for its date(s)

function monthIndex(name) {
  return MONTH_NAMES.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3)));
}

/** Normalizes a matched date token to "YYYY-MM-DD" when unambiguous, else null. */
function normalizeDate(raw) {
  let m;
  if ((m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  if ((m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) {
    // DD.MM.YYYY — the common EU/BG invoice convention.
    return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  if ((m = raw.match(new RegExp(`^(${MONTH_RE_SRC})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})$`, "i")))) {
    const mi = monthIndex(m[1]);
    return mi === -1 ? null : `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  if ((m = raw.match(new RegExp(`^(\\d{1,2})\\s+(${MONTH_RE_SRC})[a-z]*\\.?,?\\s+(\\d{4})$`, "i")))) {
    const mi = monthIndex(m[2]);
    return mi === -1 ? null : `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  // MM/DD/YYYY vs DD/MM/YYYY is genuinely ambiguous without a locale — report
  // the raw token and leave normalization null rather than guessing.
  return null;
}

/**
 * @param {string} text
 * @returns {Array<{role, raw, value, confidence}>} `value` is ISO
 *   "YYYY-MM-DD" or null when the token's format is locale-ambiguous.
 */
export function extractDateCandidates(text) {
  if (!text) return [];
  const out = [];
  const consumed = []; // [start, end) character ranges already attributed to a label

  const allTokens = [...text.matchAll(DATE_TOKEN_RE)]
    .map((m) => ({ raw: m[0], start: m.index, end: m.index + m[0].length }))
    .sort((a, b) => a.start - b.start);

  for (const label of LABELS) {
    for (const lm of text.matchAll(label.re)) {
      const windowStart = lm.index + lm[0].length;
      const windowEnd = windowStart + LABEL_WINDOW;
      const nearby = allTokens.filter((t) => t.start >= windowStart && t.start < windowEnd
        && !consumed.some(([s, e]) => t.start >= s && t.start < e));
      if (!nearby.length) continue;

      if (label.period) {
        const [start, end] = nearby;
        out.push({ role: "service_period_start", raw: start.raw, value: normalizeDate(start.raw), confidence: "high" });
        consumed.push([start.start, start.end]);
        if (end) {
          out.push({ role: "service_period_end", raw: end.raw, value: normalizeDate(end.raw), confidence: "high" });
          consumed.push([end.start, end.end]);
        }
      } else {
        const hit = nearby[0];
        out.push({ role: label.role, raw: hit.raw, value: normalizeDate(hit.raw), confidence: "high" });
        consumed.push([hit.start, hit.end]);
      }
    }
  }

  for (const t of allTokens) {
    if (consumed.some(([s, e]) => t.start >= s && t.start < e)) continue;
    out.push({ role: "unlabeled_date", raw: t.raw, value: normalizeDate(t.raw), confidence: "low" });
  }

  return out.sort((a, b) => a.raw.localeCompare(b.raw));
}

const CURRENCY_SYMBOL_TO_CODE = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "лв": "BGN", "лв.": "BGN" };
const CURRENCY_TOKEN_SRC = "USD|EUR|GBP|BGN|CHF|JPY|CAD|AUD|\\$|€|£|¥|лв\\.?";
const NUMBER_TOKEN_SRC = "\\d{1,3}(?:[.,\\s]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
const AMOUNT_RE = new RegExp(
  `(?:(${CURRENCY_TOKEN_SRC})\\s?(${NUMBER_TOKEN_SRC}))` +
  `|(?:(${NUMBER_TOKEN_SRC})\\s?(${CURRENCY_TOKEN_SRC}))`,
  "gi"
);

// Label words below English are evidenced against the BG/DE/FR household
// fixture corpus (issue #250 doc-intelligence epic) — they are NOT a general
// translation table for the 28+ locales Aperio's UI supports. A label whose
// text never matches any pattern here still gets a value via the
// LIKELY_TOTAL fallback below; see #<doc-intel-i18n-issue> for the plan to
// close the remaining language gap.
//
// More specific patterns are listed before more generic ones on purpose:
// labelFor() breaks ties on equal end-index by keeping the FIRST match in
// this array, and some generic words are substrings of a specific phrase
// (French "sous-total" ends in "total", so "sous\s*total" must precede the
// bare "\btotal\b" pattern or the subtotal line would be mislabeled "total").
const AMOUNT_LABELS = [
  { label: "amount_due", re: /amount\s*due/i },
  { label: "total_due", re: /total\s*due/i },
  { label: "grand_total", re: /grand\s*total/i },
  { label: "balance_due", re: /balance\s*due/i },
  { label: "subtotal", re: /sub\s*total/i },
  // Bulgarian: "ЗА ПЛАЩАНЕ" (amount due) / "Стойност без ДДС" (pre-VAT
  // subtotal). Anchored to line-start (not just "\bза\s*плащане\b") because
  // the same words appear inside two unrelated fields on Bulgarian invoices:
  // "Краен срок за плащане" (payment deadline — a date, not an amount) and
  // "Основание за плащане" (payment reference — free text). Both always have
  // a leading word before reaching "за плащане" on their line; only the real
  // total label starts the line with it.
  { label: "amount_due", re: /(?:^|\n)[ \t]*за\s*плащане/i },
  { label: "subtotal", re: /стойност\s*без\s*ддс/i },
  // German: "Gesamtbetrag"/"Gesamtsumme" (grand total) / "Zwischensumme" (subtotal).
  { label: "grand_total", re: /gesamt(?:betrag|summe)/i },
  { label: "subtotal", re: /zwischensumme/i },
  // French: "Sous-total" (subtotal) must precede the bare "total" pattern below.
  { label: "subtotal", re: /sous[-\s]?total/i },
  { label: "balance", re: /\bbalance\b/i },
  { label: "total", re: /\btotal\b/i },
  { label: "paid", re: /\bpaid\b/i },
  // Bilingual bank-transfer forms (household corpus payment-form-completed-*
  // fixtures, issue #313) gloss the value field as "Сума (Amount):" with the
  // figure and its currency on separate labeled lines. Anchored to the
  // parenthesized gloss specifically — a bare /\bamount\b/i would also catch
  // unrelated uses like a table header ("Amount (BGN)") or descriptive prose
  // ("new amount BGN 107.40"), which are already handled by other means.
  { label: "amount", re: /\(amount\)/i },
];

// Same bilingual-form convention as the "amount" label above: the currency
// code is declared on its own labeled line, not adjacent to the figure it
// belongs to, so AMOUNT_RE's adjacency requirement never sees them together.
// Anchored to the parenthesized gloss for the same overfitting reason.
const CURRENCY_LABEL_RE = /\(currency\)/gi;
const CURRENCY_LINK_WINDOW = 60; // chars scanned after the label for its bare currency token

// 40 was too tight for right-aligned invoice layouts: the household corpus's
// Bulgarian bills pad ~35-39 chars between "ЗА ПЛАЩАНЕ (с ДДС):" and its
// amount to align figures in a fixed-width column. Widening the window only
// adds more candidate labels to search — labelFor() always keeps whichever
// one ends closest to the amount, so this can't make an already-correct
// match wrong, only let a genuinely closer label be seen at all.
const LABEL_LOOKBACK = 60; // chars scanned before an amount for its label

function normalizeCurrency(raw) {
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  return CURRENCY_SYMBOL_TO_CODE[raw] ?? CURRENCY_SYMBOL_TO_CODE[raw.toLowerCase()] ?? null;
}

/** Parses a matched number token to a JS number, or null if genuinely unparseable. */
function parseAmount(raw) {
  const cleaned = raw.trim();
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let decimalAt = -1;
  if (lastComma !== -1 && lastDot !== -1) decimalAt = Math.max(lastComma, lastDot);
  else if (lastComma !== -1 && cleaned.length - lastComma === 3) decimalAt = lastComma; // "45,20" (EU decimal)
  else if (lastDot !== -1) decimalAt = lastDot;

  let intPart = decimalAt === -1 ? cleaned : cleaned.slice(0, decimalAt);
  let fracPart = decimalAt === -1 ? "" : cleaned.slice(decimalAt + 1);
  intPart = intPart.replace(/[.,\s]/g, "");
  const n = Number(fracPart ? `${intPart}.${fracPart}` : intPart);
  return Number.isFinite(n) ? n : null;
}

// Picks the label whose occurrence ends *closest* to the amount, not the
// first pattern to match in priority order — a lookback window wide enough
// to catch "Subtotal: 130.00 BGN" also contains an earlier "Amount Due: "
// belonging to a different number, and priority-first would mislabel every
// amount downstream of an "Amount Due" as amount_due too.
function labelFor(text, matchStart) {
  const windowStart = Math.max(0, matchStart - LABEL_LOOKBACK);
  const before = text.slice(windowStart, matchStart);
  let best = null;
  for (const { label, re } of AMOUNT_LABELS) {
    const global = new RegExp(re.source, "gi");
    let m, lastEnd = -1;
    while ((m = global.exec(before))) lastEnd = m.index + m[0].length;
    if (lastEnd !== -1 && (!best || lastEnd > best.end)) best = { label, end: lastEnd };
  }
  return best ? best.label : null;
}

const BARE_NUMBER_RE = new RegExp(NUMBER_TOKEN_SRC, "g");
const LABEL_FORWARD_WINDOW = 20; // chars scanned after a money label for a currency-less number

// Language-agnostic structural signal (issue #312): most invoices, in any
// language, print a tax-rate line ("VAT 20%", "ДДС 20%", "TVA 19%", "MwSt
// 19%"...) immediately before the final total — the "%" sign itself needs no
// translation. An unlabeled currency-bearing amount on the line right after
// a percentage figure is a strong total signal, independent of whether any
// AMOUNT_LABELS keyword matched anywhere else in the document.
const PERCENT_RE = /\d{1,3}(?:[.,]\d+)?\s*%/g;

/** Returns [start, end) of the first non-blank line at-or-after `fromIndex`, or null. */
function firstNonBlankLineAfter(text, fromIndex) {
  let cursor = fromIndex;
  while (cursor < text.length) {
    const nl = text.indexOf("\n", cursor);
    const lineEnd = nl === -1 ? text.length : nl;
    if (text.slice(cursor, lineEnd).trim() !== "") return [cursor, lineEnd];
    if (nl === -1) return null;
    cursor = nl + 1;
  }
  return null;
}

/**
 * @param {string} text
 * @returns {Array<{value, currency, raw, label}>} `currency` is a 3-letter
 *   ISO code or null when a money-shaped number carried no detectable
 *   currency marker; `value` is null (never 0) when the number itself
 *   couldn't be parsed. `label` may be "likely_total" — a language-agnostic
 *   guess from either the tax-percentage-adjacency signal or the
 *   whole-document fallback below, never a confident match.
 */
export function extractAmountCandidates(text) {
  if (!text) return [];
  const positions = []; // {entry, index} — index drives both the LIKELY_TOTAL
                         // fallback and the final document-order sort, since
                         // the two passes below discover candidates out of
                         // text order (all AMOUNT_RE hits, then all
                         // bare-number-after-label hits per label pattern).
  const seen = new Set();
  const consumed = [];

  for (const m of text.matchAll(AMOUNT_RE)) {
    const currencyRaw = m[1] ?? m[4] ?? null;
    const numberRaw = m[2] ?? m[3] ?? null;
    if (!numberRaw) continue;
    const currency = normalizeCurrency(currencyRaw);
    const value = parseAmount(numberRaw);
    const label = labelFor(text, m.index);
    const key = `${value}|${currency}|${label}|${m.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    consumed.push([m.index, m.index + m[0].length]);
    positions.push({ entry: { value, currency, raw: m[0].trim(), label }, index: m.index });
  }

  // A number next to a money label but with no currency marker at all (e.g.
  // "Balance: 45.20") is still a real amount candidate — report it with
  // currency: null (explicit unknown) instead of dropping it silently.
  for (const { label, re } of AMOUNT_LABELS) {
    for (const lm of text.matchAll(new RegExp(re.source, "gi"))) {
      const windowStart = lm.index + lm[0].length;
      const windowEnd = windowStart + LABEL_FORWARD_WINDOW;
      const window = text.slice(windowStart, windowEnd);
      const nm = BARE_NUMBER_RE.exec(window);
      BARE_NUMBER_RE.lastIndex = 0;
      if (!nm) continue;
      const absStart = windowStart + nm.index;
      const absEnd = absStart + nm[0].length;
      if (consumed.some(([s, e]) => absStart < e && absEnd > s)) continue;
      consumed.push([absStart, absEnd]);
      positions.push({ entry: { value: parseAmount(nm[0]), currency: null, raw: nm[0].trim(), label }, index: absStart });
    }
  }

  // Bilingual split-field forms (issue #313): a labeled bare number picked up
  // just above may still be missing its currency because the code is
  // declared on its own labeled line rather than next to the figure
  // ("Сума (Amount): 29,99" / "Валута (Currency): BGN") — AMOUNT_RE's
  // adjacency requirement never sees the two together. Backfill from the
  // nearest currency-label hit that follows the amount; entries that already
  // resolved a currency, or never matched a money label at all, are untouched.
  const currencyHits = [];
  for (const cm of text.matchAll(CURRENCY_LABEL_RE)) {
    const windowStart = cm.index + cm[0].length;
    const window = text.slice(windowStart, windowStart + CURRENCY_LINK_WINDOW);
    const tm = new RegExp(CURRENCY_TOKEN_SRC, "i").exec(window);
    if (!tm) continue;
    const currency = normalizeCurrency(tm[0]);
    if (currency) currencyHits.push({ index: windowStart + tm.index, currency });
  }
  if (currencyHits.length) {
    for (const p of positions) {
      if (p.entry.currency !== null || p.entry.label === null) continue;
      const numberEnd = p.index + p.entry.raw.length;
      const hit = currencyHits.find((h) => h.index >= numberEnd && h.index - numberEnd <= CURRENCY_LINK_WINDOW);
      if (hit) p.entry.currency = hit.currency;
    }
  }

  // Tax-percentage-adjacency: apply the language-agnostic signal above. Runs
  // before the whole-document fallback below so a per-line guess here counts
  // as "already handled" and the fallback doesn't plant a second, competing
  // guess elsewhere in the same document.
  for (const pm of text.matchAll(PERCENT_RE)) {
    const percentLineEnd = text.indexOf("\n", pm.index + pm[0].length);
    if (percentLineEnd === -1) continue;
    const nextLine = firstNonBlankLineAfter(text, percentLineEnd + 1);
    if (!nextLine) continue;
    const [lineStart, lineEnd] = nextLine;
    const candidate = positions.find(p => p.entry.label === null && p.index >= lineStart && p.index < lineEnd);
    if (candidate) candidate.entry.label = "likely_total";
  }

  // LIKELY_TOTAL fallback: none of the AMOUNT_LABELS patterns cover every
  // locale Aperio's UI supports (see the comment above AMOUNT_LABELS). Most
  // invoices, in any language, print a breakdown/subtotal/tax block and
  // *then* the amount actually owed — so among candidates that carry a real
  // currency but matched no known label, the last one in reading order is a
  // reasonable best guess. Gated on "subtotal" specifically (not "any label
  // at all") because subtotal is a breakdown label, not a terminal one — a
  // document whose subtotal we recognized but whose actual total keyword we
  // don't still has an unlabeled total worth guessing at. Any other real
  // label (amount_due, grand_total, ...) or an already-assigned likely_total
  // from the tax-adjacency pass above means a total-shaped guess already
  // exists, so a second, competing one must not be planted.
  const hasTerminalLabel = positions.some(p => p.entry.label !== null && p.entry.label !== "subtotal");
  if (!hasTerminalLabel) {
    const unlabeledWithCurrency = positions.filter(p => p.entry.label === null && p.entry.currency !== null);
    if (unlabeledWithCurrency.length) {
      unlabeledWithCurrency.sort((a, b) => b.index - a.index)[0].entry.label = "likely_total";
    }
  }

  return positions.sort((a, b) => a.index - b.index).map(p => p.entry);
}
