// lib/docgraph/facts/money.js
// Integer minor-unit money for document aggregation.
//
// Every total this module produces is summed in integer minor units and only
// converted back to a decimal at the edge. Floating-point addition over a
// month of bills drifts in the third decimal (0.1 + 0.2 !== 0.3), and the
// benchmark this feeds distinguishes 260.50 from 260.75 — a quarter of a lev.
// The rule is: parse once, add as integers, format once.

// Minor-unit exponents for the currencies this corpus and its neighbours use.
// Anything unlisted is assumed to have two decimal places, which is true for
// the overwhelming majority of ISO-4217 codes; the exceptions that matter in
// practice are the zero-decimal Asian currencies below.
const MINOR_EXPONENT = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3,
};

/** Minor units per major unit for a currency code (BGN → 100). */
export function minorFactor(currency) {
  return 10 ** (MINOR_EXPONENT[String(currency ?? "").toUpperCase()] ?? 2);
}

/**
 * Convert a decimal amount to integer minor units.
 * Rounds half away from zero so a credit note (-34.205) and a charge
 * (34.205) round symmetrically rather than both drifting toward +∞.
 *
 * @returns {number|null} null when the input is not a finite number
 */
export function toMinor(value, currency) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = minorFactor(currency);
  const scaled = value * factor;
  // Nudge by an epsilon proportional to the magnitude before rounding:
  // 142.5 * 100 is exactly 14250, but 1.15 * 100 is 114.99999999999999 and
  // would truncate to 114 under a bare Math.round of the negative branch.
  const eps = Math.sign(scaled) * 1e-6;
  return Math.round(scaled + eps);
}

/** Convert integer minor units back to a decimal amount (14250 → 142.5). */
export function fromMinor(minor, currency) {
  if (typeof minor !== "number" || !Number.isFinite(minor)) return null;
  return minor / minorFactor(currency);
}

/** Sum integer minor units. Empty input is 0, not null — an empty category
 *  genuinely totals zero, which is different from "could not be computed". */
export function sumMinor(values) {
  let total = 0;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    total += v;
  }
  return total;
}

/** Fixed-decimal string for display ("142.50"), never a float artefact. */
export function formatMinor(minor, currency) {
  const exponent = MINOR_EXPONENT[String(currency ?? "").toUpperCase()] ?? 2;
  return (minor / minorFactor(currency)).toFixed(exponent);
}
