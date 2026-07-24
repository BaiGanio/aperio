// lib/privacy/redact.js
// PII detection and redaction for Privacy Shield ("memory sensitivity tiers").
//
// Replaces common personally-identifiable patterns with stable placeholders
// before content crosses a trust boundary (e.g. cloud provider), and restores
// the original text from placeholders on the return path.
//
// Pure functions, zero external dependencies, ~50 lines.

// Pattern list: each entry is [label, regex].
// Labels are used only in placeholder tokens and the map; they are not
// surfaced to the model.
const PATTERNS = [
  // Ordered most-specific-first so a precise pattern claims the match before a
  // broader one would (e.g. CARD/IBAN before PHONE, which is greedier).
  ['EMAIL', /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g],
  ['IBAN',  /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g],
  ['CARD',  /\b(?:\d[ -]?){13,16}\b/g],
  ['PHONE', /\b(?:\+?\d[\d ().-]{7,}\d)\b/g],
  // extend as needed — add entries here, no other code changes required.
];

/**
 * Replace PII in `text` with stable «LABEL_N» placeholders.
 *
 * @param {string} text — input that may contain PII
 * @returns {{ text: string, map: Map<string, string> }}
 *   - text:       the redacted string with placeholders
 *   - map:        token → original value for restoration
 */
export function redact(text) {
  if (typeof text !== 'string') return { text: String(text), map: new Map() };

  const map = new Map();
  let out = text;
  let n = 0;

  for (const [label, re] of PATTERNS) {
    out = out.replace(re, (m) => {
      const token = `\u00AB${label}_${n++}\u00BB`;
      map.set(token, m);
      return token;
    });
  }

  return { text: out, map };
}

/**
 * Restore original PII values from placeholders.
 *
 * @param {string} text — text potentially containing «LABEL_N» placeholders
 * @param {Map<string, string>} map — token → original map from redact()
 * @returns {string} text with all placeholders replaced by originals
 */
export function restore(text, map) {
  if (typeof text !== 'string') return '';
  if (!map || map.size === 0) return text;

  let out = text;
  for (const [token, original] of map) {
    out = out.split(token).join(original);
  }
  return out;
}
