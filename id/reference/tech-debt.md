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
  **Caught with timings, 2026-08-13 (forced-skill diagnostic run):** the
  mechanism is no longer inferred from fingerprints alone. Turn 3's
  `stream_end` usage reports `cache_n=12577` against `prompt_n=31067` —
  only 40% reuse — and `prompt_ms=261791` (262 s of pure prefill at 118
  tok/s) against `predicted_ms=41621` for 1,262 generated tokens. That turn
  is exactly the boundary where the pin reset fired and the tool set went
  `40→38` (`toolsHash 0ef511af95bc→5ba9030453ba`), while `sysHash` stayed
  fixed at `3eb24a32c1eb` all run — so the schema-set change is isolated as
  the cause, with the system prompt held constant by the forced skill. The
  262 s prefill is what pushed the turn into the 600 s hard abort that
  failed the gate, making this the first run where the cache gap is the
  *proximate* cause of a gate failure rather than a latency annoyance.
  **Attribution corrected, 2026-08-13 — the sticky pin is NOT what changes
  the set.** The same run logs `[tools] turn=N … attached=40/74` on every
  turn from 1 onward: the planner's resolved set never moves. The `40→38`
  is applied after planning, by `omitPreExecutedTools`
  (`lib/agent/index.js:716-728`), which filters the pre-executed doc tools
  out of the final array — `preExecutedTools` is a fresh Set per turn,
  populated only on turns where preflight auto-executes `doc_repos`/
  `doc_manifest`/`doc_batch`. The correlation is exact: the two turns that
  opened with a preflight `doc_batch` (turn 0 and turn 3) sent 38, every
  other turn sent 40. So the withholding — deliberate, to stop the model
  re-calling a tool already run for it — is itself the cache-buster on
  llama.cpp, and a monotonic tool pin would not have fixed this run at all.
  The earlier T-L4.3 38→40→38 reading attributed to the pin's carry-forward
  should be re-checked against this mechanism before being trusted.
  **Fixed 2026-08-13**: the omission is now skipped on llama.cpp —
  `filterPreExecutedTools()` (extracted to `lib/agent/tool-profiles.js`, pure
  and unit-tested) takes a `keepStable` flag that `lib/agent/index.js` sets
  from `provider.name === "llamacpp"`, evaluated at call time so a mid-run
  provider switch is honoured. Trades a possible redundant `doc_batch` (tens
  of ms, dedup-cached) against the measured 262 s reprocess. 5 regression
  tests; unit suite 2637 green, harness 32 green.
  **Verified live 2026-08-13 (T-G2.3 round 5) — the fix does exactly what it
  says, and it is NOT the cache mechanism.** The fingerprint held at
  `toolCount=40 / toolsHash=0ef511af95bc` on *every* request of a 7-turn run,
  including both preflight `doc_batch` turns (0 and 3) that previously sent 38,
  with `sysHash=ce4d6ee8259b` equally constant. The cache collapsed anyway:
  turn 1's first call reprocessed 33,836 tokens in 306 s, turn 3's two calls
  30,220 (253 s) and 31,046 (291 s). So the round-4 attribution — "preflight
  withholding was the real cause of the 262 s prefill" — is **withdrawn**: it
  was a real schema-set change and is now correctly suppressed, but suppressing
  it bought no reuse at all. See the new entry below for where the divergence
  actually is. Keep the fix (a stable tool array is right on its own terms and
  costs only a redundant dedup-cached `doc_batch`), but it closes nothing.

---

## llama.cpp KV reuse — the divergence is in the message array, not the prefix (#250)

