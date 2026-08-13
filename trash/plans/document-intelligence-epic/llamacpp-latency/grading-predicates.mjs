// Pure grading predicates for document-intelligence-skill-harness.mjs's
// provenance phase (T-G2.3), extracted 2026-08-13 (round 8) for the same
// reason provenance-ladder.mjs was: the harness module runs a top-level
// `try` block, so nothing defined inside it can be imported by a test.
// Both predicates are already threaded into computeProvenanceSuccess as
// dependencies, so they were pure functions in all but location.

// Models emphasise the figures they narrate. `**Total in BGN:** 696.84` is
// the shape gemma4 (and every other model in this epic) actually emits, and
// the pre-round-8 regex allowed only `\s*` between the total cue and the
// number, so every such line was scored as "no total narrated".
//
// That single false negative invalidated a whole gate run: the predicate is
// also followUpSatisfied's stop condition, so the ladder escalated past a
// correct answer into rungs that instruct the model "without calling any
// more tools", after which the last-content-turn grading rule cannot see a
// db_query at all. Round 8 scored false on all seven turns, including turn 3,
// which had queried real rows and stated correct per-currency totals with the
// non-conversion explicitly disclosed.
//
// The gap classes below therefore admit whitespace AND markdown emphasis /
// formatting punctuation — but never letters or digits, which would let
// unrelated prose bridge a total cue to an unrelated number.
const GAP = "[\\s*_`~]*";
const GAP1 = "[\\s*_`~]+";
const CURRENCY = "(?:BGN|EUR|USD|GBP|\\$|€|£)";
const AMOUNT = `${CURRENCY}?${GAP}\\d{1,3}(?:[ .]\\d{3})*[.,]\\d{2}`;
// "total", and the inflections models reach for: totals, totaling/totalling,
// totaled/totalled. Bare `total` alone also failed on "Totals: 696.84".
const CUE = `(?:grand${GAP1})?total(?:s|l?ing|l?ed)?`;

const NARRATED_TOTAL = new RegExp(
  // cue first: "Grand Total: 696.84", "**Total in BGN:** 696.84"
  `${CUE}(?:${GAP1}\\w+){0,5}${GAP}(?:is|:|=|was)?${GAP}${AMOUNT}`
  // amount first: "696.84 BGN total"
  + `|${AMOUNT}${GAP}(?:BGN|EUR|USD|GBP)?${GAP}${CUE}`,
  "i",
);

/**
 * Did this answer state an actual decimal total in prose?
 *
 * A raw "✅ Executed on <connection>..." string is the tool's own ack for a
 * write the model made mid-turn. It always contains digits
 * (rowsAffected/lastInsertRowid), which false-positived the original bare
 * /\d/ check on a turn that never narrated anything — hence the explicit
 * rejection before any matching.
 */
export function hasNarratedDecimalTotal(answer) {
  const text = String(answer ?? "").trim();
  if (!text || /^✅\s*Executed on/i.test(text)) return false;
  return NARRATED_TOTAL.test(text);
}

// Vocabulary that counts as naming a stored/queried source for a figure.
//
// Round 9 (2026-08-13) failed the gate on this check alone, with the same
// defect shape as round 8's markdown bug one round earlier: a lexical test
// that punished valid phrasing. The old pattern was /sql|query|db_query/i and
// gemma4 answered
//
//   "...the final grand total, pulled directly from the `spending_summary`
//    database."
//
// naming the exact table it had just CREATEd, INSERTed into and SELECTed
// from — a concrete provenance claim, stronger than the bare word "query" —
// but never uttering "sql" or "query", so it scored false.
//
// Why widening is safe rather than a loosened gate: this predicate is only
// ever consumed ANDed with dbQueryReturnedRows for the SAME turn (see
// followUpCitesSql in the harness), so anything reaching it has already been
// proven to sit on a real db_query that came back with rows. The lexical half
// is not what stops a fabricated figure — dbQueryReturnedRows is. What this
// asks is the narrower question of whether the answer TOLD the user the
// number came from stored data instead of from the model's own arithmetic.
//
// Deliberately excluded: "saved", "stored", "recorded". Those describe the
// WRITE, not the read, so "the totals I saved earlier" would score true for
// an answer reciting from memory — exactly the failure mode the 2026-08-02
// gemma4 run exhibited.
const QUERY_PROVENANCE = /\b(?:sql|db_query|quer(?:y|ies|ied|ying)|databases?|tables?)\b/i;

/**
 * Did this answer attribute its figure to a queried/stored source?
 *
 * See QUERY_PROVENANCE for why this admits table/database attribution and not
 * merely SQL jargon, and why that stays sound.
 */
export function citesQueryProvenance(answer) {
  return QUERY_PROVENANCE.test(String(answer ?? ""));
}

/**
 * Did a db_query in this turn actually come back with rows? Calling db_query
 * proves nothing about what it returned — the 2026-08-02 gemma4 run queried
 * an empty table and then recited a remembered breakdown, which sailed
 * through every prose check until this gate was added.
 */
export function dbQueryReturnedRows(toolCalls) {
  return (toolCalls ?? []).some(call => {
    if (call.name !== "db_query") return false;
    const evidence = `${call.summary ?? ""} ${call.detail ?? ""}`;
    const rowCountMatch = evidence.match(/"rowCount"\s*:\s*(\d+)/);
    if (rowCountMatch) return Number(rowCountMatch[1]) > 0;
    // rowCount can fall outside the capped detail on a very wide result; a
    // non-empty rows array is equally good evidence.
    return /"rows"\s*:\s*\[\s*[{[]/.test(evidence);
  });
}
