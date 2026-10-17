// Phantom-write detection for the T-G2.3 provenance gate.
//
// The gate exists to stop prose outrunning the database. Every structural check
// it already had asks whether *some* confirmed INSERT landed
// (`insertedRealRows`) — none compared the writes an answer *claims* against
// the writes that actually happened. Ornith-1.0-9B's 2026-08-14 passing run is
// the motivating case: one INSERT of 10 BGN tuples, zero EUR, and an answer
// telling the user the three EUR travel receipts "are saved separately if you
// want them queried as well". The rows did not exist. Nothing failed.
//
// This module is deliberately narrow. Four checks on this gate have now shipped
// as substring tests over free prose and every one produced a false failure that
// invalidated a whole live run (round 8 markdown emphasis, round 9 SQL
// vocabulary, round 11 currency phrasing, the 2026-08-14 category
// decomposition). So the rule here is: the STRUCTURAL side decides, the prose
// side only asks whether the model told the user it had written something, and
// anything undecidable stays silent rather than guessing.
//
// Five constraints keep it from becoming the fifth false-failure:
//
//  1. Currencies come from the ORACLE (`expectations.excluded`) plus the
//     currencies actually written — never invented from the answer's own text.
//  2. A claim only counts if the storage verb is PREDICATIVE ("are saved",
//     "I stored them", "written to the table"). Adjectival use — "the saved
//     records", "your stored data" — is a read, not a write claim, and is
//     ignored.
//  3. Negated, modal and future claims are ignored ("not saved", "will be
//     saved", "can be stored"): they assert nothing about a completed write.
//  4. A claim fires only when its currency scope is UNAMBIGUOUS — named in the
//     claim's own sentence, or, when the claim is anaphoric ("These are saved"),
//     inherited from the nearest preceding sentence in the same block that names
//     exactly one currency. Zero or several candidates means undecidable, and
//     undecidable means silent.
//  5. It fires only when some OTHER currency was written with a literal tag.
//     That proves the run tags currencies in its INSERTs at all, so an absent
//     currency is real evidence of an absent row rather than an artifact of a
//     schema that never stored the code.
//
// Everything here is pure and unit-tested in write-claims.test.js; the harness
// and the replay both reach it through grading.mjs.

/** ISO-4217-shaped token. Matched only against a supplied allowlist. */
const CURRENCY_TOKEN = /\b([A-Z]{3})\b/g;

/**
 * Storage verbs in predicative position only. Each alternative requires
 * something that makes the verb an assertion about a completed write:
 * a copula, an explicit subject, a pronoun object, or a destination.
 */
const STORAGE_CLAIM = new RegExp(
  [
    // "are saved", "were stored", "has been inserted", "is now recorded"
    String.raw`\b(?:are|were|is|was|have been|has been|had been)\s+(?:already\s+|also\s+|now\s+|both\s+)?(?:saved|stored|inserted|recorded|persisted|written|logged)\b`,
    // "I saved", "we've stored", "I have inserted"
    String.raw`\b(?:I|we)\s+(?:have\s+|has\s+|'ve\s+)?(?:saved|stored|inserted|recorded|persisted|wrote|written|logged)\b`,
    // "saved them", "stored these", "recorded it"
    String.raw`\b(?:saved|stored|inserted|recorded|persisted|wrote|written|logged)\s+(?:them|these|those|it|all)\b`,
    // "saved to the table", "inserted into monthly_spending", "written in the db"
    String.raw`\b(?:saved|stored|inserted|recorded|persisted|wrote|written|logged)\s+(?:to|in|into)\s+`,
  ].join("|"),
  "i",
);

/**
 * Kills a claim outright. Negation and modality both mean the sentence is not
 * asserting that a write happened — "were not saved", "will be saved",
 * "can be stored", "rather than saving them".
 */
const CLAIM_CANCELLED = new RegExp(
  [
    // `n't` carries no leading word boundary — in "weren't" the `n` follows a
    // word character, so `\bn't` would never match.
    String.raw`(?:\bnot\b|\bnever\b|n't|\bwithout\b|\bneither\b|\bnor\b)[^.!?]{0,40}?\b(?:saved|stored|inserted|recorded|persisted|written|logged)\b`,
    String.raw`\b(?:will|would|can|could|should|shall|may|might|must|to)\s+(?:be\s+|also\s+|now\s+)*(?:save|store|insert|record|persist|write|log|be\s+saved|be\s+stored|be\s+inserted|be\s+recorded)\b`,
    String.raw`\b(?:rather than|instead of)\s+\w*\s*(?:saving|storing|inserting|recording)\b`,
  ].join("|"),
  "i",
);

