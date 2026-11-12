// src/tools/secret-scan.js - does a text look like it holds a secret?
// (spec S2.7 rev 3 §2.3; plan TR17). Pure. The remember tool never saves a match.
//
// Accepted cost: a full 40-char git SHA is a hex run and is refused too.

const PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style keys
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /-----BEGIN [A-Z0-9 ]+-----/, // PEM header
  /\b(?:password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/i, // "password: value"
  /\b[0-9a-f]{32,}\b/i, // long hex run
];
const BASE64_RUN = /[A-Za-z0-9+/]{32,}={0,2}/g;

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasSecret(text) {
  if (typeof text !== 'string' || !text) return false;
  if (PATTERNS.some((re) => re.test(text))) return true;
  // A long base64 run counts only when it mixes letters and digits: a long word is no secret.
  for (const [run] of text.matchAll(BASE64_RUN)) {
    if (/\d/.test(run) && /[A-Za-z]/.test(run)) return true;
  }
  return false;
}
