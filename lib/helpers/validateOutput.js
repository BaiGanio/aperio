/**
 * lib/helpers/validateOutput.js
 *
 * Validates and sanitises AI markdown output before it reaches the frontend.
 * Handles fence fixing, normalisation, and XSS defence — single pass.
 *
 * Use in agent.js on every text payload that hits stream_end or messages[].
 */

// ─── XSS blocklist ────────────────────────────────────────────────────────────
// Tags stripped from non-code text (defence in depth — the frontend escapes too)
const XSS_TAG_RE = /<\/?(script|iframe|object|embed|form|style|link|meta|base|svg)\b[^>]*>/gi;

// Event handlers that may appear on any tag (e.g. onerror, onload, onclick)
const XSS_ATTR_RE = /(\s+on\w+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

// Zero-width and control characters (excluding newlines and tabs)
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g;

// ─── Fence helpers ────────────────────────────────────────────────────────────

/**
 * Fix unclosed code fence: if an odd number of ``` are found and the text
 * doesn't already end with one, append a closing fence.
 */
function fixUnclosedFence(text) {
  const fences = text.match(/```/g) || [];
  if (fences.length % 2 === 0) return text;
  if (text.trimEnd().endsWith("```")) return text;
  return text + "\n```";
}

/**
 * Normalise fence formatting — consistent spacing around ``` markers.
 * Strips trailing whitespace on fence lines, ensures a newline after
 * the opening fence's language tag, and trims trailing whitespace on
 * the closing fence.
 */
function normaliseFences(text) {
  // 1. Strip trailing whitespace on fence lines
  //    ```lang   → ```lang
  //    ```   → ```
  text = text.replace(/^(```\w*)[ \t]+$/gm, "$1");

  // 2. Ensure opening fence is followed by exactly one newline
  //    (the ```lang\n content follows)
  //    This is already the typical markdown behavior, just prevent
  //    ```lang   content on same line
  text = text.replace(/^(```\w+)[ \t]+(.+)$/gm, "$1\n$2");

  // 3. Strip trailing whitespace before closing fence
  //    (content with trailing spaces before ```)
  text = text.replace(/[ \t]+(\n```)/g, "$1");

  return text;
}

// ─── XSS ──────────────────────────────────────────────────────────────────────

/**
 * Strip dangerous HTML tags and event-handler attributes.
 * Only operates on non-fence content.
 */
function sanitiseHtml(text) {
  // Extract code blocks so we don't touch content inside them
  const blocks = [];
  const cleaned = text.replace(/```[\s\S]*?```/g, match => {
    const idx = blocks.length;
    blocks.push(match);
    return `\x00BLOCK${idx}\x00`;
  });

  let result = cleaned
    .replace(XSS_TAG_RE, "")
    .replace(XSS_ATTR_RE, "")
    .replace(CONTROL_CHAR_RE, "");

  // Restore blocks
  result = result.replace(/\x00BLOCK(\d+)\x00/g, (_, i) => blocks[Number(i)] ?? "");
  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate and sanitise AI markdown output.
 *
 * Runs in order:
 *   1. Strip XSS vectors and control chars (safe first)
 *   2. Normalise fence formatting
 *   3. Fix unclosed fences
 *
 * @param {string} text — raw markdown from the AI model
 * @returns {string} — clean, validated markdown
 */
export function validateOutput(text) {
  if (!text || typeof text !== "string") return text ?? "";

  let result = text;

  // 1. XSS & control chars (outside code blocks)
  result = sanitiseHtml(result);

  // 2. Normalise fence markers
  result = normaliseFences(result);

  // 3. Fix unclosed code fences
  result = fixUnclosedFence(result);

  return result;
}

/**
 * Convenience — validates text and logs a warning if changes were made.
 * Use this in agent.js for the primary response paths.
 *
 * @param {string} text
 * @param {string} [label] — context label for the log line
 * @returns {string}
 */
export function validateOutputSafe(text, label = "output") {
  const cleaned = validateOutput(text);
  if (cleaned !== text) {
    const diff = cleaned.length - text.length;
    console.log(`[validateOutput] ${label}: ${diff > 0 ? "fixed unclosed fence" : "sanitised content"} (${Math.abs(diff)} chars)`);
  }
  return cleaned;
}
