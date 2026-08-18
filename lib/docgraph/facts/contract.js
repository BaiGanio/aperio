// lib/docgraph/facts/contract.js
// The document-fact contract: the bounded, structured record that every
// downstream aggregation reads instead of re-reading document prose.
//
// Why this exists (issue #250): a small local model handed 47 KB of bills and
// asked "how much did I spend in June" has to find every amount, notice that
// one fuel purchase appears on both a receipt and the bank statement, keep a
// EUR train fare out of the BGN total, and add it up — in its head. It gets
// 806.84 instead of 696.84. Application code owns arithmetic, deduplication,
// currency separation and exclusion policy; the model identifies and explains.
//
// A fact never carries a conclusion it cannot evidence: an amount with no
// resolvable currency, a document with no terminal total, and a charge whose
// month cannot be established are all reported with a reason rather than
// guessed into a total.

import { toMinor } from "./money.js";

/** Bounds. A corpus is user-supplied and may be arbitrarily large; every
 *  array this module builds is capped so a folder of ten thousand invoices
 *  cannot balloon into an unbounded fact array held in memory at once. */
export const FACT_LIMITS = {
  maxFactsPerDocument: 200,
  maxFactsTotal: 5000,
  // Documents and exclusions are capped independently of facts: a folder of
  // scanned images or blank templates yields no facts, so a fact-only cap
  // never trips while the work and the exclusion list both grow unbounded.
  maxDocuments: 5000,
  maxExclusions: 5000,
  // How far apart two records may sit and still describe one purchase. A card
  // transaction posts to a statement up to a few days after the receipt.
  dedupDateSkewDays: 3,
  // Candidates examined per record before a duplicate search gives up. The
  // index makes the ordinary case one lookup; this bounds the pathological
  // one, where thousands of charges share an amount, category and date and
  // land in a single bucket. Giving up is reported, never silent.
  maxDedupCandidates: 200,
  // Classification reads a bounded prefix — provider name, document title and
  // subject line all live in the header. Scanning a 5 MB export in full buys
  // nothing but false positives from footers and terms-and-conditions.
  classifyTextWindow: 2000,
};

/**
 * Amount labels that denote what is actually owed or paid, strongest first.
 *
 * The three "…_due" labels state what is owed now and outrank the invoice's
 * face value: a partly paid invoice showing grand_total 100 and amount_due 20
 * charges 20. `grand_total` outranks the bare `total` because it is the more
 * specific claim when a document carries both.
 *
 * `subtotal`, `balance`, `paid` and the structural `likely_total` guess are
 * deliberately absent: a subtotal is a component, a balance is an account
 * state, `paid` restates a total already counted, and a likely_total is a
 * positional heuristic rather than a claim the document makes.
 */
export const TERMINAL_AMOUNT_LABELS = ["amount_due", "total_due", "balance_due", "refund_due", "grand_total", "total"];

/** How a fact was evidenced. Metadata for adjudication and explanation —
 *  never a filter. A municipal waste-fee "notice" is as real a charge as an
 *  invoice; what excludes a document is the absence of a terminal amount. */
export const EVIDENCE_KINDS = /** @type {const} */ ([
  "invoice", "receipt", "payment_order", "statement_row", "notice", "unknown",
]);

/**
 * Household spending taxonomy. Ordered: when a document matches several
 * categories with equal strength, the earlier entry wins, so the specific
 * (Internet) is checked before the general (Utilities) would ever tie it.
 *
 * Patterns are matched against a haystack of path + title + merchant +
 * description + a bounded prefix of the body, in Bulgarian and English —
 * the two languages this corpus is written in. `Travel` is the one
 * exception: foreign-currency travel documents (a German train ticket, a
 * German hotel bill, a French airport receipt) are German/French by
 * construction, so its patterns cover those languages too — see the
 * "EUR row lands as Uncategorized" entry in id/reference/tech-debt.md for
 * why this category exists. This is a starting taxonomy, not a claim of
 * universal coverage: an unmatched charge becomes an explicit
 * `Uncategorized` bucket that still counts toward the currency total, because
 * a charge you cannot name is still money you spent.
 */
