// lib/memory/compact.js
// Deterministic + optional-LLM memory content rewriter (#286, WS1). Operates
// on `content` only (see memory-compaction.md §2 — title is excluded: short,
// and the field recall's hit-rate scoring keys on). Rule-pack selection reads
// the existing `lang` column directly (a Postgres text-search config name set
// by localeToPgConfig() at write time, e.g. "english"/"german"/"simple") —
// no language detector, per the same §2 correction. Any lang without a rule
// pack is left untouched (fail-open) rather than run through English rules.

import { countTokens } from "./tokenCount.js";
import { complete as defaultComplete } from "../helpers/completion.js";
import { RULE_PACK as ENGLISH_RULE_PACK } from "./compaction-rules/en.js";

const RULE_PACKS = { english: ENGLISH_RULE_PACK };

// Private-use-area delimiters: vanishingly unlikely to collide with real
// memory content, and never matched by the English rule pack's literal
// multi-word phrases, so placeholders survive every rule pass untouched.
const PLACEHOLDER_START = "";
const PLACEHOLDER_END = "";
const PLACEHOLDER_RE = new RegExp(`${PLACEHOLDER_START}(\\d+)${PLACEHOLDER_END}`, "g");

// Ordered alternation — each branch is tried left-to-right at every start
// position, so more specific spans (code/URL/quoted string/path) are claimed
// before the generic number/date branch can eat into them. Deliberately
// over-inclusive (e.g. "and/or" fails the path branch harmlessly since it has
// no extension); over-protecting a span only costs a little compaction
// headroom, never correctness.
const PROTECTED_SPAN_RE = new RegExp(
  [
    "```[\\s\\S]*?```", // fenced code block
    "`[^`\\n]+`", // inline code
    "https?://[^\\s)\\]\"'>]+", // URL
    '"[^"\\n]*"', // double-quoted string (error messages, quotes)
    "[^\\s\"'`]*/[^\\s\"'`]*\\.[A-Za-z0-9]+", // file-path-shaped token with extension
    "\\b\\d+(?:[.,:/-]\\d+)*%?\\b", // number / date / percentage
  ].join("|"),
  "g",
);

export function maskProtectedSpans(text) {
  const spans = [];
  const masked = text.replace(PROTECTED_SPAN_RE, match => {
    spans.push(match);
    return `${PLACEHOLDER_START}${spans.length - 1}${PLACEHOLDER_END}`;
  });
  return { masked, spans };
}

export function unmaskProtectedSpans(masked, spans) {
  return masked.replace(PLACEHOLDER_RE, (_, i) => spans[Number(i)]);
}

function getRulePack(lang) {
  return RULE_PACKS[lang] ?? null;
}

export function compactDeterministic(content, lang, { maxTier = 3 } = {}) {
  const pack = getRulePack(lang);
  if (!pack) return { text: content, applied: false, reason: "no-rule-pack" };

  const { masked, spans } = maskProtectedSpans(content);
  let working = masked;
  for (let tier = 0; tier < Math.min(maxTier, pack.length); tier++) {
    for (const [pattern, replacement] of pack[tier]) {
      working = working.replace(pattern, replacement);
    }
  }
  working = working.replace(/ {2,}/g, " ");
  const rewritten = unmaskProtectedSpans(working, spans);

  if (countTokens(rewritten) >= countTokens(content)) {
    return { text: content, applied: false, reason: "no-reduction" };
  }
  return { text: rewritten, applied: true, reason: "ok" };
}

function buildLLMPrompt(maskedText) {
  return (
    "Rewrite the following text to use fewer tokens while preserving its full meaning and " +
    `every token of the exact form ${PLACEHOLDER_START}<number>${PLACEHOLDER_END} unchanged ` +
    "and in place, once each. Return only the rewritten text, nothing else.\n\n" +
    maskedText
  );
}

// Optional LLM rewrite pass, behind the same { text, applied, reason } shape
// as compactDeterministic. Never throws: any failure — a dropped/duplicated
// placeholder, a thrown error from llmComplete, or the same inflation guard —
// falls back to compactDeterministic's result (which itself falls back to the
// raw original on its own fail-open/no-reduction paths). The LLM attempt is
// not gated by `lang` — only the deterministic fallback target is — since an
// LLM pass can compress languages the deterministic packs don't cover yet.
export async function compactWithLLM(content, lang, { llmComplete = defaultComplete } = {}) {
  const deterministic = compactDeterministic(content, lang);
  const { masked, spans } = maskProtectedSpans(content);

  try {
    const raw = await llmComplete([{ role: "user", content: buildLLMPrompt(masked) }], { maxTokens: 600 });
    if (typeof raw !== "string" || !raw) throw new Error("llmComplete returned no text");

    // Placeholders are assigned 0..N-1 in left-to-right order by
    // maskProtectedSpans, so a faithful rewrite must reproduce that exact
    // sequence. Checking only "each index appears once" (no order check)
    // would accept a rewrite that keeps every placeholder but reorders them —
    // silently swapping which date/number/path lands where after unmasking,
    // which can change a memory's meaning without tripping any other guard.
    const foundOrder = [...raw.matchAll(PLACEHOLDER_RE)].map(m => Number(m[1]));
    const expectedOrder = spans.map((_, i) => i);
    const sameOrder = foundOrder.length === expectedOrder.length &&
      foundOrder.every((index, i) => index === expectedOrder[i]);
    if (!sameOrder) throw new Error("LLM output reordered, dropped, or duplicated a protected placeholder");

    const unmasked = unmaskProtectedSpans(raw, spans);
    if (countTokens(unmasked) >= countTokens(content)) {
      throw new Error("LLM output did not shrink token count");
    }
    return { text: unmasked, applied: true, reason: "llm-ok" };
  } catch {
    return deterministic;
  }
}
