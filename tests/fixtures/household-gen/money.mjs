// Integer-cent money and date helpers for the household corpus generator.
// Every amount in the corpus and in the oracle is carried as an integer number
// of minor units (стотинки, cents, pence, fen). Floats appear only when a
// quantity is multiplied by a tariff, and the result is rounded to minor units
// immediately.

/** Parse a decimal amount ("142.50", 142.5) into integer minor units. */
export function cents(amount) {
  if (typeof amount === "number") return Math.round(amount * 100);
  const text = String(amount).trim().replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new Error(`not a money literal: ${amount}`);
  return Math.round(Number(text) * 100);
}

/** Multiply a quantity by a unit price (both decimal) into minor units. */
export function product(quantity, unitPrice) {
  return Math.round(quantity * unitPrice * 100);
}

export function sum(...values) {
  return values.flat().reduce((total, value) => total + value, 0);
}

/** 20% Bulgarian VAT on a net amount, rounded half-up to стотинки. */
export function vat20(net) {
  return Math.round(net * 0.2);
}

const LOCALES = {
  bg: { decimal: ",", group: " " },
  en: { decimal: ".", group: "," },
  de: { decimal: ",", group: "." },
  fi: { decimal: ",", group: " " },
  es: { decimal: ",", group: "." },
  fr: { decimal: ",", group: " " },
  zh: { decimal: ".", group: "," },
  plain: { decimal: ".", group: "" },
};

/** Format minor units using a locale's separators. `money(14250, "bg")` → "142,50". */
export function money(minorUnits, locale = "bg") {
  const rules = LOCALES[locale] ?? LOCALES.plain;
  const negative = minorUnits < 0;
  const absolute = Math.abs(minorUnits);
  const whole = String(Math.floor(absolute / 100));
  const fraction = String(absolute % 100).padStart(2, "0");
  const grouped = rules.group
    ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, rules.group)
    : whole;
  return `${negative ? "-" : ""}${grouped}${rules.decimal}${fraction}`;
}

/** Right-align a rendered amount inside a fixed-width column. */
export function pad(text, width) {
  return String(text).padStart(width, " ");
}

/** Left-align, for label columns. */
export function padEnd(text, width) {
  return String(text).padEnd(width, " ");
}

// ---------------------------------------------------------------------------
// Dates. Corpus dates are authored as ISO strings and rendered per locale.
// ---------------------------------------------------------------------------

const BG_MONTHS = [
  "януари", "февруари", "март", "април", "май", "юни",
  "юли", "август", "септември", "октомври", "ноември", "декември",
];

const EN_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function parts(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

/** "2026-06-03" → "03.06.2026" (BG/DE/EU dotted form). */
export function dotted(iso) {
  const { year, month, day } = parts(iso);
  return `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`;
}

/** "2026-06-03" → "03/06/2026" (FR/ES slashed form). */
export function slashed(iso) {
  const { year, month, day } = parts(iso);
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

/** "2026-06-03" → "06/03/2026" (US form). */
export function usDate(iso) {
  const { year, month, day } = parts(iso);
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
}

/** "2026-06-03" → "3 June 2026" (UK form). */
export function ukDate(iso) {
  const { year, month, day } = parts(iso);
  return `${day} ${EN_MONTHS[month - 1]} ${year}`;
}

/** "2026-06-03" → "2026年06月03日" (CN form). */
export function cnDate(iso) {
  const { year, month, day } = parts(iso);
  return `${year}年${String(month).padStart(2, "0")}月${String(day).padStart(2, "0")}日`;
}

export function bgMonthName(month) {
  return BG_MONTHS[month - 1];
}

export function enMonthName(month) {
  return EN_MONTHS[month - 1];
}

/** "2026-06" → { start: "2026-06-01", end: "2026-06-30" }. */
export function monthBounds(period) {
  const [year, month] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${period}-01`,
    end: `${period}-${String(lastDay).padStart(2, "0")}`,
    lastDay,
  };
}

/** Period arithmetic on "YYYY-MM" strings. `shiftPeriod("2026-01", -1)` → "2025-12". */
export function shiftPeriod(period, months) {
  const [year, month] = period.split("-").map(Number);
  const zeroBased = year * 12 + (month - 1) + months;
  return `${Math.floor(zeroBased / 12)}-${String((zeroBased % 12) + 1).padStart(2, "0")}`;
}

/** The "MM/YYYY" service marker Bulgarian bills print in the payment reason. */
export function serviceMarker(period) {
  const [year, month] = period.split("-");
  return `${month}/${year}`;
}

/** Period a date belongs to: "2026-06-03" → "2026-06". */
export function periodOf(iso) {
  return iso.slice(0, 7);
}

/** Fixed-width rule lines used across the plain-text documents. */
export function rule(width = 60, char = "-") {
  return char.repeat(width);
}
