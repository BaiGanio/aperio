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
  node trash/plans/document-intelligence-epic/document-intelligence-skill-harness.mjs
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

## DeepSeek run, 2026-08-02 — full clean pass (unchanged from the original writeup below)

Model under test: **DeepSeek `deepseek-v4-flash`**, via the cloud API — the
harness's `EVALUATION_PROVIDER`/`EVALUATION_MODEL` default to this pair and
refuse any fallback other than Codex `gpt-5.6-terra` or the new, explicit
`llamacpp` override described above. This remains a cloud-provider
verification of the skill's followability, not a substitute for the local
llama.cpp check above.

Re-run with:
```
DOCINT_PHASE=provenance node trash/plans/document-intelligence-epic/document-intelligence-skill-harness.mjs
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
