# Provenance harness prompts (T-G2.3/T-G2.4)

Source: `document-intelligence-skill-harness.mjs`, `DOCINT_PHASE=provenance`.
Prompt text and tiers live in `provenance-ladder.mjs`, unit-tested by
`provenance-ladder.test.mjs`. One opening prompt, then up to 6 escalating
follow-ups sent only until the model produces an SQL-grounded answer with a
narrated decimal total (`followUpSatisfied`) — so a clean run can end well
before turn 6, and a struggling one uses all 7.

## Two ladders — `DOCINT_PROVENANCE_LADDER=mechanism|natural`

2026-08-13, developer critique while watching a live 3-model T-L4 run: the
ladder below (now called **mechanism**) escalates from a semi-natural
opening line to turns that dictate literal SQL syntax
("`SELECT category, currency, SUM(amount) GROUP BY category, currency`") —
not how a non-technical person talks to a personal memory assistant, at any
rung, not just the openly-dictated ones (even the opening line's "save the
results so I can **query** them again later" presupposes a DB mental model
most users don't have). That escalation is deliberate — each rung only gets
more explicit if the model hasn't complied yet, isolating "can't infer
intent" from "can't execute the mechanism when told exactly how" — and it's
exactly what surfaces real execution-mechanics bugs. But a pass earned only
once the prompt has spelled out the SQL is a much weaker claim about
real-world usefulness than a pass on an ask a normal person would actually
say.

Two ladders now exist side by side (`PROVENANCE_LADDERS` in
`provenance-ladder.mjs`):

- **`mechanism`** (default — unset `DOCINT_PROVENANCE_LADDER` behaves
  exactly as before, so every historical T-L4 result stays comparable) — the
  original escalation below, unchanged, for diagnosing execution-mechanics
  defects.
- **`natural`** — no "save/query/SUM/GROUP BY/SQL/database" vocabulary at
  any rung. Escalates only in insistence ("I don't think I got numbers
  yet"), never in technical specificity:
  1. *(opening)* "Can you keep track of what I spent on documented bills and
     receipts for June 2026, broken down by category, and tell me the
     total?"
  2. "What did I spend in each category, and altogether?"
  3. "Please check the figures you kept earlier and give me the breakdown
     and total."
  4. "I don't think I got numbers yet — can you pull up what you saved and
     tell me the breakdown and total?"
  5. "Just check what's already saved and tell me the total — you don't
     need to redo the math, just look it up."
  6. "Please just tell me: what's the total, and how much per category,
     based on what you already saved?"
  7. "One more time — I just want the breakdown and total from what you
     saved earlier, in plain words."

Grading (`gradePhase()`'s provenance branch) now records, regardless of
ladder: `successTurn` (the turn index that satisfied `followUpSatisfied`, or
`null`), `successPromptTier` (`opening` / `named-mechanism` / `dictated-sql`
on the mechanism ladder, always `natural` on the natural one), and
`capabilityClaim` — `mechanism-conformance` when the successful turn was a
`dictated-sql` rung, `realistic-usage` otherwise. **A mechanism-mode pass at
escalation turn 3+ is mechanism-conformance, not realistic usage** — read
`capabilityClaim` before trusting a `grading.status: "pass"` as evidence of
real-world behavior. `provenanceLadder` (the ladder name) is also written to
the run artifact for the record.

Both ladders share the same mechanics grading (`insertedRealRows`,
`dbQueryReturnedRealRows`, wall-clock ceilings, etc.) — only the prompt text
and the tier/capability-claim metadata differ. A live model run against the
natural ladder has not been done yet as of this writing — this redesign is
statically/unit-test validated only (`node --test
"trash/plans/document-intelligence-epic/llamacpp-latency/provenance-ladder.test.mjs"`
plus a `--setup-only` dry run for both ladder values); a live run is a
separate, deliberately deferred next step since it's expensive and stateful.

## Mechanism ladder — all prompts, in order

Turn numbers below match the wall-time list quoted in the epic's run logs
(`479034 / 320714 / 89484 / 326829 / 600005 / 4004 / 4012 ms` for the
2026-08-13 T-L4.3 run).

- **Turn 0 (opening):** "Add up everything I spent on documented bills and
  receipts for June 2026, broken down by category. Save the results so I can
  query them again later, and give me the total."
- **Turn 1 (follow-up 1):** "Now give me the category breakdown and the grand
  total you just saved — query it per category (SUM grouped by category and
  currency), not from your own arithmetic."
- **Turn 2 (follow-up 2):** "If the rows aren't in the table yet, finish
  saving them now (a single multi-row INSERT is fine — it's still one
  statement), then run the per-category SQL query and give me the breakdown
  and total."
- **Turn 3 (follow-up 3):** "The rows should be saved by now — run SELECT
  category, currency, SUM(amount) GROUP BY category, currency against the
  extraction table now and give me the resulting breakdown and total."
- **Turn 4 (follow-up 4):** "Run the per-category SQL query against the
  extraction table now and state the breakdown and total it returns, in your
  own words."
- **Turn 5 (follow-up 5):** "You already ran that query earlier in this
  conversation — just restate its breakdown and total in your own words now,
  without calling any more tools."
- **Turn 6 (follow-up 6):** "Answer now, in plain prose: what is the category
  breakdown and grand total from the extraction table you already queried?"

## Easiest — passed cleanly on the 2026-08-13 T-L4.3 run

- **Turn 0.** Honest, correctly-disclosed per-currency answer; no single
  blended grand total. `noFxBlend` passed on the first try.
- **Turn 1.** First real `db_execute` write landed as a genuine confirmed
  INSERT (`rowsAffected:1`) — no issues reported for this turn.

## Red — where the model failed / where real bugs were found

- **Turn 2 — the serious one.** "Finish saving them now" without being told
  to check existing state first. The model didn't run `db_query`/`db_schema`
  first — it inserted 12 new rows with fabricated placeholder hashes
  (`"hash1"`…`"hash12"`), invented category labels not present in any source
  document (`Rent`, `Subscriptions`, `Bills/Housing`), amount/original-string
  pairs shuffled across unrelated documents, and 2 of the 3 explicitly
  excluded EUR travel receipts reclassified as legitimate categorized
  spending. Confabulated financial data written as if genuine, not just a
  wasteful duplicate. This is the turn the SKILL.md fix committed this
  session (verify-before-re-save) targets directly. Same turn also showed the
  12 rows going in as 12 separate single-row confirms instead of one
  multi-row `INSERT`, despite the prompt and SKILL.md §5 both already saying
  a multi-row statement is fine.
- **Turn 3.** Closing line ("The total documented spending for June 2026 is
  696.84 BGN and 196.40 EUR") failed `fullMonthGate` — joining two
  per-currency totals with "and" is not the same as the explicit
  non-conversion disclosure sentence SKILL.md §6 requires. A real, deserved
  grader failure, not a grader bug — separate from the four save/insert
  issues above.
- **Turn 4.** Queried `SUM(amount) ... FROM spending_june_2026`, but the
  model's own `CREATE TABLE` (and its own `db_schema` call earlier in this
  same turn) named the column `amount_normalized`, not `amount`. The failed
  query then ran into the 600s hard per-turn timeout with no retry.
- **Turns 5–6.** Empty answers — cascading fallout from turn 4's timeout
  (the known "broken connection after hard timeout" pattern), not failures
  of these prompts on their own merits.
