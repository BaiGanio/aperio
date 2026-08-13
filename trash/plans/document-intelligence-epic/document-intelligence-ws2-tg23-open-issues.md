## Methodology note, 2026-08-13 — provenance-harness prompts read as accountant-speak, not normal-user speech

Raised by the developer while watching this session's live T-L4 runs
(gemma4-E4B, gemma-4-26B-A4B, Ornith-1.0-9B) turn by turn. Short version:
`prompts.md`'s scripted ladder for `DOCINT_PHASE=provenance` (T-G2.3) is not
how a non-technical person talks to a personal memory assistant, at every
rung — not just the openly-dictated SQL in turns 3-4, but turn 0's "save the
results so I can **query** them again later" (presupposes a DB mental model
most users don't have; a real ask names a spreadsheet or just says "keep
track of") and turn 1's "(SUM grouped by category and currency)" (literal
SQL pseudocode in parentheses — confirmed by the developer, who is
technically literate, as "too much even for me").

This is deliberate escalation-ladder design (each rung gets more explicit
only if the model hasn't complied yet, to isolate "can't infer intent" from
"can't execute the mechanism when told exactly how") and it's exactly what
surfaced today's genuine execution-mechanics bugs — but it means a "pass" at
turn 3-4 is a much weaker capability claim than a "pass" at turn 0-1, and
today's `grading.status` doesn't distinguish them. **Every run write-up
below from today onward states which turn a model succeeded or failed at,
explicitly, for this reason** — not just the mechanical pass/fail.