export const CATEGORY_RULES = [
  { category: "Internet", patterns: [/интернет/i, /\binternet\b/i, /broadband/i, /оптичен интернет/i] },
  { category: "Mobile", patterns: [/мобил/i, /mobile top-?up/i, /prepaid/i, /\bsim\b/i] },
  { category: "Utilities", patterns: [
    /електроенерг/i, /електрическа енерг/i, /\belectricity\b/i, /power supply/i,
    /водоснабдяван/i, /вода и канализация/i, /water supply/i, /\bwater bill\b/i,
    /топлинна енерг/i, /топлоснабдяван/i, /district heating/i, /\bheating\b/i,
    /битови отпадъци/i, /waste fee/i, /refuse collection/i,
  ] },
  { category: "Fuel", patterns: [/fuel station/i, /\bfuel\b/i, /petrol/i, /gasoline/i, /бензин/i, /дизел/i, /гориво/i] },
  { category: "Groceries", patterns: [/groceries/i, /grocery/i, /supermarket/i, /хранителни стоки/i, /супермаркет/i, /\bmarket\b/i] },
  { category: "Transport", patterns: [/градски транспорт/i, /public transport/i, /\bmetro\b/i, /метро/i, /транспортна карта/i, /зареждане на карта/i, /\btravel card\b/i] },
  // Deliberately not "\btravel\b" alone — Transport's own "travel card" above
  // would tie with it on every local top-up receipt. These patterns name the
  // trip itself (ticket, flight, lodging) instead, in the languages the
  // fixture corpus's own travel documents are actually written in.
  { category: "Travel", patterns: [
    /\bairport\b/i, /\bflight\b/i, /\bboarding pass\b/i, /\bitinerary\b/i,
    /\breise\b/i, /\bfahrkarte\b/i, /\bflughafen\b/i, /\bunterkunft\b/i,
    /\bvoyage\b/i, /\baéroport\b/i,
    /\bh[oô]tel(s)?\b/i,
  ] },
  { category: "Health", patterns: [/аптек/i, /pharmacy/i, /dental/i, /стоматолог/i, /\bmedical\b/i, /医/i] },
  // \bcafé\b can never match: \b is ASCII-only, so it treats "é" itself as a
  // non-word character and demands a word character right after it — true
  // only for "cafés", the exact inverse of "café" as a standalone word. A
  // lookahead that rejects a following letter/digit/underscore (Unicode-aware
  // via \p{L}, hence the "u" flag) gives the same whole-word strictness as
  // the unaccented /\bcafe\b/i sibling without \b's ASCII blind spot.
  { category: "Dining", patterns: [/restaurant/i, /ресторант/i, /\bcafé(?![\p{L}\d_])/iu, /\bcafe\b/i, /кафене/i, /bistro/i] },
  { category: "Vehicle", patterns: [/автосервиз/i, /car service/i, /\btyres?\b/i, /гуми/i, /авточаст/i] },
  { category: "Insurance", patterns: [/застрахов/i, /insurance/i, /полица/i, /\bpremium\b/i] },
  { category: "Shopping", patterns: [/clothing/i, /дрехи/i, /обувки/i, /\bgift\b/i, /подарък/i] },
];

/** Signals that a document is business trade finance rather than household
 *  spending. Two independent hits are required: "invoice" alone is a
 *  household word too, but an invoice that also cites Incoterms or a
 *  documentary credit is not somebody's electricity bill.
 *
 *  This exists because a recorded run ranked a EUR 1.27M steel commercial
 *  invoice inside the retrieval cap and reported it as household spending. */
export const COMMERCIAL_SIGNALS = [
  /commercial invoice/i,
  /documentary credit/i, /letter of credit/i, /\bMT\s?700\b/i, /\bL\/?C\s+reference/i,
  /incoterms/i, /\b(?:CIF|FOB|EXW|DAP|DDP)\b/,
  /bill of lading/i, /consignee/i, /\bshipper\b/i,
  /\bEORI\b/i, /seller \(exporter\)/i, /buyer \(importer\)/i,
];

