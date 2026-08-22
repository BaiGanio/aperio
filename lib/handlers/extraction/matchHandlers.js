// lib/handlers/extraction/matchHandlers.js
// Ranks a document's text against every known extraction_templates row
// (Document Intelligence WS3, issue #250). Cheap and deterministic — plain
// keyword overlap, no embedding call — per the plan's explicit design choice
// (§5 Step 2). Always returns the full ranked list, not just a top pick, so a
// near-miss stays visible instead of being silently forced into either
// "matched" or "no match".

import * as templateHandlers from "./templateHandlers.js";

// A template scores >= CONFIDENT_THRESHOLD to auto-match. Two templates
// within AMBIGUOUS_MARGIN of each other (and both plausible) are reported as
// "ambiguous" rather than silently picking the higher-ranked one — the cold-
// start flow (T-G4.3) must ask instead of guessing between two shapes.
export const CONFIDENT_THRESHOLD = 0.6;
export const AMBIGUOUS_MARGIN = 0.15;

/**
 * Frequent significant words in `text`. Unicode-letter aware (`\p{L}`, not
 * `\w`) so it works the same over BG/DE/FR/EN text — the same locale range
 * extract-facts.js's own label matching was hardened for (#312/#313). Used
 * both to rank existing templates and, by extractHandlers.inferTemplateProposal,
 * to seed a new template's match_keywords from a document's own text rather
 * than from the (necessarily English) role vocabulary its fields resolve to.
 */
export function significantWords(text, { max = 8, minLen = 4 } = {}) {
  if (!text) return [];
  const counts = new Map();
  for (const m of text.matchAll(/[\p{L}][\p{L}-]{2,}/gu)) {
    const w = m[0].toLowerCase();
    if (w.length < minLen) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([w]) => w);
}

// These words describe a document role, rather than its issuer. They are a
// deliberately small penalty vocabulary, not a language stop-word list: the
// positional and label-shape signals below still do the useful work for
// documents in scripts/languages not represented here.
const GENERIC_PROPOSAL_WORDS = new Set([
  "account", "amount", "bill", "date", "description", "due", "invoice",
  "number", "payment", "period", "receipt", "service", "subtotal", "tax",
  "total",
]);

/**
 * Select proposal keywords using document structure as well as frequency.
 * Header terms are usually issuer/product evidence; words before a colon on
 * a numeric line are usually field labels. The bounds keep this cheap and
 * make the result stable for long, noisy, or OCR-derived documents.
 */
export function proposalKeywords(text, { max = 8, minLen = 4, headerLines = 4 } = {}) {
  if (!text || !text.trim()) return [];

  const candidates = new Map();
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const tokenRe = /[\p{L}][\p{L}\p{N}-]{2,}/gu;
  const add = (token, lineIndex, line) => {
    const word = token.toLowerCase();
    if (word.length < minLen) return;
    if (/^(.)\1{2,}$/u.test(word)) return;
    const firstColon = line.indexOf(":");
    const beforeColon = firstColon >= 0 && line.slice(0, firstColon).toLowerCase().includes(word);
    const numericLabel = beforeColon && /[\p{N}]|[%€$£¥]/u.test(line.slice(firstColon + 1));
    const entry = candidates.get(word) ?? { count: 0, header: 0, first: 0, label: 0, firstSeen: candidates.size };
    entry.count += 1;
    if (lineIndex < headerLines) entry.header += 1;
    if (lineIndex === 0) entry.first += 1;
    if (beforeColon || numericLabel) entry.label += 1;
    candidates.set(word, entry);
  };

  lines.forEach((line, lineIndex) => {
    for (const match of line.matchAll(tokenRe)) add(match[0], lineIndex, line);
  });

  return [...candidates.entries()]
    .map(([word, stats]) => ({
      word,
      stats,
      score: Math.min(stats.count, 3) + stats.header * 4 + stats.first * 2
        - stats.label * 3 - (GENERIC_PROPOSAL_WORDS.has(word) ? 4 : 0),
    }))
    .filter(({ word, score }) => score > 0 && !GENERIC_PROPOSAL_WORDS.has(word))
    .sort((a, b) => b.score - a.score || a.stats.firstSeen - b.stats.firstSeen || a.word.localeCompare(b.word))
    .slice(0, max)
    .map(({ word }) => word);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Unicode-aware whole-word/phrase match: a keyword only counts when neither
// side of the match is itself a letter or digit. Plain `.includes()` would
// score a "gas" keyword against "Las Vegas"; `\b` doesn't generalize past
// ASCII (`\w` never matches Cyrillic/etc., so it can't bound a BG/DE/FR
// keyword). Lookaround against `\p{L}`/`\p{N}` works for any script — same
// Unicode-letter convention `significantWords()` already uses.
function containsWholeWord(lowerText, keyword) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}])`, "u");
  return re.test(lowerText);
}

/** @returns {Array<{template, score, matchedKeywords}>} sorted highest-score first. */
export async function matchTemplates(store, { text }) {
  if (!text || !text.trim()) return [];
  const templates = await templateHandlers.list(store);
  const lowerText = text.toLowerCase();
  return templates
    .map((template) => {
      const keywords = template.match_keywords;
      const matchedKeywords = keywords.filter((k) => containsWholeWord(lowerText, k.toLowerCase()));
      const score = keywords.length ? matchedKeywords.length / keywords.length : 0;
      return { template, score, matchedKeywords };
    })
    .sort((a, b) => b.score - a.score || a.template.name.localeCompare(b.template.name));
}

/**
 * Classifies a ranked list into "confident" (auto-match), "ambiguous" (ask —
 * two templates close enough that picking one would be a guess), or "none"
 * (no template clears the confidence bar; falls through to WS1's ad-hoc
 * path or a new-template proposal).
 */
export function classifyMatch(ranked) {
  if (!ranked.length || ranked[0].score < CONFIDENT_THRESHOLD) return { status: "none", top: null, ranked };
  const [first, second] = ranked;
  if (second && second.score >= CONFIDENT_THRESHOLD - AMBIGUOUS_MARGIN && (first.score - second.score) < AMBIGUOUS_MARGIN) {
    return { status: "ambiguous", top: null, ranked };
  }
  return { status: "confident", top: first, ranked };
}