**Implemented and statically validated same day, per the developer's own
redesign spec** — the tech-debt entry this originally spawned
("provenance-harness prompt realism") is resolved and removed:
`trash/plans/document-intelligence-epic/llamacpp-latency/provenance-ladder.mjs`
now holds two ladders, selected via `DOCINT_PROVENANCE_LADDER=mechanism|
natural` (default `mechanism`, so every historical T-L4 comparison stays
valid): the original escalation (kept for diagnosing execution-mechanics
defects) plus a new all-natural-language ladder (no "save/query/SUM/GROUP
BY/SQL/database" vocabulary at any rung). Grading now records `successTurn`,
`successPromptTier`, and `capabilityClaim` (`mechanism-conformance` vs.
`realistic-usage`) so a "pass" no longer has to be manually re-derived from
the transcript. 12 unit tests in `provenance-ladder.test.mjs` pass; both
ladders were dry-run through `--setup-only` (fixture copy + index, no
model/server) without error. **Not yet validated live against an actual
model** — that's explicitly deferred (expensive, stateful); the natural
ladder's real-world behavior on any target model is still an open question.

**First live sample, 2026-08-13, gemma4-E4B, stopped early by the
developer (turn 1 in progress, "there is no point at all"):**
`DOCINT_PROVENANCE_LADDER=natural`, same command/ceilings as every other
run this session. `HARNESS provenance ladder=natural` confirmed the
selector worked. Turn 0 ("Can you keep track of what I spent... tell me the
total?", wallMs=352,994) read documents once and answered — **no
`db_execute` at all**, unlike every mechanism-ladder run, which always did
at least a `CREATE TABLE` on turn 0 (that ladder's opening line explicitly
says "save the results"). Turn 1 ("What did I spend in each category, and
altogether?") triggered a second, redundant `doc_batch` re-read instead of
reaching for persistence or querying, then continued generating for 5+
minutes with no further tool call before being stopped. Schema fingerprint
held flat at `33` (vs. mechanism's usual opening `38` — a smaller attached
profile set, `file-edit` missing, since `classifyProfiles()` reads the
prompt text itself and the natural prompt doesn't trigger it) across both
turns, no swing observed in the two turns that ran.

Too little data for a real verdict, but the one clear signal: **without an
explicit "save"/"query" instruction, gemma4-E4B did not spontaneously reach
for the persistence mechanism at all** — it re-read source material instead
of saving or querying. Whether that's "the model correctly doesn't invent a
DB when the user never asked for one" or "the model fails to recognize an
implicit save/recall need" isn't resolved by this one truncated run. Left
open rather than logged as tech debt — one aborted run isn't enough
evidence either way; re-run to completion (or across more models) before
drawing a conclusion.

---

## Cross-model T-L4 run, 2026-08-13 — E4B (stopped), gemma-4-26B-A4B (FAIL), Ornith-1.0-9B (FAIL, but closest to passing)

**Command (all three, only `LLAMACPP_MODEL` varied):**
```
DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
  LLAMACPP_MODEL=<model> \
  APERIO_HARNESS_WALLCLOCK_TOTAL_MS=2400000 APERIO_HARNESS_WALLCLOCK_PERTURN_MS=550000 \
  APERIO_LOG_CACHE_FINGERPRINT=on \
  node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
```
Ceilings match T-L4.2/T-L4.3 for comparability. Run to validate two changes
landed on `chore/docint-skill-correction-250-signed-by-claude-opus-5`: the
three SKILL.md wording additions (`2f577594`, verify-before-second-save +
strengthened per-row-INSERT bullet + query-own-schema-columns bullet) and
`APERIO_TOOL_PIN_TURNS` default 3→8 (`294a9e56`). Read this section together
with the methodology note above — turn 2 and earlier use natural-ish
phrasing; turns 3+ dictate literal SQL and are a different, weaker kind of
"pass" (none of today's runs reached turn 3+, so that distinction doesn't
bite this time, but the finding stands for whoever reads a future run).

### gemma4-E4B — stopped by the developer at turn 2, not graded

Turn 0 (main prompt): `doc_batch` → `db_schema` (no `extraction` connection,
expected cold) → `db_execute` `CREATE TABLE IF NOT EXISTS monthly_expenses`
(confirmed), no INSERT. wallMs=460,559. Schema fingerprint held at `38`
across both internal calls this turn.

Turn 1 (follow-up 1, "query it per category"): ran a real `db_query`
(`SELECT category, currency, SUM(normalized_amount) ... GROUP BY category,
currency`) — correctly against the same `normalized_amount` column the
turn-0 `CREATE TABLE` used (the Gotchas column-name-consistency guidance
held here, for this one case). Table was still empty at this point (no
INSERT had happened yet), so the query legitimately returned nothing
substantive — this is the same "correct query, empty table" pattern as the
2026-08-02 original run, not a new bug. wallMs=350,469. Schema fingerprint
swung `38→40` right at the turn-0→1 boundary and held at `40` through this
turn — no reversion, unlike T-L4.3's 38→40→38 oscillation (see cache-reuse
note below).

Turn 2 (follow-up 2, "finish saving them now... a single multi-row INSERT is
fine"): **the model correctly attempted ONE multi-row `INSERT` each time —
not 12 per-row confirms — but the statement was structurally malformed on
all three attempts, and it never converged:**
1. `params`: 65 flat values vs. a `VALUES (?,?,?,?,?,?,?)` clause expecting 7
   — the SQL text had only one 7-placeholder tuple while `params` held ~9-10
   rows flattened.
2. Retry: `params` grew to 91 (added a `category` field, still 7 vs. one
   tuple) — same shape of bug, more data, not fixed.
3. Retry: `params` sent as a nested array of 13 seven-element tuples
   (`[[...7 vals...], [...7 vals...], ...]`) — the driver reported "13 were
   provided" against the still-unchanged single-tuple SQL, meaning the model
   changed the params *shape* (flat→nested) without ever adding the missing
   `VALUES (...), (...), ...` tuples to the SQL text itself.

The developer stopped the run here (explicit instruction) before a 4th
retry or a `grading.status` could be produced — **no formal pass/fail for
this run.** This is a new, distinct gap from the three original SKILL.md-
targeted gemma4 gaps (hallucination, per-row habit, wrong column name): the
per-row-INSERT guidance visibly worked (it never fell back to one-confirm-
per-row), but exposed a structural bug in matching a multi-row `VALUES`
clause's placeholder count to a flattened `params` array — logged as new
tech debt below.

### gemma-4-26B-A4B — FAIL, never reached an INSERT

Turn 0: same shape as E4B — `doc_batch` → `db_execute` `CREATE TABLE
June_2026_Spending` (no `IF NOT EXISTS` guard, unlike E4B's and Ornith's
turn 0), confirmed, no INSERT. wallMs=475,515 — comparable to E4B's 460,559.
Schema fingerprint swung `38→40` at the same turn-0→1 boundary as every
other run this session.

Turn 1 (follow-up 1, "query it per category"): **hard-timed-out at
600,047ms with zero tool calls and zero output tokens** — the model
generated internally for the full 10-minute ceiling and produced nothing.
This triggers the known "broken connection after hard timeout" cascade:
turn 3 re-read a document (`doc_batch` on `waste-fee-22-jun.txt`, already
read in turn 0) instead of progressing, and gained an unexplained `shell`
tool profile mid-conversation (same anomaly flagged in the T-L4.2 writeup);
turns 3–7 each completed in ~4,000ms with **0 input/output/thinking
tokens** — completely empty round-trips, never recovering.

`grading.status: "fail"`. `calledDbExecute: true` (the CREATE TABLE only),
`insertedRealRows: false`, `dbQueryReturnedRealRows: false`,
`withinPerTurnWallClockCeiling: false`, `noFxBlend: true` (no blend issue —
it never got far enough to blend anything). Worse outcome than E4B's
partial run: E4B at least attempted (if buggily) a real multi-row INSERT;
26B-A4B never got past table creation before stalling into the timeout
cascade. Cache fingerprint during the cascade oscillated `40→38→40` across
consecutive fast empty turns — the instability the TOOL_PIN_TURNS mitigation
targets is visibly still present once this failure mode kicks in, separate
from the steady-state behavior seen before the timeout.

### Ornith-1.0-9B — FAIL, but the closest any run got to a clean T-G2.3 pass

Turn 0: `doc_batch` → `db_schema` (no connection, expected) → `db_execute`
`CREATE TABLE IF NOT EXISTS june_2026_expenses` (uses the `IF NOT EXISTS`
guard, like E4B). No INSERT. wallMs=416,746 — faster than both gemma runs.
Schema fingerprint `38→40` at the same turn boundary as every other run.

Turn 1 (follow-up 1, "query it per category"): the model recognized the
table was still empty and **saved first instead of querying** — ran one
genuine multi-row `INSERT INTO june_2026_expenses (...) VALUES (...), (...),
...` covering all 13 rows in a single statement (`rowsAffected:13`,
confirmed), with **no params/placeholder mismatch** — the exact bug E4B hit
repeatedly on this same step did not occur here. No `db_query` this turn, so
the turn's own raw answer was just the tool's confirm ack, not a narrated
total — expected, since the prompt's ask ("query it") wasn't literally
fulfilled this turn, but the model's implicit reasoning (save before you can
query) was sound. wallMs=343,262.

Turn 2 (follow-up 2, "finish saving them now... run the per-category SQL
query"): ran a real `db_query`, got real non-empty rows back, and the final
answer **narrates a markdown table built from the query result** — a
genuine, provenance-backed answer:
```
| Currency | Category | Total |
|----------|----------|-------|
| BGN | Utilities | 260.50 |
| BGN | Fuel | 215.60 |
| BGN | Groceries | 140.75 |
| BGN | Internet | 29.99 |
| BGN | Transport | 50.00 |
| EUR | Travel/Meals | 146.50 |
| EUR | Transport | 49.90 |

**Grand total: 893.24** (696.84 BGN + 196.40 EUR)
```
wallMs=54,935 (real `usage`: 47,764 input / 378 output / 148 thinking
tokens) — the run finished here; `followUpSatisfied` stopped the escalation
ladder at turn 2, never reaching turns 3+'s dictated-SQL phrasing. Per the
methodology note above: **this is a turn-2 pass, on phrasing that names the
mechanism but doesn't dictate literal SQL syntax** — a meaningfully stronger
result than a turn-3+ pass would be.

`grading.status: "fail"`, but 8 of 10 checks pass: `insertedRealRows`,
`calledDbQueryAfterConfirm`, `dbQueryReturnedRealRows`, `followUpCitesSql`,
`followUpNarratesDecimalTotal`, `completed`, both wallclock ceilings. The
two real, deserved failures:
1. **Undisclosed currency blend** — `**Grand total: 893.24** (696.84 BGN +
   196.40 EUR)`, the exact pattern SKILL.md §6 exists to prevent. `noFxBlend`
   correctly fails this.
2. **EUR-travel-exclusion leak** — the fixture's explicitly-excluded Munich
   train receipt (`train-berlin-munich-14-jun.txt`, 49.90 EUR) is counted as
   legitimate spending, reported as `EUR | Transport | 49.90` in the table.
   Smaller in scope than E4B's T-L4.3 reclassification of 2 of 3 excluded
   receipts, but the same category of bug (an explicitly out-of-scope
   document treated as in-scope spending).

No hallucinated hashes, no invented categories, no per-row-INSERT habit, no
column-name mismatch, no timeout — this run's actual mechanics were clean.
The two failures are both about *scope/disclosure discipline* on an
otherwise-correct provenance flow, not about the save/query mechanism
itself.

### Cache-reuse across all three models

Every one of the three runs showed the **exact same shape**: tool-schema
fingerprint count starts at `38`, swings to `40` right at the turn-0→turn-1
boundary, and — in the two runs that reached a steady productive state
(E4B through its turn 2 struggle, Ornith through completion) — **stays at
`40` with no further reversion**, unlike T-L4.3's pre-fix 38→40→38
oscillation across a 7-turn conversation. This is consistent with (not
conclusive proof of) `APERIO_TOOL_PIN_TURNS=8` reducing how often the reset
fires, since none of today's three runs completed enough natural turns to
exceed an 8-turn pin window and force a second reset in the way T-L4.3 did.
26B-A4B's post-timeout empty-turn cascade did show renewed `40→38→40`
oscillation, but that's a different regime (rapid-fire ~4s turns after a
hard-timeout-triggered breakdown), not the steady-state case the mitigation
targets. **Not a full validation of the fix** — no run here exercised enough
turns to test whether an 8-turn-later reset still occurs — but directionally
consistent with the mitigation working as intended. Full detail logged in
tech-debt.md.

### Bottom line

None of today's three runs produced a clean `grading.status: "pass"`.
Ranked by how close each got to real T-G2.3 behavior: **Ornith-1.0-9B**
completed the full save→query→narrate flow correctly and failed only on
disclosure/scope discipline (turn 2, non-SQL-dictated phrasing) —
genuinely the strongest result seen against this harness on any local model
to date. **gemma4-E4B** showed the per-row-INSERT SKILL.md fix working
behaviorally but hit a new structural INSERT-shape bug the developer chose
to stop rather than let retry further — ungraded. **gemma-4-26B-A4B**
regressed hardest: never reached an INSERT, and its turn-1 total silent
non-response (zero tool calls, zero tokens, full 600s timeout) is a new
failure mode not seen in prior E4B-only runs, worth flagging on its own —
whether this is a 26B-A4B-specific issue (different chat template, different
adapter routing) or a coincidence needs a repeat run to know, not attempted
this session.

---

## gemma4 run, 2026-08-13 T-L4.3 — cache-reuse root-caused; insertedRealRows grader bug found & fixed; three real gemma4 gaps found

**Command:** same invocation as T-L4.2 below, plus `APERIO_LOG_CACHE_FINGERPRINT=on`
(new opt-in request-fingerprint hash added to `lib/agent/providers/llamacpp.js`
this session — off by default, no production cost).

**Verdict: FAIL** (`grading.status: "fail"`), same as T-L4.2, but for a
different and more precise set of reasons — see below. Total wall time
≈1,824,082ms (~30.4 min) across 7 turns: 479034 / 320714 / 89484 / 326829 /
600005 (hard timeout) / 4004 / 4012 ms.

### 1. Cache-reuse gap: root-caused, not just reproduced

Watched live via llama-server's own slot-selection log (`slot get_availabl`)
plus the new fingerprint hash. Within a turn, requests are byte-identical and
get `sim_best≈0.99` (near-perfect reuse) — confirmed across 8 consecutive
internal calls in turn 0. **Across turn 1→2, the tool-schema COUNT changed
38→40 while the logged `profiles=[...]` LABEL LIST stayed identical**
(`memory,self,data,docgraph,extraction,database,file-edit` both times) — and
at that exact boundary, `sim_best` collapsed 0.99→0.229 (`f_keep=0.182`),
forcing llama-server to reprocess ~32K tokens almost from scratch (watched in
real time: 585→170 tok/s falling as the prompt grew, ~210s for that one
request). The same thing happened again turn 3→4 (tool count reverted
40→38, another full reprocess). **This corrects the T-L4.2 framing below**:
it isn't that a stable-looking schema set mysteriously produced `cache_n=0`
— "same profile labels" was hiding a real content change, most likely the
sticky-pin carry-forward logic (`f1377b1e`) pulling a newly-used tool (e.g.
`db_query`) into later turns' schema sets. Full writeup and fix direction:
`id/reference/tech-debt.md` → "Tool profiles / schema budgeting". Not fixed
this session — this is the next actionable step for whoever picks up T-L4.

Also shipped: the harness now copies the isolated llama-server's own
`server.log` (the source of the `sim_best`/`f_keep`/selection-kind lines,
richer than the OpenAI-shaped `timings.cache_n` alone) out to
`llamacpp-latency/server-log-latest.log` (gitignored) before scratch cleanup,
fixing an ordering bug where the original attempt copied it *after*
`gracefulShutdown()`, which unlinks that same file as part of normal
`stopLlamaCpp()` bookkeeping — the first capture attempt silently copied
nothing. `scripts/prompt-cache-bench.js llamacpp-latency/server-log-latest.log`
now works on any future run's log.

### 2. `insertedRealRows()` grader bug found & fixed — real INSERTs DID land this run

The harness's own `insertedRealRows()` check only ever scanned
`toolCalls[].detail` for a confirmed `rowsAffected`, but that field only ever
holds the **propose** step's own ack ("📋 Pending your confirmation — nothing
has been written yet"). The real execution ack — after the WS interrupt is
approved — arrives as a plain `✅ Executed on extraction (sqlite).
{"rowsAffected":N,...}` assistant message, often on a **later turn** than the
one that proposed the write, never as a paired `tool_result` event. The check
was structurally blind to a genuine success, not just to the known
CREATE-TABLE-only failure mode it was written for. Fixed to also scan every
turn's own answer text (`document-intelligence-skill-harness.mjs`).

Verified against this run's real (unredacted) `document-intelligence-run-answers.json`:
turn 1's confirm ack was `{"rowsAffected":1,"lastInsertRowid":1}` and turn 2's
final confirm was `{"rowsAffected":1,"lastInsertRowid":13}` — **13 real rows
did land in the table this run.** The "gemma4 never actually inserts"
framing from T-L4.2 does not hold universally; INSERT mechanics worked here.
What actually failed is worse and more specific — see below.

### 3. Three real gemma4 gaps found (logged as tech debt, not fixed this session)

Logged in full at `id/reference/tech-debt.md` → "Document Intelligence —
save/insert mechanics on gemma4 (#250)":

- **Hallucinated re-insertion**: told to "finish saving them now" without
  checking existing state first, the model inserted 12 rows with fabricated
  placeholder hashes, invented category labels (`Rent`, `Subscriptions`,
  `Bills/Housing` — none real), mismatched amount/original-string pairs, and
  **reclassified 2 of the 3 explicitly-excluded EUR travel receipts as
  legitimate spending** — confabulated data, not just a wasteful duplicate.
- **Per-row INSERT** despite the follow-up prompt explicitly saying "a single
  multi-row INSERT is fine" and SKILL.md §5 already saying the same — 12
  separate single-row confirms instead of one multi-row statement.
- **Wrong column name** in the model's own follow-up query (`amount` vs. the
  `amount_normalized` column it had just re-confirmed via `db_schema`),
  which failed, then ran into the 600s hard timeout with no retry, cascading
  into 2 more empty-answer turns (the known "broken connection after hard
  timeout" pattern).

### 4. Grader fix from this session confirmed working live

`noFxBlend` correctly did **not** false-flag turn 0's honest, per-currency
disclosure this run (the exact false-negative the earlier
[grader false-negative fix](#grader-false-negative-from-the-run-below--fixed-2026-08-13)
below was written for). Separately, `fullMonthGate` correctly failed turn 3's
closing line ("The total documented spending for June 2026 is 696.84 BGN and
196.40 EUR") for lacking the explicit non-conversion disclosure SKILL.md §6
requires — a real, deserved failure (juxtaposing two totals with "and" is not
the same as the "why there's no single number" sentence the skill asks for),
not a grader bug.

**Bottom line:** WS4/T-G6 stays blocked. The cache-reuse mechanism is now
understood well enough to fix (tech debt, not a mystery); the save/insert
path has three distinct, well-evidenced gaps logged as tech debt, of which
the hallucinated-reinsertion one is the most serious (data integrity, not
just UX/latency).

---

## Grader false-negative (from the run below) — fixed 2026-08-13

`NON_BLEND_DISCLOSURE` in `tests/fixtures/household-gen/harness-gate.mjs` only
recognized refusal phrasing ("not combining...", "kept separate", "haven't
converted"), not absence phrasing. Turn 0's honest line — *"there is no
single grand total; the totals are provided per currency"* — tags two
currencies on a `grand total`-cue line and was flagged as an undisclosed
blend, when it's the opposite: a denial that any combined figure exists.
Added `no single (?:grand )?total|no (?:combined|blended|merged) total` to
the disclosure regex. Regression test added
(`harness-gate.test.mjs`: "denying a single combined total exists is not
penalized"); all 20 tests in the file pass, including the existing mutation
test that still correctly fails the real undisclosed-blend case
(`893.24 (696.84 BGN + 196.40 EUR)`). Not yet re-run through the live T-G2.3
harness — only unit-verified.

---

## gemma4 run, 2026-08-13 — T-L4.2, genuine FAIL, first real result since the cache/INSERT fixes

**Command:**
```
DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
  LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL \
  APERIO_HARNESS_WALLCLOCK_TOTAL_MS=2400000 APERIO_HARNESS_WALLCLOCK_PERTURN_MS=550000 \
  node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
```
Ceilings chosen from T-L4.1's own numbers (461,830ms max observed turn,
1,920,086ms observed total): per-turn 550,000ms (~19% headroom, still under
the 600,000ms hard-abort so a "completed but too slow" turn stays
distinguishable from a true hang), total 2,400,000ms (~25% headroom for the
revised SKILL.md possibly needing an extra escalation turn). Two harness bugs
found and fixed before this could even run: a broken relative import left
over from the 2026-08-04 directory move (`b0842cb6`), and an unrelated
`docker/Dockerfile` typo blocking Docker-smoke CI on every open PR
(`ab2a7d2c`, unrelated to this gate but found while investigating CI state).

**Verdict: FAIL, for real and specific reasons — read turn-by-turn, not
`grading.status` alone (which correctly says `"fail"` here, but for an
incomplete/partially wrong set of reasons — see the grader bug below).**

Turn-by-turn (`document-intelligence-run-answers.json`, 7 scripted turns):

1. **Turn 0** (main prompt): `doc_batch` only, 378s, cold `cache_n=0` (expected
   — first turn). The model's own arithmetic is *correct and honest*: BGN
   696.84 and EUR 196.40 reported **separately**, with an explicit disclosure
   — *"Because your expenses span multiple currencies (BGN and EUR), there is
   no single grand total; the totals are provided per currency."* It does
   **not** call `db_execute` at all — it describes a save plan in prose and
   asks *"Would you like me to proceed?"*, i.e. it treated the harness's
   instruction as needing chat-style confirmation instead of emitting the
   actual propose-write tool call.
2. **Turn 1** (follow-up 1, "query it per category... not from your own
   arithmetic"): still zero tool calls. Explains the data isn't saved yet,
   and **changes its own plan** from turn 0's proposed 9 summary rows to 14
   individual raw fact rows — again only in prose, again ending on a
   confirmation question rather than a tool call. 351s, and `cache_n=0`
   again — **notable: the tool-schema set was identical between this turn and
   turn 0's second half (both 40/74 schemas, `[tools] turn=1` and `turn=2` in
   the log), yet llama-server still reprocessed the entire prompt from
   scratch.** Schema stability alone did not guarantee cache reuse here — see
   the cache note below.
3. **Turn 2** (follow-up 2, explicit: "finish saving them now... a single
   multi-row INSERT is fine"): first and only `db_execute` call in the whole
   run — but it is `CREATE TABLE IF NOT EXISTS category_summary (...)`, no
   `INSERT`, `rowsAffected:0`. Despite being told explicitly, a third time,
   to insert, the model still split table-creation and data-loading into
   separate turns and never reached the second half. 304s.
4. **Turn 3** (follow-up 3, "run SELECT... give me the resulting breakdown"):
   called `doc_batch` again — re-reading documents instead of inserting or
   querying — then ran the full 600,004ms hard abort
   (`APERIO_HARNESS_TIMEOUT_MS`) without completing.
5. **Turns 4-6** (follow-ups 4-6): ~4 seconds each, zero tool calls, empty
   answers — the same "broken connection after a hard timeout" pattern
   recorded in the 2026-08-02 run-1 history below. Once turn 3 hit the hard
   abort, the session never produced real output again.

**Checks against the four things this gate needed to see, explicitly:**
1. Confirmed `db_execute` INSERT with `rowsAffected>0` — **never happened.**
   Only a `CREATE TABLE`, `rowsAffected:0`.
2. `db_query` returning real rows, narrated in the final answer — **never
   happened.** The literal string `db_query` does not appear anywhere in the
   transcript outside the grader's own failure-message text; the flow never
   got that far.
3. No BGN/EUR blended total-cue line — **actually satisfied.** Turn 0's
   answer is honest and correctly separated; no turn anywhere states a
   combined figure. The 2026-08-13 SKILL.md revision's no-blend guidance
   *is* being followed on this run — the failure is entirely about the
   save/insert/query mechanics, not currency-blend honesty.
4. `cache_n`/attached-schema count flat from turn 2 on — **not held.** The
   `[tools] turn=N` log shows the attached-schema count swinging
   15→40→40→**20**→**35**→35→35→**20** across the conversation (profiles
   dropping/regaining `docgraph`, `extraction`, `file-edit` and gaining an
   unexplained `shell` mid-run), not the flat count the sticky-tool-pin fix
   (`6331e7a8`) is supposed to produce. This directly reproduces the T-L1.1
   probe's finding that any tool-set change forces a full cache miss, and
   plausibly explains why turn 2 (304s) and turn 3 (600s, timed out) were the
   slowest. **Separately and more surprisingly: even turn 1, where the schema
   set *did* stay pinned at 40/74 across both internal model calls, still
   showed `cache_n=0` — zero reuse despite a stable schema.** Schema
   stability turned out to be necessary but not sufficient for cache reuse in
   this run; something else in the request (possibly per-turn system-prompt
   content, or how the growing tool-result history is rendered) is also
   busting the prefix match. Not root-caused this session — flagging for
   whoever picks up the latency thread next, since it changes the T-L4
   remediation's expected payoff.

**Grader bug found (opposite direction from the 2026-08-02 false-passes):**
`grading.checks.fullMonthGate`/`noFxBlend` reports `false`, and the recorded
failure text quotes turn 0's own honest disclosure — *"Because your expenses
span multiple currencies (BGN and EUR), there is no single grand total; the
totals are provided pe[r currency]"* — as if it were evidence of a blend. It
is the opposite: this is the model correctly refusing to blend. This looks
like a **false-negative** in `tests/fixtures/household-gen/harness-gate.mjs`'s
`evaluateAnswer()`/`noExcludedLeak` path, most likely a substring/keyword
match on "grand total" or similar firing without checking whether the
matched line is *disclosing* non-conversion rather than performing it. Not
investigated further this session (the real T-G2.3 failure — no INSERT, no
query — is dispositive on its own and didn't need this check to fail the
gate) but worth fixing before this grader is trusted on FX-blend again,
mirroring the same "verify empirically, don't trust the mechanical check"
lesson as the three 2026-08-02 bugs below.

**Bottom line:** this is a genuine T-G2.3 failure — no persisted rows, no
queried total — with a genuine but secondary contributing latency factor
(unstable tool-schema set defeating cache reuse, compounding an underlying
cache-reuse gap that schema stability alone doesn't close). It is **not** a
regression in the no-FX-blend behavior, which the model got right this run.
WS4/T-G6 should not start on this result; the save/insert-mechanics gap and
the tool-schema volatility are both still open.

---

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
Evidence (raw, unredacted): `document-intelligence-tg23-provenance-gemma4-2026-08-02.json`,
deleted 2026-08-13 once the three grading bugs it exposed were fixed and the run was
superseded by two later gemma runs; recoverable from git history if ever needed.

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
regression could still run long. `document-intelligence-run-answers.json` is
git-ignored as of 2026-08-13, so the old `git checkout --` restore step after a
run is no longer needed.

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
