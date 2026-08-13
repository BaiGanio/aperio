Pick up WS2 of the document-intelligence epic (#250). The gate verdict is now **split by gate**
(T-G2.3 / T-G2.4 / T-L4), and under that split **T-G2.3 is passing** — Ornith-1.0-9B cleared all
seven mechanical checks on 2026-08-14. What is left is T-G2.4, a known grader false-failure, and
a model-selection decision.

**Verify before you build on any of this.** Read
`trash/plans/document-intelligence-epic/document-intelligence-ws2-tg23-open-issues.md` (top
section, 2026-08-14) and `id/reference/tech-debt.md` rather than trusting this summary. This
epic has a history of confident handoff claims that turned out false — the previous version of
this file told the next session to run a 6-run measurement that had already been cancelled, and
to try a SKILL.md experiment that round 12 had already retired.

## Read first

1. The 2026-08-14 section at the top of `document-intelligence-ws2-tg23-open-issues.md`.
2. `id/reference/tech-debt.md` → "Document-intelligence harness — grader (#250)" (in particular
   the *pattern* entry about lexical predicates) and "db_execute argument validation".

## What is settled, and should not be re-opened

- **The gate split.** `grading.mjs` tags every check and failure with its owning gate and
  reports `grading.gates`. `status`/`failures` are byte-identical to before, so replay diffs
  still work. 18/18 in `grading.test.mjs`.
- **Rounds 10 and 11 were never provenance failures.** Round 10 failed T-G2.4 (currency blend),
  round 11 an extraction double-count — both with every T-G2.3 check green. Only round 12's
  missing INSERT was a genuine T-G2.3 failure.
- **The `db_execute` argument defect is fixed** (three parts, see tech-debt). Do not re-litigate
  removing `db_execute` from `DESTRUCTIVE_TOOLS`: it is two-phase confirm-gated and renders
  connection, statement type, SQL and params to the user before executing, so it does not need
  the JSON-repair refusal that protects direct-write tools.
- **The KV-reuse and wall-clock infrastructure** (rounds 9-11, three clean runs).
- **The SKILL.md never-sum-across-currencies lead** — retired by round 12, which blended anyway
  with the skill's own counter-example pinned in the system prompt.

## The immediate next job: fix the fourth false failure

T-G2.4 failed Ornith's *correct* answer with:

```
full-month gate: Utilities: expected 260.50, answer attributed no figure to this category
```

The model reported Electricity 142.50 + Water 38.20 + Heating 64.80 + Waste 15.00 = 260.50 —
exactly the components the oracle's own `reconciliation` field lists. The gate should accept a
decomposition whose components sum to the expected category total.

This is the **fourth** false failure of this class (markdown emphasis, SQL vocabulary, currency
phrasing, now category granularity). Before adding a fifth reactive patch, consider the standing
recommendation in tech-debt: move category/provenance grading off substring matching over prose
entirely, since `dbQueryReturnedRows` and `insertedRealRows` carry the evidentiary weight.

**A grader change costs nothing in comparability** — `replay-grading.mjs <artifact>` re-grades
saved transcripts under a new grader and prints a diff against the grading each run recorded.
Archived runs live in `var/docint-runs/` (gitignored). Replay Ornith's before and after.

## Model selection — what the evidence supports

| model | T-G2.3 | notes |
|---|---|---|
| Ornith-1.0-9B | **PASS** | perfect arithmetic (696.84 exact), both round-10/11 failure modes cleared; but `capabilityClaim: mechanism-conformance` (dictated-sql rung, turn 4) |
| gemma4-E4B | 3 of 4 runs | round 9 passed at the stronger `named-mechanism` rung; round 12 failed genuinely |
| gemma-4-12B | untested | run stopped at turn 3 against pre-fix code; turn 0 = 1,004,770 ms |
| gemma-4-26B-A4B | see log | run started 2026-08-14 against the fixed code — read its result before assuming anything |

The open judgment call is unchanged in shape but much narrower now: **is a `dictated-sql` /
mechanism-conformance pass good enough for T-G2.3, or does the gate require the
`named-mechanism` rung?** That is a decision about what the gate claims, not a measurement.

## Known-open, none of them blockers

- **`db_schema` on the reserved `extraction` name** replies "no connection named extraction"
  without mentioning that it self-provisions on the first confirmed write. Accurate but
  incomplete; both models recovered, so it is not biting yet.
- **Ornith wrote a wrong figure to memory** (796.84, off by exactly 100.00) at turn 0 while its
  graded SQL answer was exact. Ungraded, and it would outlive the session.
- **`checkArgs` still cannot report `connection`/`sql` as `missing_required` for `db_execute`**,
  so `var/toolrepair/events.tsv` under-counts propose-path argument quality. Needs a per-tool
  "required when proposing" overlay; not needed for correctness now that the handler speaks.
- **Per-token prefill cost climbs with context depth** (7.71 → 20.4 ms/token). Never investigated.
- **The `maxHistory` hysteresis cut has never been observed firing.**

## State of the worktree

The split, the `db_execute` fix, both test suites and these docs are committed. Full scoped run
at commit time: **2698 pass / 0 fail** (`tests/unit` + `tests/harness`), plus 52 in
`tests/integration/handlers/database-confirm.test.js`.

Check `git status` before assuming anything else in the tree is yours — this repository is
routinely worked by concurrent sessions.
