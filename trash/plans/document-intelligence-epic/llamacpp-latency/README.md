# Document-intelligence harnesses — what exists, and what they taught

Consolidated 2026-08-14. This replaces the old per-file notes and `prompts.md`
(prompt text lives in the unit-tested ladder module now, so a second copy could
only drift). Everything deleted here is recoverable with
`git log -- <path>`.

## What exists

| Instrument | Where | Answers | State |
|---|---|---|---|
| **Skill harness** | `llamacpp-latency/document-intelligence-skill-harness.mjs` | The live gate. `DOCINT_PHASE=routing\|coverage\|provenance` → T-G2.1/2.2 and T-G2.3/T-G2.4/T-L4 | **The only open gate.** Boots an isolated server + scratch DB + its own llama-server |
| **Grader** | `tests/docint/` | Given a transcript, did it pass — and which of the three gates | Pure, 82 tests, in `npm test` |
| **Replay** | `tests/docint/replay-grading.mjs` | Does a grader change flip a recorded round? | Re-grades archived runs with no server, no model, no DB |
| **Oracle gate** | `tests/fixtures/household-gen/harness-gate.mjs` | Do the answer's figures match the oracle, per category and currency | Lives with the corpus it grades; test in `tests/docint/` |
| **Capability probe** | `llamacpp-latency/gemma-simple-capability-harness.mjs` | Can this model do four-question arithmetic at all? | Triage only, **after** a hard-gate failure |
| **Cache fingerprint** | `APERIO_LOG_CACHE_FINGERPRINT=on` + `msgdiff.py` | Where does the KV prefix break between turns? | Reads a real run's log; replaced the synthetic probe |

Deleted 2026-08-14: `document-intelligence-red-harness.mjs` (T-R5, passed twice
2026-08-01/02, gate closed — the skill harness's routing phase asks the same
question against current code), `llamacpp-cache-probe.mjs` (synthetic sequence,
superseded by fingerprinting a real conversation — see the T-L4.3 finding
below), `prompts.md`, and the single-slot `document-intelligence-run-answers.json`
(per-run archives in `var/docint-runs/` replaced it).

## Re-grading a recorded run (no boot)

Every run archives its un-redacted transcript to `var/docint-runs/`
(gitignored, one file per run). This is the check to run after changing
anything in the grader — it answers "does this fix flip that round?" by
executing it instead of arguing it from a transcript:

```bash
node tests/docint/replay-grading.mjs            # newest archived run
node tests/docint/replay-grading.mjs --list     # what's archived
node tests/docint/replay-grading.mjs <path.json>
```

The report ends with a diff against the grading the run itself recorded: status
change, per-check before/after, failures resolved/introduced. Artifacts written
before this existed carry no `gradingInputs`, so the replay warns and falls back
to defaults — the wall-clock checks in particular will not match.

## Manual runs

From the repository root. The end-to-end harness creates an isolated scratch
workspace/database, chooses free loopback ports, and cleans up in `finally`.

```bash
# WS2 routing, coverage, or provenance phase, default cloud pair (DeepSeek)
DOCINT_PHASE=routing    node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
DOCINT_PHASE=coverage   node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
DOCINT_PHASE=provenance node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs

# The gate that matters: a local model against the provenance phase
DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
  LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL \
  node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
```

Useful overrides: `DOCINT_EVALUATION_PROVIDER=codex` with
`DOCINT_EVALUATION_MODEL=gpt-5.6-terra`, `APERIO_HARNESS_TIMEOUT_MS=…`,
`APERIO_HARNESS_WALLCLOCK_TOTAL_MS=…`, `APERIO_LOG_CACHE_FINGERPRINT=on`.

## Models used, and what each one proves

| Side | Provider/model | Role and result |
|---|---|---|
| Target/local | `llamacpp` / gemma-4-E4B-it-qat | Product hero model. T-R5 retrieval passed twice; **T-G2.3 never passed** across four runs |
| Target/local | `llamacpp` / gemma-4-26B-A4B-it-qat | Clean pass on all three gates and under the phantom-write check — but at the `dictated-sql` rung (`mechanism-conformance`), 682 s longest turn |
| Target/local | `llamacpp` / Ornith-1.0-9B-MTP | Reached the `named-mechanism` rung (`realistic-usage`); **withdrawn** — fabricated a write claim |
| Target/local | `llamacpp` / gemma-4-12B | Stopped at turn 3; found the real `db_execute` "undefined connection" bug (`8e54bf4c`) |
| Cloud comparison | `deepseek` / deepseek-v4-flash | Clean WS2 provenance pass; a comparison, never the local-model proof |
| Cloud comparison | `codex` / gpt-5.6-terra | The other recorded evaluation pair; no retained result is used as a gate |

