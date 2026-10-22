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

/**
 * Streaming-safe restore(): a model's answer arrives as a sequence of text
 * chunks (one per "token" event), and a «LABEL_N» placeholder can land split
 * across two chunks. Buffers any suffix that could be the start of an
 * unfinished placeholder and only restores/releases text once it is sure
 * that suffix isn't one — so a placeholder never reaches the caller half
 * substituted.
 *
 * @param {Map<string, string>} map — token → original map from redact()
 * @returns {{ push(text: string): string, flush(): string }}
 *   - push:  feed the next chunk, get back the safe-to-emit (already
 *            restored) portion — may be shorter than the input, or empty.
 *   - flush: call once the stream ends to release anything still buffered
 *            (restored if it completed a placeholder, verbatim otherwise).
 */
export function createStreamRestorer(map) {
  let pending = '';

  function safeSplit(buf) {
    // Hold back from the last unmatched opening guillemet onward — it may be
    // the start of a placeholder the next chunk completes.
    const lastOpen = buf.lastIndexOf('«');
    const lastClose = buf.lastIndexOf('»');
    const safeEnd = lastOpen > lastClose ? lastOpen : buf.length;
    return { safe: buf.slice(0, safeEnd), rest: buf.slice(safeEnd) };
  }

  return {
    push(text) {
      if (typeof text !== 'string' || !text) return text ?? '';
      if ((!map || map.size === 0) && !pending) return text; // fast path: nothing to ever restore
      const { safe, rest } = safeSplit(pending + text);
      pending = rest;
      return safe ? restore(safe, map) : '';
    },
    flush() {
      const remainder = pending;
      pending = '';
      return remainder ? restore(remainder, map) : '';
    },
  };
}

// memoryHandlers.js's recallHandler namespaces every placeholder it mints
// with a per-call random UUID: «{correlationId}_{rowIdx}_{LABEL}_{n}». This
// is that token's exact shape, exported so callers who only see rendered
// text (not the map) can still recover which correlation id(s) it carries.
const CORRELATION_ID_TOKEN_RE = /«([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/g;

/**
 * Pulls every distinct redaction correlation id embedded in placeholder
 * tokens found in `text`. Used to redeem a redaction map on demand for a
 * provider path that never proactively pushed it into a turn-wide map (e.g.
 * Codex, which runs its own MCP subprocess and bypasses callToolHooked
 * entirely — see lib/agent/redaction-relay.js).
 *
 * @param {string} text
 * @returns {string[]} distinct correlation ids, in first-seen order
 */
export function extractCorrelationIds(text) {
  if (typeof text !== 'string' || !text) return [];
  const ids = [];
  const seen = new Set();
  for (const m of text.matchAll(CORRELATION_ID_TOKEN_RE)) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }
  return ids;
}
