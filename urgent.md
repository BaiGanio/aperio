# Urgent — from the 2026-08-13 T-L4.3 WS2 gemma4 run

Four issues found live-debugging the WS2 T-G2.3 provenance harness
(`node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs`,
`DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`).
Full turn-by-turn evidence, exact numbers, and the grader-bug fixes already
shipped for this run live in
`trash/plans/document-intelligence-epic/document-intelligence-ws2-tg23-open-issues.md`
(top section) and `id/reference/tech-debt.md` (two new sections: "Tool
profiles / schema budgeting" and "Document Intelligence — save/insert
mechanics on gemma4 (#250)"). This file is the pick-a-thread entry point —
each item below is independent; don't try to fix all four in one pass.

Context epic: document-intelligence #250, WS2 hero-model gate. WS4/T-G6
stays blocked until these clear.

---

## 1. Cache-reuse gap — root-caused, not fixed (latency)

**What's wrong:** the tool-schema set's *byte content* changes turn to turn
(tool count swung 38→40→38 across one 7-turn conversation) even when the
logged `profiles=[...]` label summary (`lib/agent/index.js` `logTurnOnce`)
looks identical between turns. Since llama.cpp's Jinja tool-calling
templates render the tools block near the very front of the prompt, any such
shift collapses llama-server's prefix-cache similarity from ~0.99 to
~0.2-0.3 (confirmed via the server's own `slot get_availabl` log line:
`sim_best`/`f_keep`), forcing a near-total reprocess of the whole growing
conversation (30K+ tokens, 150-210s at dev hardware's throughput) on that
turn alone. This is the dominant driver of the multi-minute turn latencies
this epic has been chasing.

**Likely cause:** the sticky-pin "carry forward" logic (commit `f1377b1e`,
`lib/agent/turn-planner.js`) adding a newly-invoked tool (e.g. `db_query`)
into later turns' schema sets — so the *label* list (`profiles=[...]`) can
stay the same while the actual resolved tool *names* set underneath it does
not.

**How to reproduce:** re-run the harness command above with
`APERIO_LOG_CACHE_FINGERPRINT=on` (new opt-in diagnostic, off by default,
shipped this session in `lib/agent/providers/llamacpp.js` — logs a hash of
the exact system-prompt/tools bytes sent per request at `logger.info` level).
Compare consecutive `[llamacpp] fingerprint ... toolsHash=...` lines against
llama-server's own log (now captured to
`trash/plans/document-intelligence-epic/llamacpp-latency/server-log-latest.log`,
gitignored, before scratch cleanup — fixed an ordering bug this session
where the old capture ran *after* `gracefulShutdown()`, which deletes that
same file as part of normal `stopLlamaCpp()` shutdown). Feed the log to
`node scripts/prompt-cache-bench.js trash/plans/document-intelligence-epic/llamacpp-latency/server-log-latest.log`
for a human-readable per-request reuse report.

**Fix direction (not attempted):** either stop `capToolsForProvider`/the
carry-forward fold from changing the resolved tool SET once a conversation
is underway (pin harder than today's within-turn-only pin), or find a way to
keep the tools block's rendered position/content stable across turns
regardless of which tools get added later (template-dependent — may not be
controllable from the request side at all).

---

## 2. Hallucinated re-insertion (data integrity — the serious one)

**What's wrong:** told to "finish saving them now" on a second save attempt
(without being told to check existing state first), gemma4 did not run
`db_query`/`db_schema` to see what was already saved — it inserted 12 new
rows with:
- **fabricated placeholder hashes** (`"hash1"`–`"hash12"` literally, not real
  document `sha256` values)
- **invented category labels that don't exist in the source documents**
  (`Rent`, `Subscriptions`, `Bills/Housing` — the real categories are
  Utilities/Fuel/Groceries/Transport/Internet)
- **systematically mismatched `amount_normalized` vs `original_amount_string`
  pairs** (e.g. amount `95.6` paired with original string `"29.99"` — two
  different real documents' values shuffled together)
- **2 of the 3 explicitly-excluded EUR travel receipts reclassified as
  legitimate categorized spending** (Munich train → `Subscriptions`, Berlin
  hotel → `Bills/Housing`) — the exact exclusion the fixture tests for

This is not a wasteful duplicate-save; it's confabulated financial data
written into the user's real database as if genuine.

**Fix direction:** SKILL.md (`skills/document-intelligence/SKILL.md` §5)
doesn't currently tell the model to verify existing state via
`db_query`/`db_schema` before a second save attempt on the same
table/period. Needs a SKILL.md wording iteration plus a fresh live gemma4
run through this same harness to validate the fix actually changes the
behavior (not just reads well).

---

## 3. Per-row INSERT despite explicit multi-row guidance

**What's wrong:** the same 12-row batch above was issued as 12 separate
single-row `db_execute` confirms, not the one multi-row
`INSERT ... VALUES (...), (...), ...` statement — even though the follow-up
prompt *itself* said "a single multi-row INSERT is fine — it's still one
statement" and SKILL.md §5 already says the same thing independently. This
confirms the gap is live and reproducible, not stale/already-fixed.

**Fix direction:** likely needs to interact with fix #2 above — if the model
stops re-deriving/re-inserting from scratch on a second attempt, this may
partially resolve itself. Worth re-checking after #2 lands before writing a
separate prompt fix.

---

## 4. Wrong column name in the model's own follow-up query

**What's wrong:** turn 4 ran
`SELECT ... SUM(amount) ... FROM spending_june_2026`, but the model's own
`CREATE TABLE` (confirmed two turns earlier, and re-confirmed via its own
`db_schema` call in this same turn, right before the failing query) named
the column `amount_normalized`, not `amount`. The failed query then ran into
the 600s per-turn hard timeout with no retry, cascading into two more turns
of empty answers (the known "broken connection after hard timeout" pattern
seen in earlier runs too).

**Fix direction (cheapest of the four):** either tell SKILL.md to always
re-read the exact column names from the just-returned `db_schema` result
before writing a query against them, or add a same-turn retry in the agent
loop when `db_query` fails with a `no such column` error (the model already
has the schema in context — a nudge-and-retry might resolve without any
SKILL.md change at all).

---

## Already fixed this session (context only, no action needed)

- FX-blend grader false-negative ("no single grand total" disclosure
  phrasing) — `tests/fixtures/household-gen/harness-gate.mjs`, regression
  test added, 20/20 pass.
- `insertedRealRows()` harness check was structurally blind to a real
  confirmed INSERT (only scanned `toolCalls[].detail`, which never holds the
  execution ack — that lands as plain assistant text on a later turn) —
  `document-intelligence-skill-harness.mjs`. Verified against this run's raw
  unredacted artifact: 13 real rows did land despite the check saying false.