## Running the capability probe

Only after the hard gate fails. A hard-gate failure can be workflow latency
rather than a model's basic capability failure; this separates the two by asking
four deterministic short questions (integer arithmetic, percentage change,
average, logic implication) against an isolated llama-server.

```bash
LLAMACPP_MODEL=unsloth/gemma-4-26B-A4B-it-qat-GGUF:Q4_K_XL \
  node trash/plans/document-intelligence-epic/llamacpp-latency/gemma-simple-capability-harness.mjs
```

| Model | Full served / usable context | Result (2026-08-04) |
|---|---:|---|
| Gemma 4 E4B | 113,664 / 104,570 | 3/4 — `17 × 23 + 19` answered `400` |
| Gemma 4 26B A4B | 131,072 / 120,586 | 4/4, 4.5–8.9 s per response, ~48–50 tok/s |

## What the runs actually taught

**The grader was the bottleneck, not the model — four times.** Four checks on
this gate shipped as substring tests over free prose, and every one produced a
false failure that invalidated a whole live run: markdown emphasis around a
total (round 8), a model saying "pulled from the `spending_summary` database"
without the word "SQL" (round 9), an honest two-currency total read as a blend
(round 11), and a correct answer stating Utilities as its four components
(2026-08-14). Each fix was reactive, written from the run that exposed it. The
structural checks (`dbQueryReturnedRows`, `insertedRealRows`) carry the
evidentiary weight; the prose checks only ask *how* the model narrated it.
**Standing recommendation: move category/provenance grading off substring
matching over prose.** Now cheap to attempt, because replay re-grades every
archived transcript without booting anything.

**One `status` was reporting three different gates.** T-G2.3 (sql-provenance),
T-G2.4 (no-fx-honesty) and T-L4 (wall clock) were ORed into a single verdict, so
four runs read as "1 pass in 4" when T-G2.3 itself had held in three of them.
Split 2026-08-14; each check and failure now names its owning gate.

**A guessed ceiling failed real passes.** The 550,000 ms per-turn value was
chosen before anyone had watched a turn finish on this corpus. It failed exactly
one run on its own merits and would have failed gemma-4-26B's clean pass too.
Demoted to a reported metric; the TOTAL ceiling stays a real gate. A per-turn
ceiling *derived from observed times across models* would still be worth having.
Ceilings are hardware-specific — re-derive, don't reuse the numbers.

**Prose can outrun the database, and nothing was checking.** Ornith-1.0-9B's
2026-08-14 run passed all three gates while telling the user the EUR receipts
"are saved separately" — its single INSERT was `BGN`×10, `EUR`×0. Fixed as
`noPhantomWriteClaims`; replay flips that run `pass → fail` with zero collateral,
and gemma-4-26B's pass (whose INSERT really did carry `EUR`×3) is unchanged.

**Cache reuse: schema stability is necessary but not sufficient.** The
tool-schema *count* changes turn to turn (38→40→38) even when the logged
`profiles=[…]` labels stay identical, and each shift collapses `sim_best` from
~0.99 to ~0.2–0.3, forcing a near-full reprocess of a growing conversation. The
sticky tool-pin fix (`6331e7a8`) pins within a turn's tool-selection call, not
across turns. Root-caused via `APERIO_LOG_CACHE_FINGERPRINT` on a real
conversation — the synthetic probe could not see it. Open: tech-debt →
"Tool profiles / schema budgeting".

**Latency and save-mechanics are two problems, not one.** The save/insert gap —
a model proposing a save in prose instead of emitting the write tool call, or
issuing `CREATE TABLE` and never `INSERT` — occurs on turns that finish well
inside budget. It needs its own SKILL.md/prompting work, independent of cache
reuse. Open: tech-debt → "Document Intelligence — save/insert mechanics on
gemma4".

**26B is capable but slow.** At its full 131,072-token window the 26B model
passes the simple probe 4/4, yet its first document-intelligence request was
still pre-filling 16,674 tokens at 79.0 s. Capability and UX budget are separate
verdicts and should never be read off one number.
