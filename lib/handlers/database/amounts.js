// Locale-aware amount parsing for document extraction writes.
// Keep the source text in the extraction row; this module only supplies the
// numeric value and currency used by SQL aggregation.

const CURRENCY_SYMBOLS = new Map([
  ["€", "EUR"], ["$", "USD"], ["£", "GBP"], ["₣", "CHF"],
]);

const LOCALE_DECIMAL_COMMA = /^(bg|de|fr)(?:[-_].*)?$/i;
const CURRENCY_RE = /\b(BGN|EUR|USD|GBP|CHF|CAD|AUD|JPY)\b/i;

function currencyFrom(input) {
  const symbol = [...CURRENCY_SYMBOLS].find(([token]) => input.includes(token));
  if (symbol) return symbol[1];
  return input.match(CURRENCY_RE)?.[1]?.toUpperCase() ?? null;
}

function cleanNumberToken(token) {
  return token.replace(/[\s\u00a0_']/g, "").replace(/[€$£₣]/g, "");
}

/**
 * Parse a document amount without silently guessing an ambiguous separator.
 * @param {string|number} input source amount, optionally containing currency
 * @param {{currency?: string, locale?: string}} [options]
 * @returns {{amount: number, currency: string, source: string}}
 */
export function normalizeAmount(input, options = {}) {
  const source = String(input ?? "").trim();
  if (!source) throw new Error("amount is required");

  const currency = String(options.currency || currencyFrom(source) || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("currency is required (ISO 4217 code or a supported symbol)");
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("amount must be finite");
    return { amount: input, currency, source };
  }

  const token = source
    .replace(CURRENCY_RE, "")
    .replace(/[€$£₣]/g, "")
    .replace(/[^0-9,.-]/g, "")
    .trim();
  if (!token || !/^-?[0-9][0-9.,-]*$/.test(token) || (token.match(/-/g) || []).length > 1) {
    throw new Error(`invalid amount "${source}"`);
  }

  const comma = token.lastIndexOf(",");
  const dot = token.lastIndexOf(".");
  let normalized;
  if (comma >= 0 && dot >= 0) {
    // The final separator is decimal; all earlier separators are grouping.
    const decimal = Math.max(comma, dot);
    const fraction = token.slice(decimal + 1);
    if (!/^\d{1,2}$/.test(fraction)) throw new Error(`invalid decimal amount "${source}"`);
    normalized = `${token.slice(0, decimal).replace(/[.,]/g, "")}.${fraction}`;
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const occurrences = [...token].filter(ch => ch === separator).length;
    const fraction = token.slice(token.lastIndexOf(separator) + 1);
    const decimalComma = LOCALE_DECIMAL_COMMA.test(String(options.locale || ""))
      || ["BGN", "EUR", "CHF"].includes(currency);
    if (occurrences > 1) {
      if (!/^\d{3}$/.test(fraction)) throw new Error(`invalid grouped amount "${source}"`);
      normalized = token.replaceAll(separator, "");
    } else if (/^\d{3}$/.test(fraction) && !decimalComma && options.locale) {
      normalized = token.replace(separator, "");
    } else if (/^\d{1,2}$/.test(fraction)) {
      normalized = token.replace(separator, ".");
    } else {
      throw new Error(`ambiguous amount separator in "${source}"`);
    }
  } else {
    normalized = token;
  }

  const amount = Number(cleanNumberToken(normalized));
  if (!Number.isFinite(amount)) throw new Error(`invalid amount "${source}"`);
  return { amount, currency, source };
}
