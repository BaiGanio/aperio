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
