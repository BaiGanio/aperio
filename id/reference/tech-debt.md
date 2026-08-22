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
  T5.1) are real, checked-in, and green (`npm run test:audit`, 132 tests / 14 suites) —
  `audit/scripts/{inventory,schema,ledger,manifest,database-contract,config-contract,
  routes-contract,memory-contract,bootstrap-contract,provider-contract,
  registry-contract,usage-accounting}.js`. T2.1 (provider matrix) landed 2026-08-20 as
  `provider-contract.js`; T2.3 closed the same day — its ctx half was already
  `memory-contract.js`, and the registry half landed as `registry-contract.js`
  (mcp/tools module ⇄ mcp/index.js wiring, plus the internal-agent vs
  standalone-MCP tool-name catalogs). T3.3 (usage accounting) landed 2026-08-20 as
  `usage-accounting.js` — the aggregation layer over many `schema.js`-valid run
  records, reusing `lib/pricing.js` and the real billing classifiers. Its
  persistence half landed the same day as `ledger.js`: immutable JSONL records,
  fail-closed reads, and direct `streamUsage` mapping that preserves
  `cache_creation_input_tokens` as `tokens.cacheCreationInput`. T6–T9 (waves,
  journeys, triage, closeout) are still open.

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
- 2026-08-22 **Stale entry corrected.** This used to say the phantom-READ
  check (a model querying `FROM <table>` it never created — gemma-4-12B's
  side of the family, distinct from the fabricated-write-claim case
  `noPhantomWriteClaims` already covers) was deliberately not attempted. It
  was already built and wired in on 2026-08-20 (`94f77065`): `read-claims.mjs`
  exports `phantomReadClaims()`, gated on the run itself either `CREATE
  TABLE`-ing the table or discovering it via `db_schema` on the same
  connection, with system connections (`aperio`) excluded outright. Wired
  into `grading.mjs` as `checks.noPhantomReadClaims`, tagged into T-G2.3's
  `gateFailures` — so it already gated real runs — but was missing from
  `PROVENANCE_GATES["T-G2.3"].checks`, the list `buildGates()` uses to render
  the gate's own `checks` object; a passing run's `gates["T-G2.3"].checks`
  silently omitted it even though a phantom read there would have failed the
  gate. Added today. 12 unit tests (`read-claims.test.js`) plus the full
  106-test `npm run test:docint` green.