/** Labelled document identifiers, in the two corpus languages. A shared
 *  identifier is the only evidence strong enough to merge two records
 *  without adjudication — three representations of invoice 0000424684 are
 *  one charge; two receipts for 120.00 BGN are not necessarily anything. */
const LOCATOR_PATTERNS = [
  { key: "invoice_no", re: /(?:фактура|invoice)\s*(?:№|no\.?|number|#)\s*:?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,})/i },
  { key: "receipt_no", re: /(?:бон|receipt)\s*(?:№|no\.?|number|#)\s*:?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,})/i },
  { key: "notice_no", re: /(?:съобщение|notice)\s*(?:№|no\.?|number|#)\s*:?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,})/i },
  { key: "policy_no", re: /(?:полица|policy)\s*(?:№|no\.?|number|#)\s*:?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,})/i },
];

const EVIDENCE_PATTERNS = [
  { kind: "payment_order", re: /платежно нареждане|вносна бележка|payment order|bank transfer form/i },
  { kind: "receipt", re: /касов бон|фискален бон|fiscal receipt|\breceipt\b|\bбон №/i },
  { kind: "invoice", re: /фактура|\binvoice\b/i },
  { kind: "notice", re: /съобщение|уведомление|\bnotice\b/i },
];

/** Categories addressed by name — statement "Category" columns and any future
 *  structured source can hand us a category directly. */
const CATEGORY_BY_NAME = new Map(CATEGORY_RULES.map(r => [r.category.toLowerCase(), r.category]));

export function categoryByName(name) {
  if (!name) return null;
  return CATEGORY_BY_NAME.get(String(name).trim().toLowerCase()) ?? null;
}

/**
 * Resolve a household category from whatever text describes a charge.
 * Scores each rule by how many of its distinct patterns hit, so a document
 * naming both "интернет" once and "фактура за електроенергия" three times
 * resolves as Utilities rather than by accident of ordering.
 *
 * @returns {{category: string|null, score: number, runnersUp: string[]}}
 */
export function classifyCategory(parts) {
  const haystack = buildHaystack(parts);
  if (!haystack) return { category: null, score: 0, runnersUp: [] };

  const scored = [];
  for (const rule of CATEGORY_RULES) {
    let score = 0;
    for (const re of rule.patterns) if (re.test(haystack)) score++;
    if (score > 0) scored.push({ category: rule.category, score });
  }
  if (!scored.length) return { category: null, score: 0, runnersUp: [] };

  // Stable: strongest score first, taxonomy order breaks ties (the array is
  // already in taxonomy order and Array#sort is stable in Node).
  scored.sort((a, b) => b.score - a.score);
  return {
    category: scored[0].category,
    score: scored[0].score,
    runnersUp: scored.slice(1).map(s => s.category),
  };
}

function buildHaystack({ relPath, title, merchant, description, text } = {}) {
  return [
    relPath ?? "", title ?? "", merchant ?? "", description ?? "",
    String(text ?? "").slice(0, FACT_LIMITS.classifyTextWindow),
  ].filter(Boolean).join("\n");
}

/** True when a document is business trade finance, not household spending. */
export function isCommercialDocument(text) {
  if (!text) return false;
  const window = String(text).slice(0, FACT_LIMITS.classifyTextWindow * 2);
  let hits = 0;
  for (const re of COMMERCIAL_SIGNALS) {
    if (re.test(window)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

/** Best-effort document role. Ordered most-specific first: a completed
 *  payment order also contains the word "фактура" in its reference line. */
export function detectEvidenceKind(text) {
  const window = String(text ?? "").slice(0, FACT_LIMITS.classifyTextWindow);
  for (const { kind, re } of EVIDENCE_PATTERNS) if (re.test(window)) return kind;
  return "unknown";
}

/** Extract labelled identifiers that can prove two records are one event. */
export function extractLocators(text) {
  const window = String(text ?? "").slice(0, FACT_LIMITS.classifyTextWindow);
  const out = {};
  for (const { key, re } of LOCATOR_PATTERNS) {
    const m = window.match(re);
    if (m?.[1]) out[key] = m[1].trim();
  }
  return out;
}

/** The basis/reference line of a payment order names what is being settled
 *  and, in practice, the service period it covers: "Основание (Payment
 *  details): Парно 12/2025" or "Основание за плащане: Интернет 05/2026". */
const BASIS_LINE_RE = /(?:основание|payment\s*details|payment\s*reference|verwendungszweck)[^:\n]*:\s*([^\n]{0,160})/i;
const BASIS_PERIOD_RE = /\b(0?[1-9]|1[0-2])\s*[/.]\s*(20\d{2})\b/;

/** The beneficiary block of a payment order — the provider actually being
 *  paid. Without this a payment order's "merchant" is its own form title
 *  ("ПЛАТЕЖНО НАРЕЖДАНЕ"), which matches nothing and leaves every duplicate
 *  merge against the settled invoice without merchant evidence. */
const BENEFICIARY_RE = /(?:получател|beneficiary|payee)[^\n]*\n(?:[^\n]*\n){0,4}?[^\n]*?(?:име|name)[^:\n]*:\s*([^\n]{2,80})/i;

/**
 * The service period a payment order settles, as "YYYY-MM", or null.
 * Read from the basis line only — a bare "12/2025" elsewhere in a form is as
 * likely to be an account fragment as a period.
 */
export function settledServicePeriod(text) {
  const basis = String(text ?? "").slice(0, FACT_LIMITS.classifyTextWindow).match(BASIS_LINE_RE)?.[1];
  if (!basis) return null;
  const period = basis.match(BASIS_PERIOD_RE);
  if (!period) return null;
  return `${period[2]}-${period[1].padStart(2, "0")}`;
}

/**
 * Which month the charge settled by a payment order belongs to.
 *
 * A payment order is a duplicate representation of a charge; it must not
 * create a new charge in the month the payment happened. A January heating
 * bill paid on 04.02.2026 belongs to January.
 *
 * When the settled invoice is present in the same aggregation, evidence
 * settles this and the payment order is merged into it. When it is not — the
 * caller is aggregating one month, or the invoice was never filed — the
 * period is inferred from two facts the document does state:
 *
 *   • a bill is issued after the period it bills, so the charge cannot
 *     predate the month following the service period;
 *   • a payment cannot precede the charge it settles, so the charge cannot
 *     postdate the payment month.
 *
 * When those two bounds coincide the period is certain; when they do not, the
 * earlier is taken, because a bill is issued when the period closes and only
 * its payment is free to lag.
 *
 * @returns {string|null} "YYYY-MM", or null when there is no basis period
 */
export function settledChargePeriod(text, paymentDate) {
  const service = settledServicePeriod(text);
  if (!service) return null;
  const earliest = shiftPeriod(service, 1);
  const paymentPeriod = paymentDate ? String(paymentDate).slice(0, 7) : null;
  if (!paymentPeriod) return earliest;
  return earliest <= paymentPeriod ? earliest : paymentPeriod;
}

/** "2025-12" + 1 → "2026-01". */
export function shiftPeriod(period, months) {
  const [year, month] = String(period).split("-").map(Number);
  if (!year || !month) return period;
  const index = (year * 12 + (month - 1)) + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** The provider a payment order pays, or null when the form names none. */
export function extractBeneficiary(text) {
  const match = String(text ?? "").slice(0, FACT_LIMITS.classifyTextWindow).match(BENEFICIARY_RE);
  return match?.[1]?.trim().slice(0, 120) || null;
}

/**
 * The merchant/provider line. For these documents it is the first non-empty,
 * non-separator line of the header. Receipts print it letter-spaced
 * ("P E T R O L M A X"), so single-letter runs are collapsed — the same
 * normalization any OCR'd till roll needs.
 */
export function extractMerchant(text) {
  const lines = String(text ?? "").slice(0, FACT_LIMITS.classifyTextWindow).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[=\-_*#.\s]+$/.test(trimmed)) continue; // rule/separator line
    return collapseLetterSpacing(trimmed).slice(0, 120);
  }
  return null;
}

/** "P E T R O L M A X" → "PETROLMAX"; leaves ordinary prose alone. */
export function collapseLetterSpacing(value) {
  return String(value).replace(/(?:\b\p{L}\s){2,}\p{L}\b/gu, m => m.replace(/\s+/g, ""));
}

/** Official Bulgarian Cyrillic → Latin transliteration (Наредба за
 *  транслитерацията). Longest-first so "щ"/"ю"/"я" are not split. */
const CYRILLIC_TO_LATIN = new Map(Object.entries({
  щ: "sht", ж: "zh", ц: "ts", ч: "ch", ш: "sh", ю: "yu", я: "ya",
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ъ: "a", ь: "y",
}));

/**
 * Transliterate Cyrillic so a merchant written in one script can be compared
 * with the same merchant written in the other.
 *
 * This is not cosmetic. A Bulgarian bank statement prints "MobiTel prepaid
 * top-up" while the till receipt for the same purchase prints "МобиТел ЕАД" —
 * with no transliteration the two share no token, the duplicate is missed,
 * and the purchase is counted twice. Over-counting is the failure direction
 * this whole pipeline exists to prevent.
 */
export function transliterate(value) {
  let out = "";
  for (const char of String(value).toLowerCase()) out += CYRILLIC_TO_LATIN.get(char) ?? char;
  return out;
}

/** Comparable lowercase word tokens for merchant-overlap evidence, compared
 *  in a single script so Cyrillic and Latin spellings of one provider meet. */
export function merchantTokens(value) {
  if (!value) return [];
  return transliterate(collapseLetterSpacing(String(value)))
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 4)
    .slice(0, 12);
}

/** Tokens at or above this length may match with one character of difference.
 *  Shorter tokens must match exactly — at four or five characters a single
 *  edit is too much of the word to still be evidence of anything. */
const NEAR_MATCH_MIN_LENGTH = 6;

/**
 * Shared merchant tokens between two records.
 *
 * Exact matches first. Longer tokens then also match within one character,
 * because transliteration between Cyrillic and Latin is not one-to-one: the
 * same supermarket is "EuroMarket" on the bank statement and "ЕВРОМАРКЕТ" on
 * its own receipt, which transliterates to "evromarket" — one substitution
 * away. Without the tolerance the duplicate is missed and the purchase is
 * counted twice.
 *
 * The tolerance never stands alone: currency, amount, category and the date
 * or period window are all still required before merchant evidence is even
 * consulted.
 *
 * @returns {Array<{token: string, exact: boolean, other?: string}>}
 */
export function sharedMerchantTokens(aTokens, bTokens) {
  const shared = [];
  const seen = new Set();
  const others = new Set(bTokens);

  for (const token of aTokens) {
    if (seen.has(token)) continue;
    if (others.has(token)) { seen.add(token); shared.push({ token, exact: true }); continue; }
    if (token.length < NEAR_MATCH_MIN_LENGTH) continue;
    const near = bTokens.find(other =>
      other.length >= NEAR_MATCH_MIN_LENGTH
      && Math.abs(other.length - token.length) <= 1
      && withinOneEdit(token, other));
    if (near) { seen.add(token); shared.push({ token, exact: false, other: near }); }
  }
  return shared;
}

/** True when two strings differ by at most one insertion, deletion or
 *  substitution. Linear and allocation-free — this runs inside adjudication. */
export function withinOneEdit(a, b) {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length - shorter.length > 1) return false;

  let i = 0, j = 0, edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (shorter.length === longer.length) i++;
    j++;
  }
  return edits + (longer.length - j) <= 1;
}

/**
 * Labelled date roles that can place a charge in a month, strongest first.
 *
 * Two omissions are deliberate and load-bearing:
 *
 *   • `service_period_*` is never used. Every utility bill here bills the
 *     PREVIOUS month's consumption, so keying on the service period slides
 *     every utility total one month backwards.
 *   • `payment_date` ranks below the issue dates. A payment order evidences
 *     the charge it settles; it does not move that charge into the month the
 *     payment was made. A January heating bill paid in February stays in
 *     January — unless the payment date is the only date there is.
 */
const ASSIGNMENT_DATE_ROLES = [
  "receipt_date",   // a receipt's date IS the purchase
  "invoice_date",   // explicitly the issue date of the charge
  "document_date",  // a generic "Дата:" header — issue date by convention
  "statement_date",
  "payment_date",
];

/**
 * Which month a charge belongs to.
 *
 * A charge belongs to the month of its own issue or transaction date; see
 * ASSIGNMENT_DATE_ROLES for the roles this walks and why it skips two.
 *
 * @param {Array<{role: string, value: string|null, confidence: string}>} dates
 * @param {{filenameHint?: string|null}} [opts]
 * @returns {{date: string|null, source: string, confidence: "high"|"low", issue?: string}}
 */
export function resolveAssignmentDate(dates, { filenameHint = null } = {}) {
  const usable = (Array.isArray(dates) ? dates : []).filter(d => d?.value);

  for (const role of ASSIGNMENT_DATE_ROLES) {
    const hits = distinctValues(usable.filter(d => d.role === role && d.confidence === "high"));
    if (hits.length === 1) return { date: hits[0], source: role, confidence: "high" };
    if (hits.length > 1) {
      return { date: null, source: role, confidence: "low", issue: `multiple distinct ${role} values` };
    }
  }

  // Receipts and tickets often carry no labelled date at all, only a bare
  // "Date: 09.06.2026". Unlabelled dates count when they agree on one month —
  // that is enough to place the charge in a period even if the exact day is
  // ambiguous.
  const unlabelled = distinctValues(usable.filter(d => d.role === "unlabeled_date"));
  const months = new Set(unlabelled.map(v => v.slice(0, 7)));
  if (months.size === 1) {
    return { date: unlabelled.sort()[0], source: "unlabeled_date", confidence: "low" };
  }
  if (months.size > 1 && filenameHint) {
    const matching = unlabelled.filter(v => v.startsWith(filenameHint)).sort();
    if (matching.length) return { date: matching[0], source: "unlabeled_date+filename", confidence: "low" };
  }

  // A due date places the charge only as a last resort: it can fall in the
  // month after the one the charge belongs to.
  const due = distinctValues(usable.filter(d => d.role === "due_date" && d.confidence === "high"));
  if (due.length === 1) return { date: due[0], source: "due_date", confidence: "low" };

  if (filenameHint) return { date: null, source: "filename", confidence: "low", period: filenameHint };
  return { date: null, source: "none", confidence: "low", issue: "no usable date" };
}

function distinctValues(entries) {
  return [...new Set(entries.map(e => e.value))];
}

/**
 * Build one validated fact. Returns `{fact}` or `{issue}` — never a partially
 * populated fact: a record that cannot state its amount, currency or period
 * is evidence of a gap, and gaps get reported, not averaged in.
 */
export function createFact(input) {
  const {
    document, root, locator = null, amount, currency, label = null,
    assignmentDate, period: explicitPeriod = null, dates = {}, category = null,
    merchant = null, description = null, evidenceKind = "unknown",
    paymentStatus = "amount_due_documented", locators = {}, confidence = "high",
  } = input;

  if (currency == null) {
    return { issue: { document, reason: "no_currency", detail: `amount ${amount} has no resolvable currency` } };
  }
  const minor = toMinor(amount, currency);
  if (minor == null) {
    return { issue: { document, reason: "unparsable_amount", detail: String(amount) } };
  }
  const period = explicitPeriod ?? (assignmentDate ? assignmentDate.slice(0, 7) : null);
  if (!period) {
    return { issue: { document, reason: "no_period", detail: "no issue or transaction date could be resolved" } };
  }

  return {
    fact: {
      document, root, locator,
      amount_minor: minor,
      amount: amount,
      currency,
      amount_label: label,
      period,
      assignment_date: assignmentDate ?? null,
      dates,
      category,
      merchant,
      description,
      evidence_kind: evidenceKind,
      payment_status: paymentStatus,
      source_locators: locators,
      confidence,
    },
  };
}
