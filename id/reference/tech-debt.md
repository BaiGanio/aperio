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

## Continuous-audit program — the mandated verify-first test suite was never built

- 2026-08-15 `aperio-continuous-audit-tests.md`'s T1–T9 test plan is only partially
  built. T1 (repo-inventory baseline) and the Bootstrap milestone (T3.1, T4.4, T2.4,
  T5.1) are real, checked-in, and green (`npm run test:audit`, 113 tests / 13 suites) —
  `audit/scripts/{inventory,schema,manifest,database-contract,config-contract,
  routes-contract,memory-contract,bootstrap-contract,provider-contract,
  registry-contract,usage-accounting}.js`. T2.1 (provider matrix) landed 2026-08-20 as
  `provider-contract.js`; T2.3 closed the same day — its ctx half was already
  `memory-contract.js`, and the registry half landed as `registry-contract.js`
  (mcp/tools module ⇄ mcp/index.js wiring, plus the internal-agent vs
  standalone-MCP tool-name catalogs). T3.3 (usage accounting) landed 2026-08-20 as
  `usage-accounting.js` — the aggregation layer over many `schema.js`-valid run
  records, reusing `lib/pricing.js` and the real billing classifiers.
  Still open: T3.3's *persistence* half — no audit ledger file exists yet, so
  `checkUsageAccountingContract()` reconciles an empty record set by default and its
  standing value comes from the source invariants it pins. T6–T9 (waves, journeys,
  triage, closeout) are also still open.
- 2026-08-20 **Cache-read and cache-write tokens have no published rate in
  `lib/pricing.js`, and the two gaps have different consequences.** `getPricing()`
  returns `{ in, out, contextWindow }` only.
  - *Cache reads* can still be bounded: `usage-accounting.js` reports a cached run's
    cost as an interval (cached tokens billed at 0 → `low`, at the full `in` rate →
    `high`) and marks it `bounded`. Real cache-read rates are roughly a tenth of the
    input rate, so the interval is wide but sound.
  - *Cache writes* cannot be bounded at all, because they are billed **above** the
    base input rate — pricing them at `in` would put the true cost outside the
    interval. So a run with `tokens.cacheCreationInput > 0`, or one whose provider
    reports cache writes and whose record omits the count, prices as `unknown`. In
    practice that is every real Anthropic run with prompt caching on, which is a lot
    of `unknown` rows.
  Extending `lib/pricing.js` to carry OpenRouter's cache-read and cache-write rates
  would collapse the interval to an exact cost and remove the `unknown`s; the
  `price-sheet-has-no-cache-or-reasoning-rate` source invariant fails the day a rate
  is added, which is the prompt to do it. Reasoning tokens need no rate — they are a
  breakdown of the output count on every provider Aperio talks to, so they are already
  billed at the output rate and are reported, never summed.

---

## Docgraph — document facts (#250)

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

## Document-intelligence harness — grader (#250)

> The grader lives in `tests/docint/` (`grading.mjs`, `grading-predicates.mjs`,
> `provenance-ladder.mjs`, `write-claims.mjs`, `replay-grading.mjs`) and runs via
> `npm test` / `npm run test:docint`. `tests/fixtures/household-gen/harness-gate.mjs`
> covers the T-G2.3 currency/category checks.

- Still open: no per-turn wall-clock ceiling derived from observed times across
  models exists — the previous 550,000 ms guess was demoted to a reported metric
  after it failed substantive passes; a real derived ceiling would be worth having,
  but reinstating a guessed number is not the way to get one.
- Still open, deliberately not attempted: a phantom-READ check (a model querying
  `FROM <table>` it never created — gemma-4-12B's side of the family, distinct
  from the fabricated-write-claim case `noPhantomWriteClaims` already covers).
  Needs different evidence (system/pre-existing tables excluded) than the write
  case; no current run is blocked on it.
