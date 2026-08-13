# Known Tech Debt

Two kinds of entry live here. **Running Code Depth** (below) is the live log of what we hit
while working and what is still hanging or unfixed — dated, grouped by topic, deleted the
moment it is fixed or promoted to an issue/plan; it mirrors the `A2D.md` convention. The
**curated tables** further down are intentional, long-lived deferrals and
investigated-and-rejected findings — do not "fix" those without discussion.

Code depth only — what we hit, what is still broken. Suggestions, recommendations, and
housekeeping go in `A2D.md`, not here.

## Running Code Depth

> **Convention (mirrors `A2D.md`):** topic-headers with dated lines under them. An entry is
> deleted immediately once it is fixed or promoted to a GitHub issue or a plan — this is a
> live worklist, never a graveyard. The dates are how we tell what is what.

### Format

```markdown
## <Topic / Area>

- <YYYY-MM-DD> <what we hit / what's hanging> — <impact or why it's unfixed>
```

<!-- Add topic sections below as they come up (e.g. ## Codegraph, ## Migrations, ## Providers). -->

## Docgraph — document facts (#250)

- 2026-08-01 `composeMemoryFromDoc()` (`lib/docgraph/retrieval.js:400`) picks a
  memory's period as **service period > invoice date > due date**, the opposite
  of the corpus policy — a June-issued bill for May consumption is promoted as
  "summary — 2026-05". Harmless while `DOCGRAPH_AUTO_MEMORY` is off; must be
  re-pointed at `resolveAssignmentDate()` (`lib/docgraph/facts/contract.js`),
  which now owns period assignment and gets this right, before the bridge is
  ever enabled by default.
- 2026-08-01 **Image-only receipts still contribute nothing.** PNG receipts
  yield `no_text` and are recovered only when a bank-statement row happens to
  cover them. All nine corpus months now reconcile exactly, but that is because
  every image-only receipt in this corpus has a statement row or a `.txt`
  sibling; a household whose receipts are photos only would come up short. The
  deterministic path needs a provider-neutral native-vision seam to close this
  properly: cloud-capable models must remain supported; a vision-capable local
  model (for example Gemma 4) should receive the image directly, while a
  text-only local model (for example Qwen, Ornith, or Phi-4) should route
  through the configured VLM. The extraction result must be structured,
  uncertainty-aware, and never silently treated as deterministic text.

---

## Tool profiles / schema budgeting

- 2026-08-02 `capToolsForWindow` **`break`s** on the first tool that overflows the
  `0.20 × contextWindow` budget rather than skipping it
  (`lib/agent/tool-profiles.js:125-134`), so an over-budget profile is truncated
  mid-set with only a `logger.info` (`lib/agent/index.js:239`). Benign for
  read-only profiles; becomes a correctness problem for any future tool group
  where a partial set is worse than none. Tracked as a decision in #354.
- 2026-08-13 **Root-caused the llamacpp-multiturn-latency cache-reuse gap
  (T-L4, `trash/plans/document-intelligence-epic/llamacpp-latency/`), not yet
  fixed.** A live WS2 T-G2.3 run with a new request-fingerprint hash
  (`APERIO_LOG_CACHE_FINGERPRINT=on`, `lib/agent/providers/llamacpp.js`) plus
  llama-server's own slot-selection log confirmed: the attached tool-schema
  *count* changes turn to turn (38→40→38 across one 7-turn conversation) even
  when `ensureTurn`'s logged `profiles=[...]` label list is byte-identical —
  almost certainly the sticky-pin "carry forward" logic (`f1377b1e`) adding a
  newly-invoked tool (e.g. `db_query`) into the schema set for later turns.
  Because llama.cpp's Jinja tool-calling templates render the tools block near
  the very front of the prompt, any such shift collapses `sim_best` from
  ~0.99 to ~0.2-0.3 (`f_keep` ~0.18-0.2 — an 80%+ KV-cache loss), forcing a
  near-total reprocess of the whole growing conversation (30K+ tokens,
  150-210s at this hardware's throughput) on that turn alone. This is the
  dominant mechanism behind the multi-minute turn latencies chased throughout
  this epic — not a mystery `cache_n=0`, a specific and reproducible cause.
  Needs: either stop `capToolsForProvider`/the carry-forward fold from
  changing the resolved tool SET once a conversation is underway (pin harder
  than today's within-turn pin), or move the tools block to a position in the
  request the template renders after the stable conversation prefix (template-
  dependent, may not be controllable from the request side at all).
  **Mitigated, not fixed, 2026-08-13**: `APERIO_TOOL_PIN_TURNS` default
  raised 3→8 (`lib/agent/tool-profiles.js`'s `parsePinTurns`), so the reset
  that busts the cache fires far less often in a typical conversation.
  Growth is still bounded independently by `capToolsForWindow`'s own 20%
  schema-token budget (and small-window tool-count cap), which apply every
  turn regardless of the pin count — confirmed by reading the code, not
  just inferred. The underlying mechanism (a periodic reset that changes the
  schema set at all) is unchanged and will still bust the cache when it
  fires; going with either of the two directions above (monotonic pin with
  no timeout, or template-side tools-block relocation) was deliberately not
  attempted this session — both are real design reversals to a heavily
  P2-reviewed shared module (`lib/agent/turn-planner.js`), decided against
  in favor of the lower-risk tunable change pending a live re-run.
  **Directional live evidence, 2026-08-13 (not a full validation):** a
  same-day 3-model re-run (gemma4-E4B, gemma-4-26B-A4B, Ornith-1.0-9B; see
  "Cross-model T-L4 run" in the open-issues file) showed the identical
  pattern in all three: fingerprint count starts at 38, swings to 40 once at
  the turn-0→1 boundary, then **holds at 40 with no reversion** through
  every steady-state productive turn — unlike T-L4.3's pre-fix 38→40→38
  oscillation across 7 turns. None of the three runs reached enough natural
  turns to exceed an 8-turn pin window and exercise a second reset, so this
  does not prove the fix scales to longer conversations, but it is
  consistent with fewer resets. Separately, once gemma-4-26B-A4B's turn-1
  600s hard-timeout triggered its empty-turn cascade, the fingerprint
  resumed oscillating (40→38→40 across consecutive ~4s turns) — a different
  regime (post-timeout breakdown), not evidence against the mitigation in
  its intended steady-state use.

---

## Terminal — session summaries

- 2026-08-04 `appendSummary`'s `messageCount: messages.length - 1`
  (`lib/helpers/sessions.js:454`) still hardcodes "drop index 0 as the
  internal greeting", the same wrong assumption `finaliseSession` had until
  today's fix — a fresh (never resumed/branched) session's summary undercounts
  by one real message. Cosmetic only: `messageCount` just feeds the "N
  messages" line in the session-summary UI (`public/scripts/sessions.js`,
  `chat.js`). Not fixed here because `appendSummary`'s 3 call sites
  (`lib/emitters/handlers/ws/summarize.js`, `lib/terminal/standalone.js` ×2)
  would each need the same `firstMessageSynthetic` flag threaded in for a
  display-only off-by-one.

---

## Document Intelligence — cold-start template proposals (#250)

- 2026-08-02 **`inferTemplateProposal()`'s `match_keywords` heuristic is crude
  and unvalidated against real bill diversity.** (`lib/handlers/extraction/extractHandlers.js`)
  When a document matches no known template, the proposed template's
  `match_keywords` come from `matchHandlers.significantWords()` — the top
  8 most-frequent Unicode-letter words (length ≥ 4) anywhere in the document
  text. This is a deliberate, documented deviation from the WS3 plan, which
  never specified a concrete heuristic; the design choice itself (picking
  literal document words over the field's own English role names) is sound
  and language-agnostic, evidenced only by the T-G4.3 synthetic-text tests in
  `tests/integration/handlers/extraction/extractionHandlers.test.js` — never
  against the real household-gen corpus or any real bill. Known weaknesses:
  (1) no distinction between a distinctive issuer name and generic boilerplate
  words ("invoice", "total", "payment") that would appear on every bill from
  every provider, so two DIFFERENT providers' bills could plausibly propose
  near-identical keyword sets and collide in `matchTemplates`' ranking; (2) no
  weighting toward header/title lines, where an issuer name is most likely to
  live, vs. the body; (3) untested on scanned/OCR'd text, which is noisier
  than the clean synthetic snippets used here. Needs real-corpus evidence
  (ideally household-gen bills from several distinct providers) before this
  heuristic can be trusted for genuine cold-start learning rather than just
  passing its own unit tests.

---

## Skill matching — a workflow skill does not survive its own follow-up turns (#250)

- 2026-08-13 **Root cause of the WS2 T-G2.3 turn-2 zero-tool-call failure, found
  statically — the `document-intelligence` skill is NOT in the system prompt on any
  follow-up turn of the provenance ladder.** Established without a live run, by
  running the real matcher (`loadSkillIndex` + `matchSkills`, no server, no DB)
  over the five literal ladder prompts:
  - turn 0 (main prompt) → `document-intelligence` ✔
  - turn 1 ("query it per category") → **no skill** (docint scores 4, the highest of
    any skill, but `qualifies=false`)
  - turn 2 ("finish saving them now… a single multi-row INSERT is fine" — the turn
    that has now failed identically in rounds 1, 3 and the round-2 re-re-run) →
    **`reasoning-planning` only** (score 2, kw 1); docint again scores 4,
    `qualifies=false`
  - turn 3 → no skill; turn 4 → `memory-protocol`
  The gate is `scoreSkill`'s `qualifies = kwRaw ? matchedEntries.length > 0 : true`
  (`lib/workers/skills/matching.js:118`): a skill that declares curated keywords is
  dropped unless one of those literal phrases appears, no matter how high its
  description-prose score. `document-intelligence`'s keyword list is entirely
  first-turn discovery phrasing ("how much did I spend", "spend on utilities", …);
  no follow-up vocabulary ("finish saving", "run the per-category SQL query", "the
  rows", "INSERT", "extraction table") is in it. Skills are matched per turn from
  the current message only and never carried forward — a deliberate fix for stale
  skills attaching to unrelated follow-ups (`lib/agent/turn-planner.js:364-372`) —
  and the harness never forces a skill (forcing only comes from `/skill` or the UI
  Skills panel), so nothing re-attaches it. Consequences, all previously
  misattributed to the model:
  - **Every SKILL.md §5 wording iteration from rounds 1-3 was written into a
    document that is not in context on the turn it targets.** "The bullet failed its
    first live test" is not evidence about the wording; the bullet was absent.
  - Turn 2's raw completion (recovered from `var/sessions/`, which survives the
    SIGTERM the harness answers JSON does not) is a **verbatim instance of
    `reasoning-planning`'s "Output Format" block** — `Problem:/Unknowns:/Approach:/
    Plan:/Edge cases:` — ending "I will now propose the writes." The model followed
    the only skill it was given, which asks for a plan as visible text; text with no
    tool call ends the turn. Not prose hedging, not a tool-call-emission ceiling.
  - The same holds for the §6 findings: Ornith-1.0-9B's undisclosed BGN+EUR blend
    and its excluded-travel-receipt leak both happened on turn 2 — with §6 and the
    exclusion guidance out of context. "Prose has a ceiling here" rests on a false
    premise and should not be treated as evidence.
  - Secondary effect: the injected skill block sits in the system prompt
    (`lib/agent/index.js:295-309`), so the prompt prefix changes shape on **every**
    turn of these runs (big docint block → nothing → reasoning-planning). That is a
    front-of-prompt change independent of the 38↔40 tool-count swing, and a second
    contributor to the cache-reuse gap logged above.
  Not fixed — the fix is a design decision (sticky skills for a multi-turn workflow,
  mirroring the existing tool-profile pin, vs. keyword patching vs. harness-side
  forcing) and is the developer's call.

---

## Document Intelligence — save/insert mechanics on gemma4 (#250)

> **2026-08-13, read first:** the premise under most of this section is now in
> doubt — see the skill-matching entry above. `document-intelligence` is absent
> from the system prompt on every follow-up turn of the provenance ladder, so the
> SKILL.md wording these entries call "unvalidated" or "failed" was never actually
> in context when it was judged. Re-test before drawing conclusions from any
> per-bullet verdict below.

Gemma 4 E4B's own SKILL.md-adherence gaps in the propose→confirm write flow,
found live on the 2026-08-13 T-L4.3 WS2 provenance run (harness-level grading
bugs from the same run are fixed, not listed here — see
`trash/plans/document-intelligence-epic/document-intelligence-ws2-tg23-open-issues.md`).
**SKILL.md wording landed for all three 2026-08-13** (verify-existing-state
bullet + strengthened per-row-INSERT bullet + query-columns-from-own-schema
bullet, `skills/document-intelligence/SKILL.md` §5 and Gotchas). **Re-run
same day (see "Cross-model T-L4 run" in the open-issues file) — still not a
clean T-G2.3 pass, but a partial re-validation on gemma4-E4B before the
developer stopped that run at turn 2:** keep this entry until a run
completes cleanly, but see per-bullet updates below — the picture is more
nuanced than "unvalidated" now.

- 2026-08-13 **Hallucinated re-insertion on a second save attempt.** Told
  (follow-up prompt: "if the rows aren't in the table yet, finish saving them
  now"), the model did not check what was already saved via `db_query` first
  — it inserted 12 new rows with **fabricated placeholder hashes**
  (`"hash1"`…`"hash12"` instead of real `sha256` values), **invented category
  labels never present in the source documents** (`Rent`, `Subscriptions`,
  `Bills/Housing` — the real categories are Utilities/Fuel/Groceries/
  Transport/Internet), **systematically mismatched `amount_normalized` vs
  `original_amount_string` pairs** (e.g. amount `95.6` paired with original
  string `"29.99"` — two different real documents' values shuffled together),
  and **reclassified two of the three explicitly-excluded EUR travel
  receipts as legitimate categorized spending** (the Munich train receipt as
  `Subscriptions`, the Berlin hotel as `Bills/Housing`) — the exact exclusion
  the fixture tests for. This is worse than a wasteful duplicate: it writes
  confabulated financial data into the user's real database as if genuine.
  SKILL.md §5 now tells the model to verify existing state via
  `db_query`/`db_schema` before a second save attempt (landed 2026-08-13).
  **Still unvalidated as of the same-day re-run**: that run's INSERT never
  succeeded (see the params/VALUES-mismatch bullet below), so the model
  never reached a *second* save attempt on already-populated data — the
  specific scenario this bullet targets never got a chance to occur, pass or
  fail. Needs a run where turn 2's INSERT actually lands before this can be
  called validated either way.
- 2026-08-13 **Per-row INSERT despite explicit multi-row guidance.** The same
  12-row batch above was issued as 12 separate single-row `db_execute`
  confirms, not the one multi-row `INSERT ... VALUES (...), (...), ...`
  SKILL.md §5 already explicitly requires — even though the follow-up prompt
  itself said "a single multi-row INSERT is fine — it's still one statement."
  Confirms this is a live, reproducible gap, not a stale/already-fixed one.
  SKILL.md §5's bullet strengthened 2026-08-13 with the concrete cache-reprocess
  cost of an extra turn (known since the same T-L4.3 run's cache-reuse
  root-cause) as the "why," and an explicit "prompt permission is not license
  to still do it per row" line. **Partially validated by the same-day
  re-run, in a genuinely useful way**: on the exact same follow-up prompt
  ("finish saving them now... a single multi-row INSERT is fine"), gemma4-E4B
  correctly attempted **one** multi-row `INSERT` on all 3 retries — never
  fell back to per-row confirms. But the statement itself was structurally
  broken every time: a `VALUES (?,?,?,?,?,?,?)` clause with only one
  7-placeholder tuple, while `params` held all rows flattened (65, then 91,
  then a nested array of 13 seven-element tuples) — the model kept changing
  the *params* shape without ever adding the missing `VALUES (...), (...),
  ...` tuples to the *SQL text*. So the per-row habit this bullet targets
  does look fixed; it just uncovered a different, new structural bug in
  building a matching multi-row `VALUES`/`params` pair. New tech debt, not
  covered by any existing SKILL.md wording — needs its own guidance (or a
  worked example) on keeping tuple count in the SQL text and the flattened
  params array in sync. Run was stopped by the developer mid-3rd-retry, so
  it's unknown whether a 4th attempt would have self-corrected.
- 2026-08-13 **Wrong column name in the model's own follow-up query.** Turn 4
  ran `SELECT ... SUM(amount) ... FROM spending_june_2026`, but the model's
  own `CREATE TABLE` (confirmed two turns earlier, and re-confirmed via its
  own `db_schema` call in this same turn) named the column
  `amount_normalized`, not `amount`. The failed query then ran into the
  600s per-turn hard timeout with no retry, cascading into two more turns of
  empty answers — the same "broken connection after hard timeout" pattern
  documented from earlier runs. SKILL.md Gotchas now tells the model to
  re-read its own `db_schema` result's exact column names into the query
  rather than retyping from recall (landed 2026-08-13). **Consistent with
  the fix on the one case the same-day re-run exercised**: gemma4-E4B's
  turn-1 `db_query` used `SUM(normalized_amount)`, matching the exact column
  name from its own turn-0 `CREATE TABLE` — no mismatch this run. One data
  point only, and not the scenario the original bug hit (that was a later
  turn, after a `db_schema` re-confirm and a hard-timeout retry), so this
  stays open rather than closing, but it's a genuine positive signal, not
  silence.
- 2026-08-13 **New: multi-row `INSERT` structural mismatch (gemma4-E4B),
  found on the same-day re-run.** See the per-row-INSERT bullet above for
  the full detail — logged here as its own line since it's a distinct root
  cause (SQL-text/params-shape sync, not a per-row-vs-multi-row habit).
  **SKILL.md worked example landed same day** (§5, after the
  `params`-must-match-placeholder-count bullet): explains one `VALUES`
  tuple per row, one flat `params` array of rows×columns, and states the
  fix directly ("add tuples to `VALUES`, don't reshape `params`") against
  the exact three-retry failure sequence from this run. **Unvalidated —
  needs a live re-run reaching this same turn** before this line can be
  removed.
- 2026-08-13 **New: gemma-4-26B-A4B total non-engagement on turn 1** (a
  different, larger model than the gemma4-E4B this section is otherwise
  about — logged here since it's the same propose→confirm write flow).
  Turn 0 completed normally (`CREATE TABLE`, no `IF NOT EXISTS` guard,
  confirmed). Turn 1 (the same "query it per category" follow-up gemma4-E4B
  answered normally) instead ran the full 600,047ms per-turn hard timeout
  with **zero tool calls and zero output/thinking tokens** — no partial
  answer, no attempted tool call, nothing. Triggered the known
  "broken-connection-after-hard-timeout" cascade for the rest of the run
  (empty ~4s turns, one stray re-read of an already-read document, an
  unexplained `shell` tool-profile addition). Not seen on any gemma4-E4B run
  to date. Unknown whether this is 26B-A4B-specific (different chat
  template/adapter routing — this build uses `adapter="gemma"` same as E4B,
  so the difference is more likely something about the larger model's own
  behavior on this prompt) or a one-off fluke; needs a repeat run before
  concluding either way. Not investigated further this session.
- 2026-08-13 **New: Ornith-1.0-9B — clean save→query→narrate mechanics, but
  an undisclosed currency blend and an excluded-document leak** (a different
  model family from gemma4, logged here for the same reason as 26B-A4B
  above). This run is the closest any local model has gotten to a clean
  T-G2.3 pass: a genuine single multi-row `INSERT` (13 rows, no
  params/VALUES mismatch — the exact bug gemma4-E4B hit), a real `db_query`
  returning real rows, and a final answer that correctly narrates a table
  built from the query result. Two real, deserved failures on top of that
  clean mechanism: (1) an undisclosed blended total, `**Grand total:
  893.24** (696.84 BGN + 196.40 EUR)` — the exact pattern SKILL.md §6 exists
  to prevent; (2) the fixture's explicitly-excluded Munich train receipt
  (49.90 EUR) counted as legitimate spending (`EUR | Transport | 49.90`) —
  smaller in scope than gemma4-E4B's T-L4.3 reclassification of 2 of 3
  excluded receipts, but the same category of bug. Neither of these is one
  of the three original gemma4-targeted SKILL.md gaps; both are about
  scope/disclosure discipline on an otherwise-working provenance flow, and
  apply to §6 (no-blend) and the exclusion-handling guidance rather than §5
  (save/insert mechanics).
  **Notable and worth flagging, not just fixing: both failures happened
  against guidance that already named this exact scenario.** §6 already
  contained this run's own numbers verbatim as a labeled anti-example
  ("Overall Grand Total: 893.24 (696.84 BGN + 196.40 EUR) is a failure",
  landed that same morning in `195f39cc`, before this run) — the numbers
  match because the fixture corpus is deterministic, not because the
  wording was written after seeing this run. The Gotchas section already
  said "EUR travel receipts saved into `Transport`/`Dining` alongside
  domestic BGN spending" was a recorded false positive. Wording this
  specific still didn't stop Ornith from doing exactly that — real evidence
  that prose alone has a ceiling here, not proof positive but a second
  data point after gemma4-E4B's own gaps.
  **SKILL.md landed this session (chore/docint-skill-correction... branch,
  uncommitted as of this entry):** §6 gained an explicit pre-send self-check
  imperative ("before you send the final answer, re-read every line for two
  amounts in different currencies added into one figure") — a procedural
  checklist framing rather than more explanation, since the explanation was
  already maximal. Gotchas gained a new, separate bullet giving the actual
  discriminating test for travel spending ("is this the user's own money"
  isn't enough — a train ticket really is the user's money; the test is
  document kind + away-from-home destination) and explicitly distinguishing
  it from a legitimate foreign-currency purchase, which stays in its own
  per-currency total per §6 rather than being excluded. **Unvalidated —
  given the ceiling already observed once, this needs a live re-run before
  trusting the new wording, more than the other three items in this
  section.**
- 2026-08-13 **New, same-day re-re-run: gemma4-E4B failed all three of its
  first turns and was stopped by the developer before completion** (not the
  same run as the "Cross-model T-L4 run" above — a later, separate attempt
  the same day, after the currency/travel-exclusion SKILL.md edits landed).
  Turn 0 (main prompt, explicit "save the results so I can query them again
  later") called **zero** `db_execute` — not even a `CREATE TABLE`, worse
  than every prior mechanism-ladder run, which always attempted at least
  table creation on turn 0. Turn 1 then issued a `db_query` against a table
  name it invented on the spot, **before ever calling `db_schema` or
  creating anything** — the query's own error ("no connection named
  extraction") was the only thing that told the model nothing existed yet;
  it then created the table (still no `INSERT`). Turn 2 — the exact turn
  handed explicit "a single multi-row INSERT is fine" permission, the one
  today's worked-example fix targets — produced **zero tool calls**, only
  52 seconds of prose, and the next turn reverted to re-reading a source
  document instead of inserting. Developer's verdict: three consecutive
  turn failures is a clean fail; today's actual VALUES/params fix was never
  exercised because the model never attempted an `INSERT` at all this run.
  **SKILL.md gained two new §5 bullets same session**: verify
  `db_schema`/a prior confirmed `CREATE TABLE` before the *first*
  `db_query`/write in a conversation (not just before a *second* save
  attempt, which the existing bullet already covered), and an explicit
  "describing a save is not doing it — the turn must contain the
  `db_execute` call itself" bullet. Both unvalidated — no re-run yet.
  **A real code bug was also root-caused and fixed this session, not just a
  SKILL.md gap**: turn 2→3's tool-schema fingerprint reverted 40→38, and the
  `[tools] turn=N profiles=[...]` log showed turn 3 gaining an unexplained
  `shell` profile — the same anomaly flagged as unexplained in T-L4.2 and
  this morning's 26B-A4B run. Root cause: `classifyProfiles()`
  (`lib/agent/tool-profiles.js`) matches a bare `\brun\b` for its `shell`
  profile trigger, and follow-up 3's own scripted text ("run SELECT
  category, currency, SUM(amount) GROUP BY category, currency against the
  extraction table") contains "run" as ordinary SQL language, not a shell
  request — docGraph intent already had a narrowing guard against this
  exact false-positive class (line ~483), database intent did not. Fixed by
  extending the same narrowing to database intent: `shell` is now dropped
  for database-intent text unless a stronger, unambiguous shell/QA signal
  (command/terminal/render/grep/libreoffice/soffice/pdftoppm/thumbnail/
  pptx/slide/slides/presentation/powerpoint/deck/xlsx/spreadsheet) is also
  present. 3 new regression tests added
  (`tests/unit/agent/tool-profiles.test.js`); full unit suite (2627 tests)
  green. This is a real, evidenced contributor to the broader "Tool
  profiles / schema budgeting" cache-reuse gap above — a spurious profile
  addition is exactly the mechanism that busts llama-server's prefix cache
  — though it is very unlikely to be the *only* cause of that gap (the
  38↔40 fingerprint swing at the turn-0→1 boundary predates this specific
  trigger and needs its own explanation). **Re-validated live same evening,
  round 3 (below) — the SKILL.md bullet failed to change the outcome; the
  classifyProfiles fix was not exercised (run killed before turn 2→3).**
- 2026-08-13 **Round 3 re-run, same evening: turn 2's zero-tool-call failure
  recurred immediately, on the very first live test of the bullet written to
  fix it.** Command/ceilings identical to every T-L4 run this session. Turn 0:
  `doc_batch` → `db_connections` (checked existing state first, the intended
  effect of an earlier bullet) → `db_execute CREATE TABLE monthly_spending`,
  confirmed, no INSERT — the ordinary mechanism-ladder shape, not the
  zero-`db_execute` worst case from the run above. Turn 1: a real `db_query`
  against the exact table/column names from its own turn-0 `CREATE TABLE`
  (`SELECT category, currency, SUM(amount_normalized)... FROM
  monthly_spending`), correctly returned near-empty (table still has no rows)
  — the known "correct query, empty table" pattern, not a new bug. **Turn 2**
  (the follow-up handing explicit "a single multi-row INSERT is fine"
  permission — the exact turn the "describing a save is not doing it" bullet
  above targets): **zero tool calls again**, 71,956ms of real generation
  (44,270 input / 993 output / 610 thinking tokens — not a stall or empty
  round-trip), and turn 3 immediately reverted to a fresh `doc_batch` read
  instead of inserting — the identical shape as the failure the bullet was
  written for, down to the exact next-turn regression. The developer's
  standing rule this session (kill on the first turn that repeats a known
  failure shape, don't let the ladder run out) was applied live: the run was
  killed at this point, so the `classifyProfiles` shell-narrowing fix was
  never exercised (no turn 2→3 tool-schema transition happened) and stays
  unvalidated by this run. **This is real evidence the "describing a save is
  not doing it" bullet does not change gemma4-E4B's behavior on this specific
  turn** — prose repetition of a rule the model already isn't following is
  unlikely to fix it on a fourth iteration either. Worth treating as a design
  question next (e.g. whether the harness/skill can force a tool-call-shaped
  response on this turn rather than allowing a pure-prose reply, or whether
  this is better characterized as a generation-level tool-call-emission gap
  than a prompt-adherence gap) rather than a fifth wording attempt.

---

## Db-connect — extraction identity / managed lock

- 2026-08-01 A v1-era extraction row whose connection string is edited BEFORE
  the new build's first touch (no read, write, or provisioning since upgrade)
  stays orphaned: the old raw options are gone and the saved hash cannot be
  inverted, so the row is rejected rather than silently adopting an arbitrary
  `var/extraction/<hash>.db` path (which would reopen the forged-`provisioned`
  hole). Documented in `lib/db-connect/extraction.js` +
  `tests/unit/db-connect/extraction.test.js`; closing it soundly would require
  persisting the adopted identity at first recognition.

---

## Db-connect — placeholder validation (db_execute)

- 2026-08-03 `validateBoundParams()`'s backslash-escaping assumption
  (`lib/db-connect/classify.js`, `maskLiteralsAndComments`) is per-ENGINE,
  not per-CONNECTION: MySQL is assumed to have backslash escapes enabled
  (true unless the connection's session has `NO_BACKSLASH_ESCAPES` set) and
  Postgres is assumed to have them disabled outside `E'...'` strings (true
  unless the connection has the long-deprecated `standard_conforming_strings
  = off`). Both are correct for the overwhelming majority of real
  connections — matching each engine's default — but a connection actually
  running the non-default mode would see the opposite masking behavior:
  correct placeholders inside a `'...'` string containing a backslash could
  be miscounted, rejecting a valid write before it's ever proposed. Aperio
  has no way to know the connection's actual mode without adding a live
  `SHOW VARIABLES LIKE 'sql_mode'` / `SHOW standard_conforming_strings`
  round-trip (and caching) before every `db_execute` validation, which is
  disproportionate machinery for this. Not attempted; would need a per-
  connection setting (set once when the connection is configured) rather
  than a runtime query, if ever addressed.
- 2026-08-04 `splitStatements()` (same file) still applies ONE dialect-neutral
  comment grammar, while `maskLiteralsAndComments()` is now dialect-aware for
  both comment forms. It therefore diverges from MySQL (`--x` with no space is
  not a comment there, and `/*! … */` is executed) and from Postgres/SQL
  Server (block comments nest). A `;` hidden inside such a span makes a real
  multi-statement batch classify as a single statement. Not a routing hole in
  practice: the classifier's job there is only to pick db_query vs db_execute,
  and every driver is opened with multi-statement execution disabled (mysql2's
  `multipleStatements` defaults to false), so the extra statement fails at the
  driver rather than running. Fixing it would mean plumbing `engine` through
  `splitStatements()` and every `classify()` caller; deliberately not done for
  a case with no reachable consequence.

---

## Intentional deferrals

These are intentional deferrals. Do not "fix" them without discussion.

| Item | Status | Blocked on |
|------|--------|------------|
| CSP headers disabled | Resolved: Helmet CSP is enforced by default; use `APERIO_CSP=report` for rollout diagnostics | — |
| `tree-sitter` pinned at `^0.24.7` | Cannot upgrade to 0.25+ (ABI 15) | `tree-sitter-wasms` must ship ABI-15 grammar builds |

## Investigated and rejected

Not deferrals — these were built, measured, and found not to work. Do not re-attempt the same
approach without new evidence; a different mechanism may still be worth trying.

| Item | Finding | Evidence |
|------|---------|----------|
| Memory compaction via deterministic filler-phrase rewriting (issue #286, `/caveman-compress` borrow) | Real Aperio memory content contains no removable conversational filler — 0.00% token savings measured against both the capability-exam corpus and every real row in the dev DB. Content is terse, third-person, LLM-extracted fact/decision prose, not chat-log/verbose-note text the technique targets. Confirmed independently via gzip compressibility (real content compresses worse than filler-laden control text of the same length). A model-based paraphrase pass was considered and rejected on cost/latency grounds for content this short (a few sentences per memory); might be worth revisiting only if memory content shape changes to hold much longer text (paragraphs/documents). | CHANGELOG.md Unreleased entry, issue #286 closing comment |
