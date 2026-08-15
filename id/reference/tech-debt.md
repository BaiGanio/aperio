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

- 2026-08-15 **`aperio-continuous-audit-tests.md`'s T1–T9 test plan (dated 2026-07-12,
  332 lines, the plan's own mandatory TDD companion) has no matching code anywhere in the
  repo.** Its coverage map names concrete scripts to verify — `audit/scripts/inventory.js`,
  `audit/scripts/schema.js` — and neither path exists, tracked or untracked
  (`git log --all -- audit/` is empty). No `tests/**/*audit*` file exists either. The plan's
  own opening line states the requirement directly: "each new drift gate must demonstrate
  that it detects a deliberately mutated fixture or known baseline mismatch before it is
  trusted." That demonstration was never built, for either run.
  Both Run 1 and Run 2 nonetheless produced real output — `baseline.json`, `matrix.json`,
  per-slice reports, `findings.json` — but it lives under `trash/audits/continuous-audit/
  runs/{run-001,run-002}/`, not `audit/` as the plan and `next-session.md` describe, and
  none of it was produced through code that the T1–T9 suite would have exercised.
  Impact: every finding from both runs (including the 6 from Run 2, e.g. F-R2-01/F-R2-05,
  already filed as issues #470–#475 per [[project_continuous_audit_run2]]) rests on
  tooling and a repo-inventory process that was never verified against a deliberately
  mutated fixture, contrary to the program's own stated bar.
  **T1 built 2026-08-15.** `audit/scripts/inventory.js` is now a real, checked-in,
  reproducible generator (git branch/commit/dirty-paths, Node/npm versions,
  source/test file counts by area, the provider list read from `lib/config.js`'s
  `AI_PROVIDER` options — not hardcoded, migration names/parity from both migration
  dirs, locale codes, config-key count) replacing the model-typed `baseline.json` that
  Run 1/Run 2 actually produced. `audit/tests/inventory.test.js` covers T1.1
  (repeated inventory is byte-identical except `observed_at`) and a red/green proof:
  verified live by stubbing `providerList()` to `["stub"]` — test failed with a clear
  diff — then reverting — test passed again. This is the T1 subset only; T2–T9
  (contract/drift gates, ledger schema, evidence packets, red-first baseline runner,
  wave/journey/triage machinery) remain unbuilt. Run 3 should not start new slices
  claiming "verified" beyond T1 — the baseline step is now real, the drift-gate and
  finding-ledger steps still are not.
  **Second bug found while wiring this in, caught by the developer running
  `npm run test:audit:inventory` and getting "file not found":** `package.json`
  already had `test:audit`, `test:audit:inventory`, `test:audit:schema` (and 5 more)
  committed and pointing at `trash/audits/continuous-audit/tests/*.test.js` —
  a path under `trash/*`, which `.gitignore` excludes entirely except
  `trash/plans/`. So even if a past session had written those test files, git
  would never have tracked them; the scripts were dead on arrival for anyone but
  the session that typed them, on that session's own machine. Confirmed via
  `git log --all --diff-filter=A --name-only` across full history: no commit ever
  added a file at either that path or the original pre-rename `audit/tests/...`
  path it was renamed from — the npm scripts were written before, and never
  followed by, the files they point to.
  **Fixed 2026-08-15**: the T1 test moved to `audit/tests/inventory.test.js`
  (not gitignored) and the 3 scripts above repointed from `trash/audits/
  continuous-audit/tests/` to `audit/tests/`. `npm run test:audit:inventory`
  passes. The other 5 filenames in the `test:audit` composite (`schema`,
  `manifest`, `database-contract`, `config-contract`, `routes-contract`,
  `memory-contract`, `bootstrap-contract`) got the same path fix but still
  don't exist — that's T2–T4 scope, not touched here.

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

> **Paths moved 2026-08-15.** `msgdiff.py` and
> `document-intelligence-skill-harness.mjs` now live in `tests/docint/harness/`
> — read on as shipped test tooling, not a plan (see [#455W1.9]). Entries below
> written before that date name the old `trash/plans/document-intelligence-epic/
> llamacpp-latency/…` paths.

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

> **Paths moved 2026-08-14.** The grader now lives in `tests/docint/`
> (`grading.mjs`, `grading-predicates.mjs`, `provenance-ladder.mjs`,
> `write-claims.mjs`, `replay-grading.mjs`) and is run by `npm test` /
> `npm run test:docint` — 82 tests that no CI run previously executed. Entries
> below written before that date name the old `llamacpp-latency/…` paths;
> `tests/fixtures/household-gen/harness-gate.mjs` did not move, only its test.

- 2026-08-14 **FIXED — the T-L4 per-turn ceiling was a guess, and it was failing
  substantive passes.** (`llamacpp-latency/grading.mjs`) The 550,000 ms per-turn
  value was chosen before anyone had watched a turn run to completion on this
  corpus, so it encoded an assumption about turn length rather than a
  measurement of one. It failed exactly one run on its own — Ornith run 1,
  whose T-G2.3 *and* T-G2.4 both passed and whose only `failures[]` entry was a
  589,813 ms turn 0 — and it would have failed gemma-4-26B-A4B's clean pass too
  (682,006 ms). **Demoted to a reported metric**: `withinPerTurnWallClockCeiling`
  is still computed and now rides in T-L4's `context` alongside the raw
  `maxTurnWallMs`/`totalWallMs`, but no longer contributes to `failures[]`. The
  TOTAL ceiling stays a real gate — a run that never terminates is a genuine
  failure — and a test pins that, so the demotion cannot quietly widen. Replay
  of Ornith run 1 flips `fail → pass` with `failuresIntroduced: []`. Still open:
  a per-turn ceiling *derived from observed times across models* would be worth
  having; none exists, and reinstating the old number is not the way to get one.
- 2026-08-14 **No check covers a model asserting writes it never made.**
  Ornith's passing run 2 answered that the three EUR travel receipts "are saved
  separately". Its single INSERT was 10 tuples, `BGN`×10, `EUR`×0, and the
  turn-2 `GROUP BY category, currency` returned BGN-only — so no EUR row ever
  existed. (Its "10 rows inserted" claim, by contrast, was true; the defect is
  one fabricated write-claim, not a fabricated row count, and a check should
  target exactly that.) `insertedRealRows` only asks whether *some* confirmed
  INSERT landed — its own comment says "regardless of what the answer claims" —
  so nothing compares the set of rows an answer says it saved against the set
  actually written. Squarely in T-G2.3's spirit: the gate exists to stop prose
  outrunning the database. gemma-4-12B showed the same family from the other
  side, querying `FROM expenses`, a table it had never created.
  **FIXED 2026-08-14 (later session) — and it voids the Ornith pass.**
  `tests/docint/write-claims.mjs`, wired into `gradePhase` as the T-G2.3 check
  `noPhantomWriteClaims`. It compares the currencies an answer claims to have
  written against the currency literals in the run's own confirmed INSERTs.
  Built to avoid becoming the fifth false-failure of the prose-matching class,
  so it is strict on five counts: currencies come from the ORACLE
  (`expectations.excluded`) plus what was actually written, never from the
  answer's prose; only PREDICATIVE storage verbs count ("are saved", "I stored
  them", "written to"), so the adjectival "the saved records" is read as a read;
  negated/modal/future claims are ignored; an anaphoric claim ("These are
  saved") inherits its currency only from the nearest preceding sentence in the
  same block naming exactly one, and anything ambiguous stays SILENT; and it
  disarms entirely unless some other currency was written as a literal, so a
  schema that never stores a currency code cannot produce a violation.
  Validated by replay against all three archived transcripts, no boot:
  **Ornith run 2 flips `pass → fail`** on exactly this check, with every other
  T-G2.3 check still green and T-G2.4/T-L4 still passing (one failure
  introduced, zero collateral); **gemma-4-26B-A4B's pass is unchanged** — a real
  negative control, since its INSERT genuinely carried `EUR`×3 alongside
  `BGN`×10; Ornith run 1 unchanged. 13 tests in `write-claims.test.js`, both
  anchor cases verbatim from the two archived runs.
  **Consequence for the epic, not just the harness:** the claim that
  Ornith-1.0-9B was "the first local model to pass T-G2.3" no longer holds. The
  surviving local pass is gemma-4-26B-A4B — but it was earned at
  `successTurn: 4` on the `dictated-sql` rung, i.e. `capabilityClaim:
  mechanism-conformance`, not realistic usage. **No local model has a
  realistic-usage T-G2.3 pass.** WS4/T-G6 does not open on this.
  Still open, deliberately not attempted here: the gemma-4-12B side of the
  family (querying a table never created). It is a phantom READ rather than a
  phantom write, needs different evidence (system/pre-existing tables have to be
  excluded), and no current run is blocked on it.

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
- 2026-08-13 **FIXED — `fullMonthGate`'s multi-currency rule produced false
  failures on correct per-currency answers.** (`tests/fixtures/household-gen/
  harness-gate.mjs`) Observed twice: round 11's
  `"**Overall Combined Total:** **912.44 BGN + 196.40 EUR**"` and an earlier
  `"...grand total across both currencies is **696.84 BGN** and **196.40 EUR**."`
  were both failed as "combines multiple currencies into one figure without
  disclosing that it isn't converting" — while each states two figures, one per
  currency, and round 11's very next line read *"(Note: No FX conversion was
  applied, as per the core principles of the `document-intelligence` skill.)"*
  The disclosure the rule demanded was present and adjacent, and it fired anyway.
  The rule tested whether a total-cue line *named* two currencies; it now tests
  whether some figure on that line carries no currency of its own
  (`untaggedMoneyTokens`), because a blend is a figure that spans currencies,
  not a line that mentions two.
  `912.44 BGN + 196.40 EUR` (two figures, one per currency) passes;
  `893.24 across BGN and EUR` and `893.24 (696.84 BGN + 196.40 EUR)` (one
  untagged figure, two currencies) still fail. Blending stays a failure even
  when disclosed on the next line — the wrong number is still stated — so the
  same-line `NON_BLEND_DISCLOSURE` escape is unchanged, and it still covers
  prose that names currencies without tagging any figure. Deliberate and
  unchanged: the gate reads the *combined* text of all turns, so one turn's
  disclosure does not license another turn's blend. 3 tests added from
  the verbatim round-10/11 strings; 23/23 in `harness-gate.test.mjs`.
  Round 11 re-graded: the currency failure disappears, the Fuel double-count
  and the grand total it poisoned remain, so its verdict is unchanged (fail on
  one arithmetic defect rather than three failures). That re-grade is inferred,
  not re-executed — the un-redacted answers artifact had already been
  overwritten by the next run, and the harness redacts every numeral from its
  stdout dump (`document-intelligence-skill-harness.mjs:592`) — but the diff
  touches only `currencyBlendedTotalLines`, leaving `parseCategoryClaims` and
  `parseGrandTotals` byte-identical.
- 2026-08-13 **The harness's stdout dump cannot be re-graded, and its only
  un-redacted artifact is single-slot.** Numbers are stripped from every
  answer before printing (deliberately, to keep oracle-adjacent figures out of
  logs), and the full text goes to one fixed `ANSWERS_PATH` that the next run
  overwrites at startup. So a recorded run cannot be replayed through a later
  grader — exactly the operation every grader fix in this section wants, since
  each was written from one run's transcript and validated against it by hand.
  Cheap fix: write the un-redacted artifact to a per-run path (timestamp or
  run id) so transcripts accumulate, and add a replay entry point that grades
  a saved transcript without booting anything.
  **FIXED 2026-08-13.** Both halves landed. (a) `gradePhase()` moved out of the
  harness into `llamacpp-latency/grading.mjs` as a pure function of its
  arguments — same reason `grading-predicates.mjs` was extracted, one level up:
  the harness's top-level `try` boots a server, a scratch DB and a llama-server,
  so nothing could reach the grader without paying for a live run. Everything it
  used to read from module scope (phase, corpus root, ceilings, ladder) is now
  passed in, so a replay grades under the *recorded* run's conditions rather
  than the replaying shell's env. (b) The harness still writes the historical
  single-slot `ANSWERS_PATH` and additionally archives the identical
  un-redacted payload to `var/docint-runs/<phase>-<runId>.json` (gitignored,
  best-effort — an unwritable archive cannot fail a run). `gradingInputs`
  (corpus root, oracle path, both wall-clock ceilings) is recorded alongside.
  Replay: `node llamacpp-latency/replay-grading.mjs [artifact.json]` — no path
  takes the newest archived run, `--list` enumerates them, and the output
  includes a **diff against the grading the run itself recorded** (status
  change, per-check before/after, failures resolved/introduced), which is
  exactly the "does this fix flip that round?" question every entry in this
  section had to argue by hand. Verified on a real recorded 7-turn run: with its
  ceilings supplied, the replay reproduces the run's own grading with zero
  changed checks and zero failure drift. 11 tests in `grading.test.mjs`.
  Two things found by doing it: the harness's error path calls `writeArtifact`,
  so **an aborted run used to destroy the previous run's only transcript** (the
  archive now survives that), and an unknown corpus root made the path-leak
  checks fire on every answer, since every string contains `""` — guarded in
  both the grader and the replay's fallback. Still open, unchanged: whether
  grading should prefer the turn that *satisfied* the ladder over the last turn
  with content.
- 2026-08-14 **FIXED — the fourth false failure of the prose-matching class: a
  category stated as its components scored as "no figure attributed".**
  Ornith-1.0-9B reported Electricity 142.50, Water 38.20, Heating 64.80 and
  Waste 15.00 — which sum to 260.50 and are **character-for-character the
  components the oracle's own `reconciliation` field lists for Utilities**
  (`"142.50 + 38.20 + 64.80 + 15.00 = 260.50"`) — and `fullMonthGate` failed it
  with `Utilities: expected 260.50, answer attributed no figure to this
  category`. A more granular, fully correct answer scored as a miss.
  Fixed as `statedAsComponents` in `tests/fixtures/household-gen/
  harness-gate.mjs`, with `parseReconciliationComponents` reading the component
  list off the oracle. Strict on five counts so it cannot rescue a wrong answer:
  components come from the ORACLE (never inferred from the answer); every
  component must be present, each matched to a distinct figure; a
  single-component category is skipped (there the direct check is the right
  test); only figures on lines naming no category count; and it applies only
  when the answer attributed **no** figure to the category at all.
  **The last two constraints exist because the first attempt was wrong**, and
  the suite's own mutation tests caught it: the inline parenthetical in
  `CORRECT_ANSWER` ("Utilities: 260.50 BGN (electricity 142.50, water 38.20,
  …)") survives those tests' `.replace()`, so reading components off a line that
  names the category let a correct breakdown launder a false headline figure —
  reintroducing the "right number under the wrong label" false pass the gate was
  built to catch. 6 tests added (30/30 in `harness-gate.test.mjs`), one of which
  names that hazard directly rather than leaving it covered incidentally.
  Verified retroactively via `replay-grading.mjs` on run 1's archived
  transcript: exactly one check flipped (`fullMonthGate` false→true), one
  failure resolved, **zero introduced**, T-G2.3 and T-L4 untouched.
  **Caveat on the live evidence:** Ornith's passing run 2 reported
  `Utilities 260.50` directly, so this predicate never fired on it. The fresh
  evidence is the replay, not the passing run.
  **The class is now at four** (round 8 markdown emphasis, round 9 SQL
  vocabulary, round 11 currency phrasing, this). Every one was found by a run it
  invalidated, and every fix has been reactive. The standing recommendation in
  the pattern entry above — move category/provenance grading off substring
  matching over prose, since `dbQueryReturnedRows`/`insertedRealRows` carry the
  evidentiary weight — is now backed by four instances rather than two.
- 2026-08-14 **FIXED — one `status` was reporting three different gates, and it
  made the model look four times worse than it was.** `gradePhase` ORed every
  provenance-phase check into a single pass/fail, so T-G2.3 (sql-provenance),
  T-G2.4 (no-fx-honesty) and T-L4 (the wall-clock ceilings) were indistinguishable
  in the verdict — three separate claims from `document-intelligence-epic-tests.md`
  collapsed into one number. The cost was not cosmetic: rounds 10 and 11 were both
  recorded as gate failures with **every provenance check green**, round 10 on a
  currency blend (T-G2.4's claim) and round 11 on an arithmetic double-count (an
  extraction defect). Read as one number, four runs looked like "1 pass in 4";
  read per gate, T-G2.3 itself held in three of them, and only round 12's missing
  INSERT was a genuine provenance failure.
  Each check and each failure message is now tagged with the gate that owns it,
  and `grading.gates` reports a per-gate verdict; the harness prints one
  `HARNESS gate <id> PASS/FAIL` line per gate and `replay-grading.mjs` includes
  the split. `completed` is attributed to T-L4, not to provenance — its observed
  shape is a turn that burns its whole budget emitting nothing (round 12) and it
  already travels with a blown per-turn ceiling. A gate with no oracle supplied
  reports `not-evaluated`, never `pass`. The bundled `status` and the `failures`
  array keep their exact previous content and order, so replay diffs against
  older artifacts stay comparable — the split is purely additive. 7 tests added
  (18/18 in `grading.test.mjs`), including round 10's verbatim
  `893.24 across BGN and EUR` line graded against the real June oracle: T-G2.4
  fail, T-G2.3 pass.
  **What this does not settle**: T-G2.4 still fails on gemma4-E4B (2 of 4 runs
  blended, with SKILL.md's counter-example in the pinned system prompt), and the
  Fuel double-count is a real extraction defect. The split makes the epic's
  remaining failures legible and separately closeable; it does not close them.

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
- 2026-08-13 **The EUR row lands as `Uncategorized`/`Travel-Other` (196.40 EUR)
  while every BGN row is categorized.** ~~Currently ungraded~~ **Now graded, and
  the attribution was wrong: this is not model behaviour.** Filed under this
  heading originally; it belongs to the deterministic pipeline. `CATEGORY_RULES`
  (`lib/docgraph/facts/contract.js:78-95`) has no Travel or Accommodation
  category at all and its patterns are Bulgarian + English by construction (the
  docstring says so: "a starting taxonomy, not a claim of universal coverage"),
  so `classifyCategory()` returns `null` for June's three EUR documents — a
  German train ticket, a German hotel bill and a French airport café — and
  `aggregate.js`'s `UNCATEGORIZED` bucket takes them. Verified by running the
  real classifier against all three: `{category: null, score: 0}` each. Round
  12's answer table even labels it `**Uncategorized** (Travel/Lodging)` — the
  model knew what the charges were and was relaying Aperio's own bucket name.
  The oracle disagrees with that bucket: `other_currency_totals.EUR` is 196.40
  over 3 documents and every one of them is `category: "Travel"`.
  **Graded 2026-08-13**: `buildExpectations` now derives `otherCurrencies` from
  the oracle, and the provenance phase gained `foreignCurrencyRowsCategorized`
  — structural, reading the row objects a `db_query` came back with rather than
  the answer prose, deliberately, because three of this gate's checks are
  already substring tests over prose and two of them invalidated whole runs (see
  the grader section above). Containment against the oracle's own category, so
  `Travel-Other` and `Travel/Lodging` pass and `Uncategorized` does not; vacuous
  when the run wrote no foreign-currency row or the rows carry no category
  column. New predicates `queriedRows` (with a brace-matched salvage for a
  `detail` string capped at 2,000 chars by `lib/agent/toolActivity.js`) and
  `unresolvedForeignCurrencyRows` in `grading-predicates.mjs`; 6 + 4 tests.
  Replaying the recorded round-12 run through it introduces no failure — that
  run's only `db_query` returned zero rows, so the check is correctly silent.
  **Still open, and now the real item:** the taxonomy gap itself. A
  document-intelligence product whose corpus spans seven destinations, seven
  languages and four currencies cannot categorise any of the non-domestic
  spending. Fixing it means adding a Travel/Accommodation category with
  de/fr/en patterns to `CATEGORY_RULES` — product code that changes how real
  users' documents are categorised, so it deserves its own review rather than
  riding along with a harness change. Until then this check fails any run whose
  model reports the EUR total from the pipeline's own bucket, and the failure
  message names the taxonomy rather than the model.
- 2026-08-13 **`/\bcafé\b/i` in `CATEGORY_RULES`' Dining rule can never match
  "café".** `é` is a non-word character, so the trailing `\b` demands a word
  character *after* it: the pattern is false for `"Café du Terminal"`, `"café"`
  and `"le café."`, and true only for `"cafés"` — the exact inverse of the
  intent. Found while tracing the EUR categorisation above. Harmless today
  because the unaccented `/\bcafe\b/i` sits beside it and catches the ASCII
  spelling, so only accented text is affected; the fix is dropping the trailing
  `\b` (or using `(?![\p{L}])` with the `u` flag). Worth checking the other
  patterns for the same shape — `/\bбон №/i` and anything ending in a
  non-ASCII letter are candidates.

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
