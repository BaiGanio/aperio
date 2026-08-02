# WS2 T-G2.3 (SQL provenance) — resolved 2026-08-02

**Context:** issue #250, WS2 (`skills/document-intelligence/SKILL.md`). T-G2.1
(routing), T-G2.2 (coverage), T-G2.4 (no-FX honesty) all PASS live on
`unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`. T-G2.3 (SQL provenance — the model
saves a category breakdown to the `extraction` connection, then reports the
total from a `db_query`, not mental arithmetic) did not pass as of the
2026-08-02 morning attempts (see history below). A same-day evening rerun,
after the fixes below, produced a **full clean pass** — `grading.status:
"pass"`, all 8 checks true, zero failures. Evidence:
`document-intelligence-tg23-provenance-pass-2026-08-02.json` (kept
permanently in this directory, unlike `document-intelligence-run-answers.json`
which every run overwrites and which stays restored to baseline via
`git checkout --`).

Model under test: **DeepSeek `deepseek-v4-flash`**, via the cloud API — the
harness hardcodes this (`EVALUATION_PROVIDER`/`EVALUATION_MODEL`, harness
lines ~55-56) and refuses to run with anything else, including any
`LLAMACPP_MODEL` override. This is a cloud-provider verification, not a local
llama.cpp check.

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
