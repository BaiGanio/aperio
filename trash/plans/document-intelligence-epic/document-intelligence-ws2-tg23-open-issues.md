# WS2 T-G2.3 (SQL provenance) — passes on DeepSeek, genuinely FAILS on gemma4 (2026-08-02)

**Context:** issue #250, WS2 (`skills/document-intelligence/SKILL.md`). T-G2.1
(routing), T-G2.2 (coverage), T-G2.4 (no-FX honesty) all PASS live on
`unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`. T-G2.3 (SQL provenance — the model
saves a category breakdown to the `extraction` connection, then reports the
total from a `db_query`, not mental arithmetic) did not pass as of the
2026-08-02 morning attempts (see history below). A same-day evening rerun on
**DeepSeek `deepseek-v4-flash`**, after the fixes below, produced a **full
clean pass** — `grading.status: "pass"`, all 8 checks true, zero failures.
Evidence: `document-intelligence-tg23-provenance-pass-2026-08-02.json` (kept
permanently in this directory, unlike `document-intelligence-run-answers.json`
which every run overwrites and which stays restored to baseline via
`git checkout --`).

That DeepSeek pass was, until this session, the *only* automated run of this
harness's `provenance` phase — the harness hardcoded `EVALUATION_PROVIDER`/
`EVALUATION_MODEL` to DeepSeek or Codex and refused any `LLAMACPP_MODEL`
override. **The T-G2.1/2.2/2.4 "PASS live on gemma4" claim above was never
validated through this harness/mechanism** — it must have come from a
different (manual or live-chat) check. This session added an additive
`DOCINT_EVALUATION_PROVIDER=llamacpp` path (see harness comment block, top of
file) and ran `provenance` against the actual target model for the first
time. **Result: `grading.status: "pass"` is a false pass — the real T-G2.3
behavior fails on gemma4.** See below.

---

## gemma4 run, 2026-08-02 — mechanical PASS, real FAIL

Command:
```
DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
  LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL \
  node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
```
Evidence (raw, unredacted): `document-intelligence-tg23-provenance-gemma4-2026-08-02.json`.

Isolated llama-server booted cleanly (offline, model already cached — no
download), served ctx=113,664 (LLAMACPP_CTX=104,570), and was killed cleanly
by the harness's own `gracefulShutdown` in `finally`, per the log. Two turns
ran to completion; the dynamic follow-up loop stopped after the *first*
scripted follow-up (never reached the 2nd–8th escalating prompts) because its
own "satisfied" check was fooled — see below. Wall time: turn 1 ≈358s
(includes model-load/warm cost baked into the first real request — the
harness's `modelPreload` step logged the model becoming "resident and prompt
cache warmed" at +16s, so most of the 358s is genuine turn time, not boot
cost), turn 2 ≈367s (`input_tokens=41,479, output_tokens=1,262,
thinking_tokens=873`, ~30.5 predicted tok/s).

All 8 mechanical checks report `true` and `grading.status: "pass"`. The
actual transcript shows why that's wrong:

1. **The model never inserted a single row.** Turn 1's only `db_execute` was
   `CREATE TABLE IF NOT EXISTS transactions (...)` — no `INSERT` was ever
   attempted, in this turn or the next. `rowsAffected:0` on the confirm ack
   said so explicitly, and nobody read it.
2. **Turn 2 ran a real `db_query`** (`SELECT ... SUM(amount_numeric) ...
   GROUP BY currency, category`) **and it correctly returned zero rows** —
   the query and the database are not at fault; the model just never wrote
   the data self-consistently within the confirm flow.
3. **The model's own answer admits this**, in plain prose: *"it returned no
   results... the subsequent data insertion process did not successfully
   commit... I cannot pull the data directly from the database right now, I
   will provide the exact breakdown... based on the structured data I
   successfully extracted from the documents in the previous step."* It then
   recites the category breakdown **from memory/mental arithmetic** — the
   exact failure mode T-G2.3 exists to catch — while being honest about
   doing so. This is a genuine T-G2.3 failure, softened only by the model not
   lying about its source.
