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

/**
 * Every row a db_query in these tool calls came back with, as objects.
 *
 * The driver returns row objects keyed by column name (see
 * lib/db-connect/drivers/sqlite.js: `columns = Object.keys(rows[0])`), and the
 * harness records the tool's `detail` payload verbatim — but capped at
 * DETAIL_CAP=2000 chars by lib/agent/toolActivity.js, with a trailing "…". So
 * JSON.parse succeeds on a typical aggregate result and fails on a wide one,
 * and a grader that only did the former would go silently blind exactly on the
 * runs with the most rows. The fallback salvages the complete row objects and
 * drops only the one the cap cut in half.
 */
export function queriedRows(toolCalls) {
  const rows = [];
  for (const call of toolCalls ?? []) {
    if (call.name !== "db_query") continue;
    const detail = String(call.detail ?? "");
    if (!detail) continue;
    try {
      const parsed = JSON.parse(detail);
      if (Array.isArray(parsed?.rows)) { rows.push(...parsed.rows.filter(isPlainObject)); continue; }
    } catch { /* capped mid-JSON — salvage below */ }
    rows.push(...salvageRowObjects(detail));
  }
  return rows;
}

const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Complete `{...}` objects after the `"rows"` key, brace-matched so a nested
 *  object cannot end the scan early and a truncated tail is simply skipped. */
function salvageRowObjects(detail) {
  const start = detail.indexOf('"rows"');
  if (start === -1) return [];
  const out = [];
  let depth = 0, from = -1, inString = false, escaped = false;
  for (let i = start; i < detail.length; i++) {
    const ch = detail[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { if (depth === 0) from = i; depth++; continue; }
    if (ch === "}" && depth > 0) {
      depth--;
      if (depth !== 0) continue;
      try {
        const parsed = JSON.parse(detail.slice(from, i + 1));
        if (isPlainObject(parsed)) out.push(parsed);
      } catch { /* not a row object */ }
    }
  }
  return out;
}

/**
 * Foreign-currency rows the run wrote whose category names nothing the corpus
 * assigns to that currency's documents.
 *
 * Structural, not prose: this reads the row objects a db_query came back with,
 * so it asks what the model actually persisted rather than how it worded a
 * table. That matters here specifically — three of this gate's checks are
 * substring tests over free prose and two produced run-invalidating false
 * negatives in consecutive rounds (see tech-debt.md, "the pattern is the real
 * finding"), so a fourth prose predicate was the wrong way to grade this.
 *
 * `expectedCategories` comes from the oracle (buildExpectations().otherCurrencies),
 * and the test is containment rather than equality: the corpus assigns all three
 * June EUR documents to "Travel", so `Travel-Other` and `Travel/Lodging` name it
 * and pass, while `Uncategorized` — the deterministic pipeline's own bucket for
 * a charge it could not classify (lib/docgraph/facts/aggregate.js) — does not.
 *
 * Vacuous when the run wrote no foreign-currency row and when a row carries no
 * category-ish column: this reports what it can see, and inventing a verdict
 * from an absent column is how the prose predicates above went wrong.
 */
export function unresolvedForeignCurrencyRows(rows, otherCurrencies = {}) {
  const expected = new Map(Object.entries(otherCurrencies)
    .map(([currency, entry]) => [currency.toUpperCase(), (entry?.categories ?? []).map(c => c.toLowerCase())]));
  if (expected.size === 0) return [];

  const unresolved = [];
  for (const row of rows) {
    const entries = Object.entries(row).filter(([, value]) => typeof value === "string");
    const currency = entries.map(([, value]) => value.trim().toUpperCase()).find(value => expected.has(value));
    if (!currency) continue;
    const categoryEntry = entries.find(([key]) => /categ/i.test(key));
    if (!categoryEntry) continue;
    const category = categoryEntry[1].trim();
    const names = expected.get(currency);
    if (names.length === 0) continue;
    if (names.some(name => category.toLowerCase().includes(name))) continue;
    unresolved.push({ currency, category, row });
  }
  return unresolved;
}