- 2026-08-13 **Found in T-G2.3 round 5, replacing the tool-schema theory above.**
  With the system prompt and tool array both provably byte-stable all run
  (`sysHash`/`toolsHash`/`toolCount` identical on all 12 requests), llama-server
  still reprocessed near-everything at each turn boundary. The reuse figure is
  the clue — it is not "some" reuse, it is **exactly the prefix and nothing
  after it**:
  | request | slot ctx | reprocessed | reused | prefill |
  |---|---|---|---|---|
  | t0 call 1 | 47,933 | 47,199 | — (cold) | 364 s |
  | t0 call 2 | 3,955 | 3,356 | — | 8.6 s |
  | t0 answer | 48,661 | **833** | 47,828 | 12.1 s |
  | t1 call 1 | 48,266 | **33,836** | 14,430 | **306 s** |
  | t1 call 2 | 48,967 | 148 | 48,819 | 2.1 s |
  | t2 call 1 | 50,584 | 7,772 | 42,812 | 99 s |
  | t3 call 1 | 44,430 | **30,220** | 14,210 | **253 s** |
  | t3 call 2 | — | **31,046** | ~14.2k | **291 s** |
  `sysBytes=22,693 + toolsBytes=34,877 = 57,570 bytes ≈ 14.4k tokens`, and the
  reused count on every collapsed request is 14,210–14,430. **Reuse stops at
  the first conversation message, every time.** Within a turn, appends reuse
  almost perfectly (148–3,356 tokens); only turn boundaries collapse — except
  turn 3, where consecutive calls collapsed too.
  Context trimming is ruled out: `trimByTokens` fires at
  `0.75 × 104,570 = 78,428` tokens and the run peaked at ~50k. Two live
  corroborations that the message array is being rebuilt rather than appended:
  (a) turn 3's preflight `doc_batch` returned **~10.2k tokens against turn 0's
  ~15.1k** with a different candidate order (`bank-statement-jun` first vs
  `internet-payment-12-jun`), and the slot context *shrank* 50,584 → 44,430
  across that boundary; (b) turn 3 logged **`msgCount=20` on all three of its
  requests** while a `db_schema` and a `db_query` call plus results went by —
  the array did not grow across two tool round-trips.
  **ROOT-CAUSED 2026-08-13 (round 6), and the preflight hypothesis was wrong.**
  Added `msgprint` to the `LOG_CACHE_FINGERPRINT` path — a per-message
  hash+length list, emitted from inside `makeLlamaCppRequest` so no request
  path can bypass it (round 5 had a request that logged nothing). One run named
  the message immediately. Across the turn 0→1 boundary:
  ```
  req=4 (turn 0, last)        req=5 (turn 1, first)
  [0] system    22915B  ===   [0] system    22915B   identical
  [1] user      23411B   ✗    [1] user        199B   -23,212B
  [2] assistant   367B  ===   [2] assistant   367B   identical
  [3] tool      11124B  ===   [3] tool      11124B   identical (doc_manifest)
  [5] tool      57897B  ===   [5] tool      57897B   identical (doc_batch)
                              [13] user     23403B   the block, relocated
  ```
  **The matched skill body rides the *current* user message.**
  `lib/agent/model-context-middleware.js`'s skill-injection stage attached
  `getSkillPrompts(turn)` to `tailAppend`, which `appendTailToMessages` splices
  into `lastUser`. Its comment argued this was cache-neutral because "the newest
  message is never a cache hit regardless of what it contains" — true within a
  turn, false across turns, since turn N's newest message is turn N+1's cached
  prefix. The block is 23,212 B (`SKILL.md` is 22,937 B plus separators) and the
  turn 1→2 boundary repeats the signature exactly: index 13, −23,212 B. Preflight
  is exonerated — its `doc_manifest` (11,124 B) and `doc_batch` (57,897 B)
  results are byte-identical across the boundary, neither moved nor rebuilt.
  Note this also invalidates round 5's inference that a constant `sysHash` proved
  the skill was attached: `sysBytes` was 22,915 while `SKILL.md` alone is 22,937,
  so the skill was never in the system prompt and `sysHash` was constant either
  way. (Stickiness still works — turn 2's real INSERT and the ~23 KB block on both
  the turn-0 and turn-1 user messages show it.)
  **Fixed 2026-08-13**: skill prompts now go to `promptParts` (the cached system
  prompt); the stage records `skillPromptParts` so `prepareModelContext` can build
  a `systemPromptNoSkills`, and llama.cpp's small-context overflow fallback
  (#282's `400 exceed_context_size_error` guard) swaps the system prompt instead
  of re-splicing the message array — without that second half the guard would
  have kept logging "dropped skill prompts" while dropping nothing. Trade-off:
  the system prompt now changes when the matched skill *set* changes, which
  `computeStickySkills` already makes rare, against the previous guaranteed
  per-turn full reprocess. 2637 unit + 32 harness green; 5 characterization
  tests rewritten to the new invariant. Analyzer for the msgprint output:
  `trash/plans/document-intelligence-epic/llamacpp-latency/msgdiff.py`.
  **Verified live 2026-08-13, and it is only half the fix.** On its target the
  win is large and unambiguous — the turn 0→1 boundary became a `pure append,
  prefix intact` and turn 1's first call went from **33,836 reprocessed tokens /
  306 s to 845 / 11.8 s**, with turn 1's wall clock 358,769 ms → 103,770 ms.
  But the run still failed the gate, worse than round 5 (`insertedRealRows:
  false`): at the **turn 1→2 boundary the matched skill *set* changed**
  (`sysBytes` 46,134 → 52,810, one extra skill), and because the block now sits
  at index 0 that diverges the prompt at byte zero and reuses **nothing** —
  where the old tail placement would still have kept system+tools (~14.4k
  tokens). Turn 2 then had ~45k tokens to reprocess plus generation and burned
  its whole 600 s ceiling without emitting a single tool call.
  **So the placement is correct but incomplete: it pays only while the skill
  block is byte-stable across turns, and `computeStickySkills` recomputes the
  set per turn.** Net at that point: a large win when the set holds, a worse
  loss when it moves.
  **Second half landed 2026-08-13 (round 7) — the skill defect is FIXED.**
  `computeStickySkills` became `computeSkillPin`, which also reports whether
  the window is *active*; while a llama.cpp flow's window is live it re-sends
  the block it already resolved, verbatim (`resolvePinnedSkills`), so a
  mid-flow interloper match can no longer move the prefix. `planTurnTools`
  takes `pinnedSkillNames` / returns `skillPinNames`+`skillsPinned`;
  `lib/agent/index.js` stores it per conversation in a WeakMap keyed on the
  `messages` array (same scoping, same reason, as `turnCacheByMessages`).
  Bounds are pre-existing machinery: llama.cpp only, only while the window is
  active, forced `/skill` skills prepended fresh and never pinned, pin dropped
  whole if a pinned name has left the index. Two gaps closed while wiring it —
  a synthetic turn (greeting, preflight) must still SEND the pinned block or it
  drops ~23 KB out of the prefix mid-flow, and must never WRITE it, or it
  demotes a live flow's pin to the always-on skills. Deliberate trade-off: a
  genuine topic pivot inside a live llama.cpp tool flow waits up to
  `SKILL_PIN_TURNS` turns (or a `/skill`) for its new skill.
  Live evidence (gemma4-E4B, 900 s stuck-turn abort so the ladder survives
  turn 0's ~370 s cold prefill): `sysHash` identical on every request of the
  flow, boundaries 0→1 and 1→2 both `pure append, prefix intact` — 1→2 being
  exactly where round 6 died — and per-turn wall clock 359 s → 60 s (turn 1)
  and 134 s → 27 s (turn 2). Turn 3 narrated (1,051 output tokens) where
  round 5 aborted before narrating.
  **What remains is a DIFFERENT defect with the same symptom — see the
  `maxHistory` entry below.** Do not read "reuse stops at the first
  conversation message" as the skill defect returning.

## llama.cpp KV reuse — the `maxHistory` count cap cut the cached prefix (#250)

- 2026-08-13 **Found in T-G2.3 round 7, once the skill churn above stopped
  masking it.** `createModelContextMiddleware`'s message-count cap
  (`lib/agent/model-context-middleware.js`) kept `[raw[0], ...raw.slice(-19)]`
  the moment the model-facing array passed 20 messages — i.e. it deleted from
  the FRONT, which is exactly the cached prefix. Two things made that
  expensive:
  1. **It fired with no token pressure at all.** It is a message-COUNT bound;
     `trimByTokens` is the real context guard and fires at
     `0.75 × 104,570 = 78,428` tokens. The run sat at ~30-50k, so the cap was
     paying a full reprocess to solve a problem nobody had.
  2. **It fired on every hop.** A tool-using turn grows the array by 2
     messages per hop, and the cap took 2 straight back off, so `msgCount`
     oscillated 20↔21 and `msgdiff` reported `DIVERGES at index 2 (prefix
     kept: 2 msgs / 46,333 bytes)` hop after hop. Measured cost at the turn
     2→3 boundary: **24,494 tokens / 233 s, then 25,122 / 240 s on the very
     next hop** — 473 s of a single turn spent re-reading content nothing had
     asked to drop.
  This also **retires round 5's reading** of the `msgCount=20`-on-every-request
  signature ("the array did not grow across two tool round-trips → it is being
  rebuilt"). It was not a rebuild; it was this cap.
  **Fixed 2026-08-13** with hysteresis: the array may run to
  `maxHistory + historyCapSlack` (slack defaults to `maxHistory`, so 41
  messages) and is then cut back to `maxHistory` in ONE bite. The bound is
  unchanged; only the schedule is, so cuts are rare and amortized instead of
  paid per hop. `historyCapSlack: 0` restores the old cut-on-every-hop
  behavior and is what the characterization tests for the shed path now pass.
  Note the cut still deletes from the front, so when it does fire it still
  costs a reprocess — a cheaper future option is dropping from a point that
  preserves the prefix, or letting `trimByTokens` be the sole trimmer.
  **Verified live 2026-08-13 (round 8).** At the identical request of the
  identical flow where run B read `msgs=20 DIVERGES at index 2` and paid
  233 s + 240 s on consecutive hops, round 8 reads `msgs=26 pure append`, and
  the array went on to 36 messages with the prefix intact — 13 requests, zero
  divergences, `sysHash` constant throughout. Both harness wall-clock ceilings
  passed for the first time in the epic. **Still unobserved:** the run peaked
  at 36 messages and never reached the new 41-message threshold, so the single
  amortized cut the hysteresis is supposed to make has not been exercised live.

---

## Document-intelligence harness — grader (#250)

- 2026-08-13 **`hasNarratedDecimalTotal` rejects markdown emphasis, and it
  silently invalidates the whole provenance gate.**
  (`trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs:797`)
  The regex allows only `\s*` between the total cue and the figure, so
  `**Total in BGN:** 696.84` fails where `Total in BGN: 696.84` passes —
  and models emit the bold form by default. Verified against round 8's own
  transcript: the predicate is false on **all seven turns**, including turn 3,
  which called `db_query`, got 6 real rows, and stated correct per-currency
  totals with the non-conversion explicitly disclosed.
  The damage is not a single wrong check. `followUpSatisfied` uses this
  predicate as the ladder's stop condition, so the ladder escalates *past* a
  correct answer; later rungs instruct the model **"without calling any more
  tools"**; grading then reads the last turn with content (`ff6f0b15`), which
  by construction cannot contain a `db_query`. That forces
  `calledDbQueryAfterConfirm` and `dbQueryReturnedRealRows` false, and both
  prose checks are gated on the latter — four of round 8's six failures. The
  freed-up extra turns also restate the totals without turn 3's disclosure,
  which is what then trips `fullMonthGate`.
  **FIXED 2026-08-13 (same session).** Both predicates extracted to
  `llamacpp-latency/grading-predicates.mjs` so they can be unit-tested (the
  harness module runs a top-level `try`, so importing it to reach them would
  launch a full run); the cue-to-figure gap now admits markdown emphasis
  (`[\s*_`~]`, never letters or digits) and the cue accepts `totals`/
  `totaling`/`totalled`. 5 tests in `grading-predicates.test.mjs` built from
  round 8's verbatim strings. Replaying round 8's transcript through the fix
  stops the ladder at turn 3 and flips all four checks — plus `fullMonthGate`,
  which passes once the undisclosed turns 4-6 never happen. Still open as a
  design question: whether grading should prefer the turn that *satisfied* the
  ladder over the last turn with content — with the predicate fixed they are
  the same turn on a clean run, so this is now latent rather than active.
- 2026-08-13 **`followUpCitesSql` required SQL jargon and rejected table
  attribution — the second lexical false negative in two rounds.**
  Round 9's re-run cleared 15 of 16 checks and failed only this one. The test
  was `/sql|query|db_query/i` against the answer; gemma4 wrote *"the final
  grand total, pulled directly from the `spending_summary` database"*, naming
  the exact table it had CREATEd, INSERTed into and SELECTed from, and scored
  false for never uttering "sql" or "query".
  **FIXED 2026-08-13.** Extracted to `citesQueryProvenance` in
  `grading-predicates.mjs`, widened to accept `database`/`table` alongside the
  SQL vocabulary, with `saved`/`stored`/`recorded` deliberately excluded (they
  describe the write, not the read, so they would admit an answer reciting
  remembered figures — the 2026-08-02 gemma4 failure mode). Safe to widen
  because the predicate is only ever consumed ANDed with `dbQueryReturnedRows`
  for the same turn, so a real non-empty query is already proven before the
  lexical test runs; it asks only whether the answer *told the user* the figure
  came from stored data. 3 tests added from round 9's verbatim string.
  **The pattern is the real finding**: three of this gate's checks are
  substring tests over free prose, and two have now produced false negatives
  that invalidated an entire run (round 8 markdown, round 9 vocabulary). Each
  fix has been reactive and shaped by the run that exposed it. Before trusting
  this gate on a new model, audit the remaining prose predicates against
  phrasings that are correct but unanticipated — or move provenance grading off
  substring matching entirely, since the structural checks
  (`dbQueryReturnedRows`, `insertedRealRows`) carry the actual evidentiary
  weight and the prose checks only ask how the model narrated it.
- 2026-08-13 **`fullMonthGate`'s multi-currency rule over-triggers — now
  OBSERVED, no longer hypothetical.** Round 11 failed on
  `"**Overall Combined Total:** **912.44 BGN + 196.40 EUR**"` with "combines
  multiple currencies into one figure without disclosing that it isn't
  converting" — but that line states two figures, one per currency, and the
  very next line of the same answer reads *"(Note: No FX conversion was
  applied, as per the core principles of the `document-intelligence` skill.)"*
  The disclosure the rule demands was present and adjacent, and the rule still
  fired. Did not change round 11's verdict (an independent arithmetic failure
  was also present), so this is confirmed-but-not-yet-blocking. Fix alongside
  the entry below.
- 2026-08-13 **`fullMonthGate`'s multi-currency rule may over-trigger.** It
  failed `"...grand total across both currencies is **696.84 BGN** and
  **196.40 EUR**."` as "combines multiple currencies into one figure without
  disclosing that it isn't converting", but that line states two figures, one
  per currency — not the blended single figure (893.24) the rule was written
  for. It also evaluates the *combined* text of all turns, so one turn's
  explicit disclosure does not protect another's phrasing. Decide whether
  "names both currencies separately" should satisfy it.

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
  **Fixed 2026-08-13** — `computeStickySkills()` (`lib/agent/turn-planner.js`) carries
  the most recent matched skills (max 2, most-recent-first) for `APERIO_SKILL_PIN_TURNS`
  (default 4) follow-up turns while the flow keeps calling tools, ranked after the
  current turn's own matches. Replaying the real provenance ladder through
  `planTurnTools` now attaches `document-intelligence` on all five turns (was: turn 0
  only). 5 regression tests; unit suite 2632 green, harness 32 green.
- 2026-08-13 **Confirmed live: forcing the skill on every turn changes gemma4-E4B's
  behavior on exactly the turns where it was previously absent.** Diagnostic run,
  `DOCINT_FORCE_SKILLS=document-intelligence` (new env-gated flag, default off, sends
  the same `data.forcedSkills` one-shot the UI Skills panel uses on every chat
  message), same model/ceilings/ladder as every other T-L4 run this session:
  - turn 1 (docint previously absent): `db_schema(expenses)` **before** querying,
    then `db_query` using that schema's real column name — where round 3 queried
    from recall and the re-re-run invented a table name.
  - turn 2 (the zero-tool-call turn, failed identically in rounds 1/3 and the
    re-re-run): **a real `db_execute`, not a prose plan.** First attempt emitted
    malformed tool-call JSON (rows 2..N spilled out of `params` into a garbled
    object key containing `<|"|>` template-escape tokens, which swallowed the `sql`
    field → `\`sql\` is required`); it then **self-corrected unprompted** into a
    genuine 13-tuple `VALUES (?,…),(?,…),…` with 13×7 flat params, real
    `document_id`/`document_path` provenance, real categories, no fabricated hashes.
    `insertedRealRows: true` — **the first time gemma4-E4B has ever written real rows
    on this gate.**
  - turn 3: `db_query` after the confirm returned **8 real rows**.
  The four rounds of §5 wording were never the lever; skill absence was. Treat the
  "prose has hit a ceiling" reading as withdrawn — it was never tested.
  **What still failed is a different thing entirely**: turn 3 hit the 600s per-turn
  hard abort with the query result already in hand (43,644 input / 1,262 output /
  1,262 thinking, empty answer), so no total was ever narrated, and the known
  empty-turn cascade followed (3 turns at ~4,000ms). `grading.status: "fail"`.
- 2026-08-13 **Stickiness verified live, unforced (T-G2.3 round 5).** Same
  ladder/model/ceilings, `DOCINT_FORCE_SKILLS` deliberately unset. `sysHash`
  held at `ce4d6ee8259b` on all 12 requests across 7 turns — the skill block
  never left the system prompt — and the behavioral consequence reproduced
  without forcing: **turn 2 emitted a real multi-row `db_execute` INSERT, not a
  prose plan**, `insertedRealRows: true`. That is the turn that produced
  `reasoning-planning`-shaped prose in rounds 1, 3 and the round-2 re-re-run.
  `computeStickySkills()` is doing its job; this entry is closed as a defect.

---

## Document Intelligence — harness grader scoping (#250)

- 2026-08-13 **`followUpTurn = results.at(-1)` grades the wrong turn once a hard
  timeout triggers the empty-turn cascade** (`document-intelligence-skill-harness.mjs:660`).
  It is sound while the ladder stops on a satisfied turn — then the last turn *is* the
  answering turn — but a per-turn timeout keeps the ladder escalating, so `.at(-1)`
  becomes an empty ~4,000ms cascade turn with no tools and no answer. On the
  2026-08-13 forced-skill run that made four checks false-negative:
  `calledDbQueryAfterConfirm` and `dbQueryReturnedRealRows` were graded `false`
  although turn 3 genuinely called `db_query` after the confirm and got 8 rows back,
  and both prose checks are gated on `dbQueryReturnedRealRows` so they failed with
  it. Same class as the `insertedRealRows` grader bug already fixed in this epic —
  a check reading the wrong slice of the transcript, not a model failure. The
  narration failure itself is real and would still fail the gate; only the
  attribution is wrong. Fix direction: pick the last turn that has tool calls or a
  non-empty answer (or the `computeProvenanceSuccess` turn), not the literal last.
  **Fixed and verified live 2026-08-13 (round 5) — closed.** Round 5 ended in the
  same 600 s abort + empty-turn cascade, and the grader now reads turn 3 (tools
  present) instead of the empty turn 6: `calledDbQueryAfterConfirm: true` and
  `dbQueryReturnedRealRows: true`, both graded `false` on the identical shape in
  round 4. The two prose checks gated on them stay `false`, correctly — turn 3's
  `answerRaw` is genuinely empty. Fix confirmed; it turned no fail into a pass.

---

## Document Intelligence — extraction accuracy (#250)

- 2026-08-13 **Rows the model actually persisted on the forced-skill run are
  partly wrong**, found by reading the turn-3 `db_query` result (8 rows). BGN:
  Utilities 260.50 ✔, Fuel 215.60 ✔, Internet 29.99 ✔, Transport 50.00 ✔, but
  **Groceries 87.45 against the corpus's 140.75** — short exactly 53.30, so at
  least one grocery document's amount never made it into the INSERT. BGN total
  would therefore narrate 643.54, not the reconciled 696.84. EUR is worse: a
  **`Trade | EUR | 1266250`** row — a value three orders of magnitude past
  anything in the corpus, almost certainly an account/reference number or a
  statement identifier misparsed as an amount, under a category name that is not
  one of the corpus's. The excluded Munich train receipt also leaked again as
  `Transport | EUR | 49.90`. Distinct from every mechanism bug logged above: the
  save/query machinery worked and wrote confidently wrong data. Not investigated
  — needs the source rows traced back to their `document_path` (both are recorded
  in the table, so this is directly checkable on a re-run).
- 2026-08-13 **Round 5, unforced: none of the above recurred, and the numbers
  were exact.** Turn 2's INSERT wrote 6 aggregated rows — Fuel 215.60,
  Groceries **140.75** (round 4: 87.45), Internet 29.99, Transport 50.00,
  Utilities 260.50, all BGN, plus `Uncategorized EUR 196.40`. The BGN rows sum
  to **696.84, the deterministic fact pipeline's reconciled figure to the
  cent**. No `Trade | EUR | 1266250` row, no fabricated hashes. Turn 1's prose
  (written before any INSERT existed) cited per-category source documents by
  name — "Fuel receipt 09/06 and 25/06", "Internet payment 12/06". Whatever
  round 4 measured, it was not a stable property of the model; one forced-skill
  run was too thin a base for the "confidently wrong data" reading, and this
  entry should not be treated as an established defect.
  **One real accuracy defect does remain, a different one:** turn 1 closed with
  "The total amount across all indexed documents for June 2026 is **893.24**
  (696.84 BGN + 196.40 EUR)" — two currencies added into a single figure. It
  disclosed the components, so `noFxBlend` passed, but `fullMonthGate` caught
  it. That is the only genuine model-side accuracy failure in the run — and a
  real negative result for the fix attempted on it: this is the same `893.24`
  blend that `skills/document-intelligence/SKILL.md`'s currency rule was
  extended to cover on 2026-08-13, and round 5 is the first run where that
  wording was actually in context on the offending turn (stickiness held
  `sysHash` constant through turn 1). It did not prevent the blend. Unlike the
  §5 rounds, this wording has had a fair test and failed it; prefer a mechanism
  (total per currency out of SQL, so no single figure exists to blend) over
  another sentence.

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

## Deployment — production Compose migration ownership

- 2026-08-13 `docker/docker-compose.prod.yml` mounts `../db/migrations` into
  Postgres' `/docker-entrypoint-initdb.d`, while `docker/docker-compose.yml`
  explicitly says not to do this: raw initdb execution bypasses
  `schema_migrations`, after which Aperio's migration runner can try to apply
  `001_init.sql` again. The v0.68.0 manual therefore does not present the
  production Compose file as a verified installation path. Reconcile the
  production file with the migration runner, then prove first boot and restart
  against an isolated empty volume before documenting support.

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