- **Standing recommendation, backed by four separate false-failure incidents
  (markdown emphasis, SQL vocabulary, currency phrasing, category-as-components —
  each invalidated a whole run before being fixed reactively):** move
  category/provenance grading off substring-matching over free prose. The
  structural checks (`dbQueryReturnedRows`, `insertedRealRows`) already carry the
  actual evidentiary weight; the prose checks only ask how the model narrated it,
  and prose phrasing is an open-ended surface no fixed set of checks will cover.
- Still open: `grading.gates` (T-G2.3/T-G2.4/T-L4 split by gate, not one bundled
  `status`) makes remaining failures legible but doesn't close them — T-G2.4 still
  fails on gemma4-E4B (currency blend, tracked in the gemma4-E4B section below) and
  the round-11 Fuel double-count is a real, untraced extraction defect.

---

## Document-intelligence gate — gemma4-E4B model behaviour (#250)

Four live runs of `DOCINT_PHASE=provenance` against
`unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`, same command, same fixtures:
round 9 clean (16/16 under the current grader), rounds 10-12 fail. **Four runs,
one pass, four distinct failure modes — no two runs failed the same way.** The
harness itself is settled (three-run KV/wall-clock verification, above), so
these are the model, not the rig.

- 2026-08-13 **Runaway reasoning: a turn spent its entire 900 s budget on
  thinking tokens and emitted nothing.** Round 12 turn 2 logged
  `wallMs=900004 output_tokens=4678 thinking_tokens=4678` — every token
  produced in fifteen minutes was internal reasoning, with no answer and no
  tool call — then fell into the known empty-turn cascade (four 4,011 ms turns,
  0 tokens). This is what makes a run take 25 min instead of 15, and it is the
  only failure mode here that no gate check names directly; it surfaces as
  `withinPerTurnWallClockCeiling: false` plus "one or more turns did not
  complete". New in round 12 — rounds 9-11 never did it, so its frequency is
  1-in-4 and unmeasured.
  **Re-examined 2026-08-18 (A2D follow-up on the 2026-08-14 harness fix):** the
  four-turn cascade itself is explained by `runTurn()`'s pre-fix turn-id
  mismatch, not by additional model failures — do not add a gate check for the
  cascade shape itself. The one harness-independent defect here is turn 2
  alone: 900s spent entirely on thinking tokens with zero output and no tool
  call.
- 2026-08-13 **The write path silently produced nothing: `insertedRealRows:
  false` on a run that proposed `db_execute` and had the confirm approved.**
  Rows were never written, which is the *core* claim of T-G2.3. Alongside it,
  the model emitted `db_execute` calls with the `sql` argument missing
  (`` `sql` is required ``) three times in one run — malformed tool calls, not
  a rejected proposal. **Checked against the ledger 2026-08-13, and it is NOT
  purely a model defect** — see "db_execute — a malformed call the model is
  never told how to fix" below. The model's own error was real (a nested-array
  `params` for a multi-row INSERT), but nothing in the loop could tell it that,
  which is why it repeated the same shape three times.