- 2026-08-22 **Standing recommendation acted on for the worst offender —
  `citesQueryProvenance` removed outright, not just demoted.** The vocabulary
  check (required "query"/"table"/"database"/"sql" near the figure) is gone
  from the codebase entirely, along with the `followUpCitesSql` gate it fed.
  Concrete proof it was flaky, not hypothetical: a fully honest,
  correctly-sourced answer — `"The grand total is 696.84 BGN."` — already had
  a test on file proving it failed the check on wording alone. Replaced by
  `narratedTotalMatchesQueriedRows()` (`grading-predicates.mjs`), a new T-G2.3
  gating check (`followUpTotalMatchesQuery`) that matches the NUMBER the
  answer states against the real query result — either a single value (a
  per-category/per-currency figure quoted directly) or the sum of every
  numeric value the query returned (a grand total) — instead of matching
  words. Vacuous-true when the query returned no numeric column to check
  against, same house style as `unresolvedForeignCurrencyRows`. This is
  strictly stronger than what it replaces: the old check would pass a
  perfectly-worded citation of a fabricated number ("according to my query,
  the total is 999.99") and fail a wordless-but-correct one; the new check
  requires the number itself be real, in any phrasing. `followUpNarratesDecimalTotal`
  (an answer must still state *some* decimal total) stays as a separate,
  narrower gating check. Full 39-test `grading.test.js` +
  `grading-predicates.test.js` and 106-test `npm run test:docint` green;
  replayed against the two runnable archived transcripts in
  `var/docint-runs/` — overall status unchanged on both (both were already
  failing for unrelated reasons, `db_execute` never proposed), though each
  now reports the new grounding failure in place of the old vocabulary one, as
  expected for a transcript that never reached a real queried total.
  **Not addressed here**: the currency-phrasing and category-as-components
  incidents already got their own fixes elsewhere (`verifyCurrencyClaims`
  mechanism, `unresolvedForeignCurrencyRows`'s structural rewrite) — this entry
  only tracks the piece that was still open.
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

- 2026-08-02 **`inferTemplateProposal()`'s `match_keywords` heuristic needs
  real-corpus validation.** (`lib/handlers/extraction/extractHandlers.js`)
  **2026-08-05 update: the two structural weaknesses this entry originally
  flagged are fixed** (`c91b0865`) — `inferTemplateProposal` now calls
  `matchHandlers.proposalKeywords()`, not `significantWords()`. It penalizes
  a `GENERIC_PROPOSAL_WORDS` list ("invoice", "total", "payment", etc.) and
  weights header/first-line and label-shape position, so two different
  providers' bills no longer collide on shared boilerplate and an issuer name
  in the header outranks generic body frequency. Covered by 5 unit tests in
  `tests/integration/handlers/extraction/extractionHandlers.test.js`
  (boilerplate deprioritization, header-term preference, cross-provider
  distinguishability, and a noisy OCR-like-text case), all green as of
  2026-08-21.
  **2026-08-22 real-corpus run.** Ran `proposalKeywords()` against all 135
  real `.txt` files in the generated household corpus (48 filename-derived
  categories, 9 months, /Users/lk/Projects/household — one-off script, not
  committed since the corpus lives outside the repo). Cross-provider
  distinguishability holds up on real text: unrelated issuers never collide
  (no false match above the 0.6 confident threshold between e.g.
  electricity, water, heating, internet, grocery, fuel). Within-issuer
  consistency is strong too — same provider across different months scores
  avgJaccard 0.47–1.00 on its own keyword sets, so a second month's bill from
  a provider a template was already learned from would still auto-match it.
  **New finding, not previously tested: the heuristic captures issuer
  identity, not document TYPE, so two different roles from the SAME issuer
  are indistinguishable to it.** `electricity-bill` vs
  `electricity-credit-note` (same provider, SofiaEnergo) scored keyword
  overlap 1.00, as did two distinct regulator notices from the same office
  (`tariff-increase-notice` vs `tax-increase-notice-bg`, both KEVR). Since
  `matchTemplates()`'s score is exactly that keyword overlap and
  `CONFIDENT_THRESHOLD` is 0.6, a credit note arriving after a bill template
  is already learned would silently auto-match the bill template rather than
  prompt for a new one — and get extracted with the bill's field shape
  (positive `amount_label`, bill-shaped dates), not a credit note's. A milder
  version shows up in the travel receipts: same-city documents (e.g.
  `gatwick-express`/`heathrow-express`, `internet-payment`/`water-payment`)
  cluster at 0.45–0.60 from shared city/country/"ticket" vocabulary, right at
  the threshold.
  **2026-08-22 fix shipped for the money-corrupting half of this.**
  `matchOrPropose()` (`lib/handlers/extraction/extractHandlers.js`) no longer
  trusts a keyword-confident match on its own — it now also runs
  `extractFields()` (the same resolver a real extraction would use) against
  the candidate template and requires `FIELD_SHAPE_THRESHOLD` (0.8, exported)
  of its fields to actually resolve from the incoming text; below that it
  falls through to propose a new template instead, carrying a `shapeMismatch`
  explanation the MCP tool surfaces to the user. Threshold picked
  empirically, not guessed: every genuine same-template real-corpus document
  resolved 100% of fields, while the electricity-bill/electricity-credit-note
  pair (the one real bill-vs-refund case in the corpus) resolved only
  33%/75% depending on match direction — 0.8 separates both cleanly. 34
  tests green (`tests/integration/handlers/extraction/extractionHandlers.test.js`,
  including a BG bill-vs-credit-note regression reproducing the real-corpus
  finding), full 2602-test `npm run test:integration` green.
  **Deliberately does NOT cover the milder half**, confirmed by the same
  empirical run: same-shape-different-issuer collisions (two billers' payment
  slips, two cities' train tickets, two regulator notices) resolve fields at
  ~1.00 on both sides because they genuinely share the same amount/date
  shape — field-checking can't see an issuer-identity mistake the way it
  catches a bill/refund polarity mistake, and it's lower stakes since no
  total gets corrupted, just filed under the wrong company name.
  **2026-08-22 candidate fix tried and rejected: requiring a template's
  top-N (1–3) most-distinctive keywords to literally appear in the candidate
  text, instead of only the overall keyword-overlap score.** Tested against
  the same real corpus. Result: does not close the gap. Of the four pairs
  that actually score above `CONFIDENT_THRESHOLD` today (the only ones that
  can silently misfire), it catches none reliably — `tariff-increase-notice`/
  `tax-increase-notice-bg` and `internet-payment`/`water-payment` share their
  top-3 keywords verbatim in both directions (their header IS the generic
  document-type boilerplate; the real differentiator word, e.g. "internet" vs
  "water", ranks 7th-8th, not top-3), and `gatwick-express`/`heathrow-express`
  is only caught in one match direction, not the other. The pairs it does
  catch (barcelona/helsinki/jfk/shanghai travel receipts) already score below
  0.6 today and were never at risk. One useful side-finding while testing:
  what first looked like a false positive (`grocery-receipt` failing its own
  true-positive check) turned out to be the corpus's own two real, distinct
  stores (ФРЕШМАРКЕТ vs ЕВРОМАРКЕТ) that a filename-only grouping had wrongly
  lumped together — not a regression. Not shipped; no code changed for this
  candidate. **Still open, and no further idea in hand** — closing it needs
  a signal keyword-position/overlap tuning cannot provide (the confusable
  documents' own text is, by construction, generically similar where it
  matters), not another reweighting of `match_keywords`.

---

## Document Intelligence — save/insert mechanics on gemma4 (#250)

Gemma 4 E4B's own SKILL.md-adherence gaps in the propose→confirm write flow,
found on the 2026-08-13 T-L4.3 WS2 provenance run. SKILL.md gained several
fixes the same day (§5 verify-existing-state, strengthened per-row-INSERT
guidance, a worked VALUES/params example, a first-write `db_schema` check,
"describing a save is not doing it") plus a §6 currency self-check and a
travel-exclusion discriminating test. Raw session-by-session record
recoverable via `git log -- trash/plans/document-intelligence-epic/document-intelligence-ws2-tg23-open-issues.md`
(deleted 2026-08-14 on T-G2.3's closure).

- **Hallucinated re-insertion on a second save attempt** — fabricated
  placeholder hashes, invented category labels, shuffled amount/original-string
  pairs, and 2 of 3 excluded EUR travel receipts reclassified as spending.
  SKILL.md fix landed. **Unvalidated** — no re-run has actually reached a
  genuine second save attempt yet.
- **Multi-row INSERT VALUES/params mismatch** — the model correctly emits one
  multi-row `INSERT` (the per-row habit is fixed) but the `VALUES` tuple count
  and the flattened `params` array go out of sync (a 7-placeholder `VALUES`
  against 65/91/nested-13-tuple `params`, across three retries). SKILL.md
  worked example landed. **Unvalidated** — needs a live re-run reaching this
  turn.
- **Wrong column name in a follow-up query** (`SUM(amount)` when the model's
  own `CREATE TABLE` named the column `amount_normalized`), cascading into a
  hard timeout. SKILL.md fix landed. One later run got the column name right,
  but wasn't the same failure scenario — **stays open**.
- **gemma-4-26B-A4B: total non-engagement on turn 1** — 600s, zero tool
  calls, zero output/thinking tokens, no partial answer. One-off so far,
  unexplained, not reproduced since. **Open, not investigated further.**
- **Ornith-1.0-9B: undisclosed currency blend + one excluded travel receipt
  counted as spending** — otherwise the cleanest save→query→narrate run any
  local model has produced (genuine multi-row INSERT, real query, correct
  narration). Both failures happened even though SKILL.md already named this
  exact scenario, numbers and all, before the run. §6 self-check + a new
  discriminating test landed. **Unvalidated, and a ceiling was already
  observed once** — needs a live re-run before trusting the new wording.
- **gemma4-E4B repeatedly fails turn 2 with zero tool calls, including on the
  very first live test of the fix written for it.** Two same-day re-runs
  after "describing a save is not doing it" landed: one produced zero
  `db_execute` calls all run (no `CREATE TABLE` even); the next reproduced
  the identical zero-tool-call turn-2 failure, 72s of real generation and no
  tool call, that the bullet targeted. **The one finding with real signal
  against the whole approach**: prose alone did not move this failure.
  Worth treating as a design question — can the harness/skill force a
  tool-call-shaped response on this turn rather than allow pure prose? —
  rather than a fifth wording attempt.
- **Ornith-1.0-9B-MTP fabricated an entire fake table via the wrong tool
  family** — used `recall`/`remember` (Aperio's own memory tools), never
  touched `db_execute`/`db_query` once across 8 follow-ups, inventing
  categories and a single USD total from nothing. Worse than the
  currency-blend case: never reached real data at all. **Open, not
  investigated.**
- A real code bug found along the way is already fixed and shipped:
  `classifyProfiles()` (`lib/agent/tool-profiles.js`) matched a bare `run`
  and added a spurious `shell` tool profile to database-intent SQL text
  containing the word "run" — fixed by extending docGraph's existing
  narrowing guard to database intent. 3 regression tests, full suite green.

---

## gemma-4-E4B tool-call leakage — pipe-delimited shape, distinct from the Ornith angle-bracket fix

- 2026-08-22 **Fixed and shipped**, code+unit-tested: `extractPipeAngleToolCall()`
  (`lib/tools/executor.js`) recovers gemma-4-E4B's pipe-delimited leak shape
  (`<|tool_call>call:doc_search{query:<|"|>...<|"|>}<tool_call|>`), distinct
  from the Ornith angle-bracket shape below. 8 unit tests, full suite green.
  **Still open:** 0-for-33 on live reproduction across two isolated test
  rounds (12 + 21 turns) — the fix is validated only against the originally
  recorded string, never against a live trigger of the actual failure mode.
  Round 2 did show the same pipe-angle text appearing cosmetically in 11/13
  answers, but as narration alongside a real native tool call, not as the
  broken-only-channel failure this fix targets — so it still doesn't confirm
  the recovery path itself works live. Leave open until one live run actually
  exercises `extractPipeAngleToolCall()`.

---

## Ornith tool-call leakage — angle-bracket shape unparsed

- 2026-08-18 **Fixed and shipped**, code+unit-tested: `extractAngleToolCall()`
  (`lib/tools/executor.js`) recovers Ornith-1.0-9B-MTP's angle-bracket leak
  shape (`<tool_call> <function=db_schema> <parameter=connection>...`), the
  actual blocker to a clean provenance run for this model. 7 unit tests, full
  unit+integration+harness suites green. **Still open: unvalidated live** —
  fixed and tested against the exact recorded leaked strings, not yet
  re-run against a fresh live turn.

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
  the run's own db_execute was never reached.
  **2026-08-22 — the context-assembly hypothesis was checked and is NOT the
  cause; a real structural gap was found next to it and is now fixed.** Read
  end-to-end rather than re-run: `capToolResults`/`trimByTokens`/
  `dropOrphanedToolResults` (`lib/context/trim.js`) all handle both tool-result
  shapes, `trimByTokens` already pins the freshest tool_use/tool_result pair by
  object identity so trimming cannot evict what the model just fetched, and
  `toOpenAIMessages` (`lib/agent/providers/llamacpp.js`) keys its tool-result
  branch on the block type, not the role, so the intercepted path's
  `{role:"user"}` results convert correctly too. The result WAS in context. The
  gap is that **nothing bounded the loop**: every provider loop is `while (true)`
  with no step cap (at the time only `codex-turn-meter.js` had one,
  `maxSteps: 128` — since 2026-08-22 all four native loops carry
  `APERIO_TURN_MAX_TOOL_STEPS`, see the closing note below), and the
  existing repeated-call guard in `tool-safety-middleware.js` counts repeated
  *failures* only — a call that keeps SUCCEEDING is invisible to it. The dedup
  cache made each repeat cheap to execute but did nothing about the full
  generation pass each one still cost (40–45 s for the `db_schema` turns), so the
  only backstop was the 600 s wall clock. Fixed with a repeat breaker:
  `countTrailingRepeatedToolCalls()` + `TOOL_REPEAT_LIMIT` (`lib/tools/executor.js`)
  count identical back-to-back calls within the current turn; at 3 the llamacpp
  and deepseek loops set `noTools` for one pass, append `TOOL_REPEAT_NUDGE`, emit
  `tool_repeat_break`, and run the executor in `answerOnly` mode so a call leaked
  in prose cannot restart the loop — the turn is guaranteed to end on that pass.
  19 tests (10 detector + 4 `answerOnly` + 2 real-loop tests driving
  `runLlamaCppLoop` through a mocked llama-server, plus the existing suites);
  full unit (2700) + integration (2602) + harness (32) green.
  **Still open — the fix bounds the damage, it does not explain the behaviour.**
  Untouched candidates: whether this is a sampling/repetition-penalty issue
  specific to `llama.cpp`'s `ornith` adapter path, or dependent on
  `ctx-size 131072` specifically (this run's KV cache size) rather than the
  model itself. **Also unvalidated live** — the breaker is proven against a
  scripted loop, never yet against a real Ornith turn.
  **2026-08-22 — the success-blind gap closed.** The repeated-call guard
  described above (the paragraph starting "the existing repeated-call guard
  ... counts repeated failures only") now counts identical calls regardless
  of outcome, moved into `tool-safety-middleware.js` so every provider gets
  it for free (not just llamacpp/deepseek) — see that file's
  `tool-repeated-call-detection` adapter for how it composes with the
  provider-level breaker above. New harness coverage:
  `repeated-call-break-success`.
  **2026-08-22 — the dedup half closed for anthropic/gemini too.**
  `findPriorToolResult` was only wired into llamacpp/deepseek's shared
  `ToolExecutor` (`lib/tools/executor.js`); `anthropic.js`/`gemini.js` drive
  their own tool-dispatch loops and re-executed an identical repeated call for
  real (wasted work/cost) until the 3rd-call guard above stopped it. Both now
  call `findPriorToolResult` before pushing their own turn's `tool_use` blocks
  (so the current call can't match itself) and wrap a hit with the same
  `reuseNote` llamacpp/deepseek use (now exported from `executor.js` instead of
  file-local, so the wording can't drift). Covered by a new test per provider
  in `tests/unit/providers/{anthropic,gemini}.test.js` — the harness can't see
  this since it only drives the mock provider, never `anthropic.js`/`gemini.js`
  directly (`tests/harness/README.md`, "What this harness deliberately does
  not cover").
  **2026-08-22 — the last unbounded shape closed: a per-turn tool-step cap.**
  Everything above counts a call issued IDENTICALLY over and over, so a model
  alternating between different tools (`doc_manifest` → `db_schema` →
  `doc_manifest` → …) resets every one of those counters and still runs until
  the wall clock. `resolveTurnStepLimit()`/`TURN_STEP_NUDGE`
  (`lib/tools/executor.js`) + `APERIO_TURN_MAX_TOOL_STEPS` (default 6, 0
  disables) count tool-calling passes per turn in all four native loops; at the
  limit the tools are withdrawn for one pass and the nudge explains why, so the
  request carries no tool schemas and the turn must end there. Surfaced as
  `tool_step_limit` (amber chip + CLI line + 26 locales), same shape as
  `tool_repeat_break`. 11 tests across all four provider loops plus 4 on the
  limit resolution; full unit (2731) + integration (2603) + harness (33) green.
  Fixed a pre-existing failure while there: `streaming-router.test.js`'s
  `EXPECTED_TYPES` contract was already red on master because `tool_repeat_break`
  (commit `c61f970c`) was never added to it.
  **Still open, unchanged:** the cap bounds the damage, it still does not
  explain the Ornith behaviour, and it is proven against scripted loops only —
  never yet against a real Ornith turn.

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
| A v1-era `extraction` row whose connection string is edited before the new build's first touch stays orphaned (`lib/db-connect/extraction.js`) | Permanent: the old identity is gone the moment the process restarts with a new connection string, and a one-way hash can't be inverted. Fails closed on purpose (rejects rather than silently adopting an arbitrary path). 2026-08-22: error message now names the stranded file for manual recovery (`reservedExtractionNameError()`) | Unrecoverable by design — nothing to unblock |

## Investigated and rejected

Not deferrals — these were built, measured, and found not to work. Do not re-attempt the same
approach without new evidence; a different mechanism may still be worth trying.

| Item | Finding | Evidence |
|------|---------|----------|
| Memory compaction via deterministic filler-phrase rewriting (issue #286, `/caveman-compress` borrow) | Real Aperio memory content contains no removable conversational filler — 0.00% token savings measured against both the capability-exam corpus and every real row in the dev DB. Content is terse, third-person, LLM-extracted fact/decision prose, not chat-log/verbose-note text the technique targets. Confirmed independently via gzip compressibility (real content compresses worse than filler-laden control text of the same length). A model-based paraphrase pass was considered and rejected on cost/latency grounds for content this short (a few sentences per memory); might be worth revisiting only if memory content shape changes to hold much longer text (paragraphs/documents). | CHANGELOG.md Unreleased entry, issue #286 closing comment |