4. **It also blends currencies without disclosure**, the exact T-G2.4
   failure mode: after correctly separate BGN/EUR category tables, it adds a
   closing line, *"The total cost... is **893.24** (696.84 BGN + 196.40
   EUR)"* — arithmetically summing two different currencies into one number
   with no FX rate, no caveat, presented as "Overall Grand Total". Compare to
   the DeepSeek pass, which explicitly refused to do this ("I'm not
   combining the two currencies into one number because that would require
   an FX conversion I haven't been asked... authorized to apply").

### Why the grading missed both

- `followUpCitesSql` (`/sql|query|db_query/i` anywhere in the answer) and
  `followUpNarratesDecimalTotal` (a decimal-shaped total, gated only on not
  starting with the raw `✅ Executed on` ack) both match an answer that
  *narrates why the query failed* and then states a total anyway — the
  checks were written to reject a raw tool ack (problem #2 in the log below)
  but never anticipated a prose paragraph that mentions "query" while openly
  abandoning it. `hasNarratedDecimalTotal`/`followUpCitesSql` need a check
  along the lines of: the SQL citation must accompany an *actual reported
  row/value*, not an admission the query came back empty.
- The dynamic follow-up loop (`followUpSatisfied` in
  `document-intelligence-skill-harness.mjs`) stopped as soon as those two
  checks passed on turn 2 — so the loop's own 2nd scripted prompt ("If the
  rows aren't in the table yet, finish saving them now...", written for
  exactly this scenario) was never sent. A "satisfied" check this permissive
  defeats the escalation ladder it sits on top of.
- `noFxBlend` is `evaluation.gate.noExcludedLeak` from
  `tests/fixtures/household-gen/harness-gate.mjs` — despite the name used in
  this harness, that gate checks whether *out-of-scope* documents (tax
  notices, trade docs, templates — genuinely excluded from June household
  spending) leak into a category total. It has nothing to do with currency
  blending. The actual FX-blend guard riding along is `grandTotalCorrect`
  (`grandTotals.some(v => close to expectations.monthlyTotal)`) — a
  **permissive "any matching line" check**, not an exclusive one. gemma4's
  answer contains both a correct, separately-labeled `696.84 BGN` total
  *and* the blended, undisclosed `893.24` — `grandTotalOk` only requires the
  first to exist somewhere in the text, so the second sails through
  unflagged. This is a real gap for any future model that hedges its bets by
  including both a correct and an incorrect total in the same answer.

### Bottom line

Do not read WS2's T-G2.3/T-G2.4 as closed for the actual target model. The
DeepSeek pass validates the skill's guidance is *followable*; it does not
validate gemma4 follows it. Before calling this gate genuinely done:
(a) tighten `followUpCitesSql`/`followUpNarratesDecimalTotal` to require an
actual queried value, not just SQL-flavored prose about failure;
(b) tighten `grandTotalCorrect` (or add a dedicated blend check) to fail when
*any* total-shaped line combines multiple currencies without an explicit
conversion; (c) re-run this exact harness invocation against gemma4 after
any SKILL.md change intended to fix the underlying non-insertion behavior,
and confirm turn-by-turn, not just `grading.status`.

---

## Update 2026-08-02 (same day, later session): harness fixed; gemma4's real
## blocker turns out to be latency, not a SKILL.md gap

All three grading-harness bugs above are fixed in
`trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs`
and `tests/fixtures/household-gen/harness-gate.mjs`:

- `followUpCitesSql`/`followUpNarratesDecimalTotal` now require the follow-up
  turn's own `db_query` to have actually returned non-empty rows (parsed from
  the tool result's `detail`/`summary`, via new `dbQueryReturnedRows()`) before
  crediting any prose about a total; a new `insertedRealRows()` check
  separately requires a confirmed `db_execute` **INSERT** with
  `rowsAffected>0` somewhere in the conversation — a confirmed `CREATE TABLE`
  with zero rows affected, as gemma4 produced, no longer satisfies
  "db_execute was exercised."
- `grandTotalCorrect` (`tests/fixtures/household-gen/harness-gate.mjs`) is now
  exclusive: any total-cue line that combines two or more currencies into one
  figure without an explicit non-blending disclosure fails the gate on its
  own, even when a separate, correct BGN-only total line exists elsewhere in
  the same answer — closing exactly the "893.24 (696.84 BGN + 196.40 EUR)"
  gap. 2 new mutation tests added (`harness-gate.test.mjs`); 19/19 pass.
- `followUpSatisfied` (the dynamic follow-up loop's stop condition) now also
  requires `dbQueryReturnedRows()` on the latest turn before stopping, so the
  escalation ladder no longer cuts short on an honest "the query came back
  empty" admission.

**Re-running the fixed harness against gemma4 twice, back to back, confirms
the grader no longer false-passes — `grading.status: "fail"` both times, for
accurate reasons — but also surfaces that gemma4's real blocker here is
latency, not a SKILL.md guidance gap:**

- **Run 1**: turn 1 ran the full 600s timeout without completing. The raw
  output contained a malformed pseudo-tool-call
  (`<execute_tool_call>db_execute{...}</execute_tool_call>`, with
  `<|"|>`-style placeholder quote tokens) instead of a real structured tool
  call. `lib/tools/executor.js`'s leak-detection regex
  (`TOOL_LEAK_PATTERNS`) does not catch this exact tag shape — a real,
  separate, low-risk bug — but generation itself never terminated within
  budget, which no leak-detection fix addresses on its own.
- **Run 2** (immediate re-run, same model/prompt): behaved completely
  differently — real `db_execute` calls, a real confirmed `CREATE TABLE`,
  real INSERTs. But turns 1-3 each took 350-410 **seconds**, and turn 4
  (asked only to run a `SELECT`) then *also* hit the full 600s timeout.
  Turn 3's own usage numbers (39,498 input tokens, 2,409 output tokens) imply
  roughly 140-165 tok/s prefill dominating the turn, not generation speed —
  and this matches an identical calculation against the already-recorded
  DeepSeek/gemma4 pass above (41,479 input tokens, 367s turn → ~140 tok/s).
  Total session time ≈29 minutes; still never reached a real `db_query` with
  rows.

Root cause (verified against the code, not just inferred from timing):
`lib/agent/index.js`'s `ensureTurn()`/`planTurnTools()` picks a different
tool-schema subset **every turn**, driven by that turn's own message text
(`classifyProfiles()`) plus a shrinking-context schema-budget cap
(`capToolsForProvider`). Since the `tools` array is sent fresh on every
`/chat/completions` request and virtually every tool-calling chat template
renders it near the start of the prompt, any difference invalidates
llama-server's default prefix/KV-cache reuse for the **entire** growing
conversation on every turn where the tool set changes — which is most turns.
Large `doc_batch` results (55.9 KB / ~14K tokens in this run, re-read a
second time mid-conversation in run 2) then get fully reprocessed from
scratch, repeatedly, as the conversation grows.

**This is not a SKILL.md wording problem** — no prompt change fixes a
structural cache invalidation. A full investigation and remediation plan is
written up separately: `trash/plans/document-intelligence-epic/llamacpp-latency/`
(`llamacpp-multiturn-latency.md` + companion tests). WS2's T-G2.3/T-G2.4 on
gemma4 stay open pending that plan; this file's harness-grading concerns are
now closed.

---

## DeepSeek run, 2026-08-02 — full clean pass (unchanged from the original writeup below)

Model under test: **DeepSeek `deepseek-v4-flash`**, via the cloud API — the
harness's `EVALUATION_PROVIDER`/`EVALUATION_MODEL` default to this pair and
refuse any fallback other than Codex `gpt-5.6-terra` or the new, explicit
`llamacpp` override described above. This remains a cloud-provider
verification of the skill's followability, not a substitute for the local
llama.cpp check above.

Re-run with:
```
DOCINT_PHASE=provenance node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
```
(`DEEPSEEK_API_KEY` must be set; no other env var is required.) Run in
background — a clean pass now takes ~3 turns / ~2.5 minutes total, but a
regression could still run long. Restore
`document-intelligence-run-answers.json` via `git checkout --` afterward (the
harness overwrites it every run).

---

## What actually fixed it

### #5 (per-row INSERT) — confirmed fixed
The SKILL.md §5 guidance ("a multi-row INSERT is one statement — prefer it
over one confirm per row") worked. The passing run's turn 2 issued exactly
one `db_execute` INSERT with a 13-tuple `VALUES (...), (...), ...` and one
flat `params` array, covering all 13 extracted rows in a single
propose/confirm round-trip — not 13 separate ones.

### #3 (turns getting slower as context grows) — reframed, not confirmed as an independent bug
The original theory (each turn re-sends the full growing conversation, so
per-turn wall time climbs with it, eventually timing out) turned out to be
incomplete. Two pieces of evidence:

1. **Token growth does not correlate with wall time.** A live instrumented
   run on 2026-08-02 (added `usage` capture to `runTurn`'s `finish()` in the
   harness — the provider already emits `usage: {input_tokens, output_tokens,
   thinking_tokens}` on `stream_end`, per `lib/agent/providers/deepseek.js`,
   but the harness was discarding it) showed `input_tokens` climbing
   26,629 → 38,128 → 41,578 across three follow-up turns while `wallMs` fell
   20,545 → 17,197 → 13,822 over the same turns. Growing context alone does
   not appear to slow this model down on DeepSeek's side.
2. **#5 was very likely the actual driver of the old #3 symptom.** The old
   slow/timeout attempts needed 8+ follow-up turns because the model was
   writing one row per `db_execute` confirm round-trip. Each extra
   round-trip is an extra full-history resend — more turns, more chances for
   a slow individual API call, and a much bigger cumulative context by the
   time narration was attempted. The 2026-08-02 evening pass, with #5 fixed,
   finished in 3 turns and never got near the token counts the earlier bad
   runs reached (max seen: ~41K tokens in the instrumented probe run before
   it was intentionally stopped; the actual pass topped out at 20,249). With
   the conversation this much shorter, whatever caused the old 5-10 minute
   turns and one timeout never got a chance to manifest.

**Not fully ruled out:** whether wall time would eventually climb at token
counts well beyond what these runs reached (50K+). The instrumented probe run
was deliberately killed early (on request) as soon as two consecutive
`input_tokens` increases were observed, specifically to avoid burning a full
15-45 minute run once the growth trend itself was the only thing being
tested — so it never got the chance to run long enough to test that. If a
future regression reintroduces per-row writes (or some other cause of long
multi-turn conversations), re-check with the same `usage`-logging
instrumentation (still in `document-intelligence-skill-harness.mjs`,
`runTurn`'s `finish()`) before assuming it's a context-growth problem again.

### #1, #2, #4 — fixed and now confirmed by this clean run
See below for the original write-ups; all three are now validated end-to-end
by the 2026-08-02 pass, not just by code inspection.

---

## Original fix log (2026-08-02, morning attempts)

### #1 — fixed follow-up turn budget
**Symptom:** the harness's `provenance` phase asked a fixed number of
follow-up questions after the main save prompt. The model would finish the
confirmed `db_execute` write and the harness would run out of turns before a
`db_query` call ever narrated the SQL-derived total back.

**Fix:** `runPromptSequence` (~line 258) now accepts a `dynamicFollowUp(turns)`
callback instead of (only) a fixed `followUps` array; the `provenance` phase
(~line 388) loops up to 8 escalating follow-up prompts, stopping as soon as
`followUpSatisfied` is true.

### #2 — the "satisfied" check false-positived on a raw tool ack
**Symptom:** the loop's stop condition originally accepted any answer
containing a digit, so a `db_execute` write's own
`✅ Executed on extraction (sqlite). {"rowsAffected":...}` acknowledgment
(which always contains digits) could satisfy it even with no total ever
stated in prose.

**Fix:** `followUpSatisfied` (~line 396) now rejects any answer matching
`^✅\s*Executed on` and requires a decimal-shaped figure
(`/\d+[.,]\d{1,2}\b/`) instead of a bare digit.

### #4 — WS message-listener leak (harness bug, unrelated to the skill)
**Symptom:** `runTurn` (~line 166) registered `ws.on("message", onMessage)`
and `ws.on("error", ...)` on a WebSocket connection shared across an entire
prompt sequence, but never removed them when a turn finished. Listeners
accumulated turn-over-turn, causing duplicate tool-call logging and harmless
but wasteful duplicate interrupt-approval sends.

**Fix:** `finish` and a named `onError` handler now both call
`ws.off("message", onMessage)` / `ws.off("error", onError)`, guarded by a
`settled` flag so cleanup runs once per turn.

---

## Minor, not tracked as a blocker

The passing run's turn 3 issued the same `SELECT ... GROUP BY category,
currency` query shape 3 times (a row-count sanity check, the breakdown query,
then a currency-totals query) — harmless and not a repeat of the *same*
query, so not the redundant-requery pattern seen in some earlier attempts,
but worth a glance if a future run shows genuinely identical repeated
queries.