- 2026-08-13 **The currency rule fails while present, explicit, and in
  context — the strongest single result of the session.** Round 12's answer
  contained `**Total Spending:** 893.24 (696.84 BGN + 196.40 EUR)`.
  `skills/document-intelligence/SKILL.md:261` quotes that string
  character-for-character as its worked counter-example, calls it "a failure,
  not a courtesy", and instructs the model to re-read every line and delete it
  before sending. The skill was pinned in the cached system prompt for the
  whole flow (`skills=[document-intelligence]` logged every turn) and round 11
  cited it by name. **This retires the standing "add an explicit
  never-sum-across-currencies instruction to SKILL.md" lead**: the instruction
  is already there in full, and re-wording it is not a live experiment. 2 of 4
  runs blended anyway. If this is to be fixed, it needs a mechanism (a
  post-generation check on the answer, or deriving the closing line from the
  query result rather than from prose), not more prompt.
  **Mechanism built 2026-08-18**: `verifyCurrencyClaims()`
  (`lib/agent/tool-hooks.js`, wired into `lib/agent/index.js` next to the
  existing `verifyFileClaims` hallucination guard) is a deterministic
  post-generation check — it never edits or blocks the model's own answer,
  only appends a correction when a parenthetical breakdown's amounts, tagged
  with two or more distinct currency codes, arithmetically sum to the leading
  total (0.02 tolerance for decimal-string rounding). Matches both recorded
  regressions verbatim (round 12's `893.24 (696.84 BGN + 196.40 EUR)` and
  Ornith-1.0-9B's `**Grand total: 893.24** (696.84 BGN + 196.40 EUR)`), 60
  unit tests in `tests/integration/agent/tool-hooks.test.js` (including
  same-currency and non-matching-sum cases that must NOT fire), full unit +
  integration + harness suites green. **Unvalidated live** — built and
  tested against the recorded failure text, not yet re-run against a live
  model turn.
- 2026-08-13 **Arithmetic double-count.** Round 11 attributed Fuel 431.20
  against a true 215.60, propagating into a 912.44 grand total (696.84 +
  215.60). This was the one defect in the section that had **never** been
  tried in prompt, unlike the currency rule, so prose was the cheap first
  move rather than a repeat of a failed one.
  **SKILL.md rule landed 2026-08-13** (§4, after the persistence paragraph —
  placed inside §4 deliberately, not as a new numbered section, because
  tech-debt and the plan docs cross-reference "§5"/"§6" throughout and
  renumbering would invalidate all of it). It names the mechanism rather than
  the symptom: `doc_batch`'s `aggregate` merges duplicates, but hand-building
  `INSERT` rows re-derives from raw documents and loses that merge. Both
  corpus shapes are stated — the same document as `.txt` + `.png` scan sharing
  a receipt number, and a receipt plus its bank-statement row — along with the
  anti-rule that makes this hard, taken from the oracle's own policy: equal
  amounts never establish duplication, and neither does the same merchant on
  the same card. June has exactly that trap (two PetrolMax fills, same card
  suffix 4417, 09 Jun 120.00 and 25 Jun 95.60, explicitly separate events), so
  a rule saying "merge what looks alike" would break the corpus in the other
  direction. Ends with a checkable step: reconcile per-category totals against
  `aggregate` before proposing the write.
  **Unvalidated — needs a live run.** Also note the round-11 arithmetic was
  never fully reconstructed: 431.20 is 2 × 215.60, i.e. the whole Fuel
  category doubled, which matches neither the statement-overlap signature
  (240.00) nor "one of two receipts counted twice" (335.60 or 311.20). The
  earlier characterisation of it as a single receipt double-counted does not
  survive arithmetic. The transcript was overwritten before the per-run
  archive existed, so the true shape is unrecoverable and the new rule is
  aimed at the documented duplication shapes rather than at that run.

**What is not yet decided (the actual blocker on T-G2.3):** whether a model
that passes 1-in-4 with four distinct failure modes clears this gate at all.
The honest options are unchanged — raise the model, lower the gate to a stated
pass-rate threshold, or fix the defects at their source — and no further runs
resolve it; it is a judgment call, not a measurement. A planned 6-run
measurement (3 baseline + 3 with a SKILL.md change) was cut after round 12,
because the round-12 blend retired the premise of the second arm.

---

## db_execute — a malformed call the model is never told how to fix

- 2026-08-13 **Root-caused from the `var/toolrepair/events.tsv` ledger, which
  recorded all three of round 12's failures at 17:21:46, 17:24:42 and 17:28:14.**
  The ask was to check the ledger before booking these as a model defect. The
  ledger's own rows are the finding: every one is `unknown_param`, and there is
  **no `missing_required` row for `sql` anywhere** — the one issue that was
  actionable. Four independent things line up:
  1. **The mangling happened upstream of Aperio.** The garbled argument key is
     full of `<|"|>` tokens, which appear nowhere in this repo (`grep` over
     `lib/` and `mcp/`) — it is llama.cpp's own template quote marker. What
     arrived over the OpenAI-compatible API was already an object with
     `connection`, a `params` holding only the FIRST row's 7 values, and rows
     2..N flattened into a key ending `,sql`. The `sql` argument was consumed
     into that key before any Aperio code ran. Corroborating detail: a receipt
     description containing colons (`Diesel B7, Pump: 4, Operator: 0`) was
     re-read as object entries — `"Diesel B7, Pump": 4, "Operator": 0` — which
     is a parser that lost sync mid-value, not a model emitting nonsense.
  2. **`checkArgs` structurally cannot report the real issue.** `db_execute`
     declares `connection` and `sql` as `.optional()`
     (`mcp/tools/database.js:100-101`) because they are only required when
     PROPOSING, with the handler enforcing it. So `zodToJsonSchema` yields
     `required: []` and `checkArgs` can never emit `missing_required` for
     `sql` — verified by running both against the real schema.
  3. **The hint was suppressed for this tool.** `db_execute` is in
     `DESTRUCTIVE_TOOLS` (`lib/tools/executor.js:14`), and
     `lib/agent/index.js` returned `null` from `repairHint()` for destructive
     tools. This was the only gate that actually fired.
  What the model DID receive, all three times, was the handler's own
  `errText("\`sql\` is required.")` — `callTool` returns an `isError` result's
  text to the model, and already appended the hint on that path. So "it was
  never told" is wrong: it was told the bare fact and not the diagnosis. It
  repeated the same malformed shape anyway, which is a genuine model failure on
  top of the plumbing one.
  `pickSql` already recovers near-miss keys (`query`, `statement`, `sql_query`,
  `stmt`) but cannot help here: the statement was never a value, it was part of
  a key name.
  **Fixed 2026-08-13 for (2) and (3); (1) is upstream.**
  - (3) The hint gate no longer keys on `DESTRUCTIVE_TOOLS`. That set conflated
    two different guards: `parseArgs` refuses to REPAIR malformed args for
    destructive tools because a regex repair can shift string boundaries and
    land a corrupted write — untouched, and it must stay, along with
    `findPriorToolResult`'s exclusion. Declining to EXPLAIN a failure protects
    nothing. Moving `db_execute` out of the set was considered and rejected: it
    would have bought the hint at the cost of both real guards, on the exact
    write path this gate exercises, against an explicit comment in the source
    calling the set a non-removable floor.
  - (2) `checkArgs` still cannot emit `missing_required` for an optional-by-
    schema param, but it no longer reports the debris as `unknown_param`.
    A key longer than 64 chars or carrying `,[]{}`/newlines is structural
    debris, and once any key in the object is debris the short ones alongside
    it are too (round 12's `Operator`, 8 chars, from a colon inside a receipt
    description). New kind `mangled_args`, whose ledger row and hint carry
    only `«mangled:2773ch»` — never the payload, so a bad call no longer also
    poisons the context window and no longer writes ~3 KB per TSV row. The
    hint names the tool's real parameters once for the whole group. Verified
    against round 12's verbatim arguments: all three calls now classify as
    mangled, and a hallucinated param on a clean parse still reads as
    `unknown_param`. 7 tests in `tests/integration/tools/schemaCheck.test.js`.
  - Unvalidated live: whether the better hint changes gemma4-E4B's retry. The
    recorded evidence only shows it repeating under the bare message.

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

## Document Intelligence — save/insert mechanics on gemma4 (#250)

Gemma 4 E4B's own SKILL.md-adherence gaps in the propose→confirm write flow,
found live on the 2026-08-13 T-L4.3 WS2 provenance run (harness-level grading
bugs from the same run are fixed, not listed here — the raw session-by-session
record lived in `document-intelligence-ws2-tg23-open-issues.md`, deleted
2026-08-14 on T-G2.3's closure; recover with `git log -- trash/plans/document-intelligence-epic/document-intelligence-ws2-tg23-open-issues.md`).
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
  documented from earlier runs (re-examined 2026-08-18: this cascade shape is
  the pre-2026-08-14 harness turn-id bug, so the two empty follow-on turns are
  not separate model evidence — the real defect is the wrong column name
  alone). SKILL.md Gotchas now tells the model to
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
  **Re-examined 2026-08-18:** the empty ~4s cascade turns and the stray
  document re-read are explained by the pre-2026-08-14 harness turn-id bug,
  not by 26B-A4B behavior — drop them from any future case for
  model-specificity. The `shell` tool-profile addition was separately
  root-caused and fixed the same session (`classifyProfiles()` bare-`\brun\b`
  match, see the per-row-INSERT entry below) — likely the same mechanism
  here too, since the follow-up prompt text is the same SQL-language "run"
  trigger, though this specific run was not re-verified against the fix. The
  one defect this bullet still stands on is turn 1's total non-engagement
  itself: 600s, zero tool calls, zero tokens.
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
- 2026-08-18 **New: Ornith-1.0-9B-MTP fabricated an entire fake table via the
  wrong tool family, never touched `db_execute`/`db_query` once across a full
  8-follow-up ladder.** Run against the fixed `document-intelligence-skill-
  harness.mjs` (see the harness-import bullet below), same June fixture. Turn
  0 (1011 tokens, no tool call) wrote a plan, then called `recall` (Aperio's
  own memory-search tool, not a database connection), found nothing, and
  **inserted fabricated `INSERT INTO memories (...) VALUES (...)` SQL as
  prose** — never actually executed, just narrated — with invented category
  names not in the real taxonomy (Streaming/Subscriptions, Personal Care) and
  a single USD total, discarding the real BGN/EUR corpus entirely. Every
  follow-up turn compounded this: `remember` calls failed real MCP schema
  validation (`required param 'title' (string) is missing`), one turn openly
  said "I don't know where the data is supposed to live" and asked the user
  for a schema, and the final two turns narrated a "Grand Total" anyway from
  nothing real, in one case immediately after admitting no data existed. This
  is a different and arguably worse failure than the currency blend this
  session's SKILL.md/mechanism work targets: it never reached the point where
  a blend could even occur, because it never touched a real currency-mixed
  dataset. New evidence against `db_execute`/`recall` tool-family confusion
  under this ladder's phrasing ("save the results", "query the extraction
  table") — worth its own investigation before another live run is spent on
  this model. Not investigated further this session (time-boxed).

---

## Document-intelligence harness — broken relative imports since the T464 move

- 2026-08-18 `tests/docint/harness/document-intelligence-skill-harness.mjs`
  and `tests/docint/harness/gemma-simple-capability-harness.mjs` could not run
  at all: every relative import (4 static, 3 dynamic, in the skill harness;
  2 static in the capability harness) had one extra `../` — a leftover from
  moving these files into `tests/docint/harness/` (map #455 ticket T464,
  memory `project_public_launch_wayfinder_ticket464`) without correcting the
  depth. First failure was a static-import `ERR_MODULE_NOT_FOUND` on
  `harness-gate.mjs`; fixing that surfaced a second one from a dynamic
  `import("../../../../db/sqlite.js")` deeper in the file, resolving one
  directory above the repo root in both cases. **Fixed 2026-08-18** — all 7
  paths corrected to the right depth from `tests/docint/harness/`, verified
  by resolving each import directly before re-running. The move landed
  2026-08-15 (`2a2532cd`); checked every other dated entry in this file for a
  run recorded between then and this fix — none exists, so no prior recorded
  result needs re-examination. Any future `DOCINT_EVALUATION_PROVIDER=
  llamacpp` invocation before this fix would have failed at import time,
  before booting anything, so this was silently unusable rather than
  silently wrong.

---

## Ornith tool-call leakage — angle-bracket shape unparsed

- 2026-08-18 **Fixed.** `detectToolCallLeak()`'s generic `<tool_call>` pattern
  (`lib/tools/executor.js`) correctly flagged Ornith-1.0-9B-MTP's leaked calls
  and triggered the retry-with-thinking-suppressed path, but nothing actually
  RECOVERED them — `extractBracketToolCall()` only knows the bbcode shape
  (`[tool_call](name) [key]val[/key]`), and the JSON-object extractor in
  `extractTextToolCall()` doesn't match this either. The real, live-observed
  leak shape is angle-bracket, not bbcode:
  `<tool_call> <function=db_schema> <parameter=connection> aperio </parameter>
  </function> </tool_call>`. Recorded on the forced-`document-intelligence`-
  skill re-run of the provenance harness (same session as the currency-blend
  guard work below): the model correctly attempted `db_schema`, the leak fired,
  the retry reproduced the identical unparseable text, and the turn fell back
  to "I tried to use one of my tools but couldn't issue the call correctly" —
  four times across the run, every attempt from turn 1 onward, and the model
  never got another tool call to land for the rest of the ladder. **This, not
  skill persistence or tool availability (both already confirmed present),
  was the actual blocker to a clean provenance run for this model.** Fixed by
  adding `extractAngleToolCall()` alongside `extractBracketToolCall()`, wired
  into `extractTextToolCall()` the same way; handles the no-parameter case
  (`<function=db_connections> </function>`, also observed live) and JSON-typed
  parameter values. 7 new tests in `tests/unit/tools/executor.test.js`
  (mirroring the existing bracket-shape coverage), full unit+integration
  (5268 tests) and harness suites green. **Unvalidated live** — fixed and
  unit-tested against the exact recorded leaked strings from this session's
  run, not yet re-run against a fresh live turn.

---

## Ornith-1.0-9B-MTP — same-call repetition loop, the real blocker after the two fixes above

- 2026-08-18 With both the skill-persistence override (`DOCINT_FORCE_SKILLS=
  document-intelligence` — a diagnostic shortcut; the underlying carry is
  handled by `computeSkillPin()`, `lib/agent/turn-planner.js`, since
  2026-08-13) and the angle-bracket leak recovery above both in place,
  three consecutive turns of a fresh provenance run each fell into the same
  shape: the model calls a tool once, gets a real result, then **re-issues
  the identical call over and over** — `doc_manifest` **188 times** in turn 1
  (12:45:58–12:54:50, every ~2.8s for nearly 9 minutes straight — the fast
  text-interception retry cadence) and `db_schema` 13 then 9 times in turns 2
  and 3 respectively (every ~40-45s, a full generation pass each time, not a
  retry loop) — until the turn's own 600s hard timeout cut it off (turns 2
  and 3 both timed out or were killed with the loop still running).
  `findPriorToolResult`'s same-turn dedup
  (`lib/tools/executor.js`) worked exactly as designed every time, correctly
  reusing the prior result rather than re-executing — this is not a
  duplicate-execution bug. The bug is upstream: **the model never registers
  that it already has the answer and keeps asking again**, burning the
  entire turn budget on a call it already made. Turn 3 was killed at this
  point rather than let it repeat a fourth time (developer's standing rule);
  the run's own db_execute was never reached. Not investigated further this
  session — candidates worth checking before another attempt: whether the
  tool RESULT text is actually landing in the model's own context on the
  next generation step (a context-assembly gap would produce exactly this
  "it doesn't know it already asked" symptom), whether this is a sampling/
  repetition-penalty issue specific to `llama.cpp`'s `ornith` adapter path,
  or whether it's dependent on `ctx-size 131072` specifically (this run's
  KV cache size) rather than the model itself.

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
