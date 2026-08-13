// Pure logic for the T-G2.3 provenance harness's prompt ladders and
// success/capability grading. Split out from document-intelligence-skill-
// harness.mjs (which boots a real server and WS connection at import time)
// so this part is unit-testable without spinning anything up — see
// provenance-ladder.test.mjs.
//
// Background (2026-08-13, developer critique while watching a live 3-model
// T-L4 run): the original "provenance" ladder escalates from a semi-natural
// opening line to turns that dictate literal SQL syntax
// ("SELECT category, currency, SUM(amount) GROUP BY category, currency").
// That's deliberate — each rung gets more explicit only if the model hasn't
// complied yet, to isolate "can't infer intent" from "can't execute the
// mechanism even when told exactly how" — and it's genuinely useful for
// finding execution-mechanics bugs. But a pass earned only once the prompt
// has spelled out the SQL is a much weaker claim about real-world
// usefulness than a pass on an ask a non-technical person would actually
// say. Two ladders now exist side by side:
//
//   mechanism — the original escalation, unchanged, still the default (so
//               existing/future runs without DOCINT_PROVENANCE_LADDER set
//               stay comparable to every prior T-L4 result).
//   natural   — no "save/query/SUM/GROUP BY/SQL/database" vocabulary at any
//               rung; escalates only in insistence ("I don't think I got
//               numbers yet"), never in technical specificity.
//
// Every ladder entry carries a `tier` used to label what a pass on it
// actually claims:
//   opening          — the ladder's first turn.
//   named-mechanism  — names a mechanism (INSERT, SUM/GROUP BY) without
//                       dictating literal SQL syntax.
//   dictated-sql     — hands the model a literal SQL statement to run.
//   natural          — plain language, no technical vocabulary at all.

export const PROVENANCE_LADDERS = {
  mechanism: [
    {
      tier: "opening",
      text: "Add up everything I spent on documented bills and receipts for June 2026, broken down by category. Save the results so I can query them again later, and give me the total.",
    },
    {
      tier: "named-mechanism",
      text: "Now give me the category breakdown and the grand total you just saved — query it per category (SUM grouped by category and currency), not from your own arithmetic.",
    },
    {
      tier: "named-mechanism",
      text: "If the rows aren't in the table yet, finish saving them now (a single multi-row INSERT is fine — it's still one statement), then run the per-category SQL query and give me the breakdown and total.",
    },
    {
      tier: "dictated-sql",
      text: "The rows should be saved by now — run SELECT category, currency, SUM(amount) GROUP BY category, currency against the extraction table now and give me the resulting breakdown and total.",
    },
    {
      tier: "dictated-sql",
      text: "Run the per-category SQL query against the extraction table now and state the breakdown and total it returns, in your own words.",
    },
    {
      tier: "dictated-sql",
      text: "You already ran that query earlier in this conversation — just restate its breakdown and total in your own words now, without calling any more tools.",
    },
    {
      tier: "dictated-sql",
      text: "Answer now, in plain prose: what is the category breakdown and grand total from the extraction table you already queried?",
    },
  ],
  natural: [
    {
      tier: "natural",
      text: "Can you keep track of what I spent on documented bills and receipts for June 2026, broken down by category, and tell me the total?",
    },
    {
      tier: "natural",
      text: "What did I spend in each category, and altogether?",
    },
    {
      tier: "natural",
      text: "Please check the figures you kept earlier and give me the breakdown and total.",
    },
    {
      tier: "natural",
      text: "I don't think I got numbers yet — can you pull up what you saved and tell me the breakdown and total?",
    },
    {
      tier: "natural",
      text: "Just check what's already saved and tell me the total — you don't need to redo the math, just look it up.",
    },
    {
      tier: "natural",
      text: "Please just tell me: what's the total, and how much per category, based on what you already saved?",
    },
    {
      tier: "natural",
      text: "One more time — I just want the breakdown and total from what you saved earlier, in plain words.",
    },
  ],
};

export const DEFAULT_PROVENANCE_LADDER = "mechanism";

// Throws on an unrecognized value rather than silently falling back — a
// typo'd env var should fail loudly, not quietly run the default ladder
// under a different name in the recorded artifact.
export function resolveLadder(rawEnvValue) {
  const name = (rawEnvValue ?? DEFAULT_PROVENANCE_LADDER).trim().toLowerCase();
  const entries = PROVENANCE_LADDERS[name];
  if (!entries) {
    throw new Error(
      `DOCINT_PROVENANCE_LADDER must be one of ${Object.keys(PROVENANCE_LADDERS).join("|")} (got "${rawEnvValue}")`,
    );
  }
  return { name, entries };
}

// A pass earned via a "dictated-sql" rung is instruction-following under an
// explicit, unrealistic prompt — a mechanism-conformance result, not
// evidence the model would behave this way for a real user. Every other
// tier (including the mechanism ladder's own "opening"/"named-mechanism"
// rungs, which are close to natural but not fully — see the tech-debt note
// this module resolves) is treated as a realistic-usage claim; the natural
// ladder never produces a "dictated-sql" tier at all.
export function capabilityClaimForTier(tier) {
  return tier === "dictated-sql" ? "mechanism-conformance" : "realistic-usage";
}

// Mirrors the harness's own `followUpSatisfied` stop condition exactly
// (completed status, a db_query that actually returned rows, a narrated
// decimal total) so successTurn always reflects the turn that stopped the
// escalation loop, not a re-derived approximation of it. Callers inject the
// two grading predicates (dbQueryReturnedRows/hasNarratedDecimalTotal)
// rather than importing them here, to avoid this pure module depending on
// the harness's own tool-result-shape assumptions.
export function computeProvenanceSuccess({ results, ladderEntries, dbQueryReturnedRows, hasNarratedDecimalTotal }) {
  const last = results.at(-1);
  const satisfied = Boolean(
    last &&
    last.status === "completed" &&
    (last.toolSequence ?? []).includes("db_query") &&
    dbQueryReturnedRows(last.toolCalls) &&
    hasNarratedDecimalTotal(last.answerRaw),
  );
  if (!satisfied) return { successTurn: null, successPromptTier: null, capabilityClaim: null };
  const successTurn = results.length - 1;
  const successPromptTier = ladderEntries[successTurn]?.tier ?? null;
  return {
    successTurn,
    successPromptTier,
    capabilityClaim: successPromptTier ? capabilityClaimForTier(successPromptTier) : null,
  };
}
