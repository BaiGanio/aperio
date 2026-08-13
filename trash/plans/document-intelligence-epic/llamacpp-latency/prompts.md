# Provenance harness prompts (T-G2.3/T-G2.4)

Source: `document-intelligence-skill-harness.mjs`, `DOCINT_PHASE=provenance`. One
opening prompt, then up to 6 escalating follow-ups sent only until the model
produces an SQL-grounded answer with a narrated decimal total
(`followUpSatisfied`) — so a clean run can end well before turn 6, and a
struggling one uses all 7. Turn numbers below match the wall-time list quoted
in the epic's run logs (`479034 / 320714 / 89484 / 326829 / 600005 / 4004 /
4012 ms` for the 2026-08-13 T-L4.3 run).

## All prompts, in order

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