/** Split on sentence enders, keeping it simple: these are model answers, not prose corpora. */
function sentences(block) {
  return block
    .split(/(?<=[.!?:])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function currenciesIn(text, allowed) {
  const found = new Set();
  for (const m of text.matchAll(CURRENCY_TOKEN)) {
    if (allowed.has(m[1])) found.add(m[1]);
  }
  return found;
}

/**
 * Currency literals actually written, counted from CONFIRMED INSERT statements
 * only. A pending proposal is not a write: `db_execute` returns the
 * confirmation preview with `pending: true` and no rows have landed at that
 * point.
 *
 * @returns {{ currencyCounts: Map<string, number>, insertStatements: number }}
 */
export function writtenCurrencyCounts(toolCalls = [], allowed = new Set()) {
  const currencyCounts = new Map();
  let insertStatements = 0;

  for (const call of toolCalls) {
    if (call?.name !== "db_execute") continue;
    if (call.ok !== true) continue;
    if (call.pending === true) continue;
    const sql = call.arguments?.sql;
    if (typeof sql !== "string" || !/\bINSERT\s+INTO\b/i.test(sql)) continue;
    insertStatements += 1;

    // Only single-quoted literals count — a currency named in a column name or
    // a comment is not a stored value.
    for (const m of sql.matchAll(/'([A-Z]{3})'/g)) {
      if (!allowed.has(m[1])) continue;
      currencyCounts.set(m[1], (currencyCounts.get(m[1]) ?? 0) + 1);
    }
  }

  return { currencyCounts, insertStatements };
}

/**
 * Currencies the gate is entitled to reason about: those the oracle documents
 * as excluded (the ones an answer is most likely to narrate a fate for), plus
 * any actually written. Never derived from the answer.
 */
export function relevantCurrencies(expectations, toolCalls = []) {
  const set = new Set();
  for (const row of expectations?.excluded ?? []) {
    if (typeof row?.currency === "string" && /^[A-Z]{3}$/.test(row.currency)) set.add(row.currency);
  }
  // A second pass over the SQL, unfiltered, so a written currency the oracle
  // never mentions still becomes known.
  for (const call of toolCalls) {
    if (call?.name !== "db_execute" || call.ok !== true || call.pending === true) continue;
    const sql = call.arguments?.sql;
    if (typeof sql !== "string" || !/\bINSERT\s+INTO\b/i.test(sql)) continue;
    for (const m of sql.matchAll(/'([A-Z]{3})'/g)) set.add(m[1]);
  }
  return set;
}

/**
 * Find storage claims whose currency was never written.
 *
 * @param {object} args
 * @param {string} args.text      Combined answer text across the run's turns.
 * @param {Array}  args.toolCalls Combined tool calls across the run's turns.
 * @param {object} args.expectations Oracle-derived expectations (for `excluded`).
 * @returns {Array<{currency: string, claim: string, scope: "sentence"|"inherited"}>}
 */
export function phantomWriteClaims({ text, toolCalls = [], expectations } = {}) {
  if (typeof text !== "string" || !text.trim()) return [];

  const allowed = relevantCurrencies(expectations, toolCalls);
  if (allowed.size === 0) return [];

  const { currencyCounts } = writtenCurrencyCounts(toolCalls, allowed);

  // Constraint 5: without at least one currency-tagged write, absence proves
  // nothing about this run's schema, so the check stays silent entirely.
  const anyWritten = [...currencyCounts.values()].some((n) => n > 0);
  if (!anyWritten) return [];

  const violations = [];

  for (const block of text.split(/\n+/)) {
    const parts = sentences(block);
    parts.forEach((sentence, i) => {
      if (!STORAGE_CLAIM.test(sentence)) return;
      if (CLAIM_CANCELLED.test(sentence)) return;

      let scope = "sentence";
      let candidates = currenciesIn(sentence, allowed);

      if (candidates.size === 0) {
        // Anaphoric claim ("These are saved separately"). Inherit from the
        // nearest preceding sentence in this block that names exactly one.
        for (let j = i - 1; j >= 0; j -= 1) {
          const back = currenciesIn(parts[j], allowed);
          if (back.size === 0) continue;
          if (back.size === 1) {
            candidates = back;
            scope = "inherited";
          }
          break; // nearest sentence naming any currency decides, or nothing does
        }
      }

      if (candidates.size !== 1) return; // undecidable → silent
      const [currency] = [...candidates];
      if ((currencyCounts.get(currency) ?? 0) > 0) return; // really written

      violations.push({ currency, claim: sentence, scope });
    });
  }

  return violations;
}
