Pick up the last open gate of the document-intelligence epic (#250): WS2 T-G2.3 (SQL provenance)
on the local hero model, gemma4-E4B. Rounds 9-11 finished the infrastructure work and **committed
it**. Three consecutive live runs confirm the KV-reuse fixes and both wall-clock ceilings. The
gate still reports `fail`, and after two grader fixes it is now failing on **model behaviour**,
not on the harness. What is left is a decision about the model, not another repair.

**Verify before you build on any of this.** The code is committed; read it rather than trusting
this summary — `git show <this commit>` and
`trash/plans/document-intelligence-epic/document-intelligence-ws2-tg23-open-issues.md`. Two of
the last three handoffs contained a confident claim that turned out to be false (round 7's "the
maxHistory cap is benign", cost 473 s; round 8's worktree note said `lib/agent/providers/llamacpp.js`
was a stray diagnostic, when half of it was load-bearing and excluding it would have broken the
small-context overflow fallback). Distrust accordingly.

## Read first

1. The rounds 9-11 section at the top of
   `trash/plans/document-intelligence-epic/document-intelligence-ws2-tg23-open-issues.md`.
2. `id/reference/tech-debt.md` → the "Document-intelligence harness — grader (#250)" section,
   in particular the *pattern* entry about lexical predicates and the two `fullMonthGate` entries.

## What is settled, and should not be re-opened

**The prompt prefix is stable across a flow. Verified live three times, rounds 9/10/11.**
6/6, 8/8 and 9/9 request boundaries respectively, every one `pure append -- prefix intact`,
`sysHash` constant within each run, `toolsHash=0ef511af95bc` in all three. Both ceilings passed
in all three (max turn 421-475 s of 550 s; totals 583 k / 981 k / 1,034 k of 2,400 k). The two
causes — the skill block relocating, and `maxHistory` cutting the cached prefix on every hop —
are fixed in `lib/agent/turn-planner.js` (`computeSkillPin` + `resolvePinnedSkills`, pinned per
conversation via a WeakMap in `lib/agent/index.js`) and `lib/agent/model-context-middleware.js`
(hysteresis). This is no longer a single-run result.

**Both grader defects are fixed**, and both were the same shape — a substring test over free
prose rejecting a correct answer. `hasNarratedDecimalTotal` could not see markdown emphasis
(`**Total in BGN:** 696.84`); `citesQueryProvenance` (was `followUpCitesSql`) demanded SQL jargon
where the model named its source table. Both now live in
`llamacpp-latency/grading-predicates.mjs` with 20 tests in `grading-predicates.test.mjs`.

## Your job: decide whether gemma4-E4B passes this gate

Three runs under the current grader: round 9 scores **16/16**, rounds 10 and 11 fail on genuine
model defects — a currency blend (`893.24` = 696.84 BGN + 196.40 EUR) and an arithmetic
double-count (Fuel `431.20` against a true `215.60`, one of two June fuel receipts counted
twice). One clean in three, two distinct failure modes.

The useful next step is a **measured pass rate**, not another fix. Run the gate unchanged 3-5
more times and count:

```
DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
  LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL \
  APERIO_HARNESS_TIMEOUT_MS=900000 \
  APERIO_HARNESS_WALLCLOCK_TOTAL_MS=2400000 APERIO_HARNESS_WALLCLOCK_PERTURN_MS=550000 \
  APERIO_LOG_CACHE_FINGERPRINT=on \
  node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs \
  > /tmp/roundN.log 2>&1
```

Budget 10-20 min per run (turn 0's cold prefill alone is ~420-475 s and is unavoidable). Analyse
the cache with `python3 trash/plans/document-intelligence-epic/llamacpp-latency/msgdiff.py`.
A cache or latency regression would be new information; none is expected.

Then decide with the developer what the bar is. "Passes sometimes" is not a gate. The honest
options are: raise the model, lower the gate to a stated pass-rate threshold, or fix the two
observed defects at their source.

## Newly testable, and the most promising lead

**The premise that retired SKILL.md work has been reversed by this session's own fix.** The
"do not re-open SKILL.md wording" rule existed because the skill was not in context on the turn
it targeted. That was true when the block lived in a relocating tail message. It is false now:
the block sits in the cached system prompt, is pinned for the flow, `skills=[document-intelligence]`
is logged on every turn, and **round 11's model cited the skill by name** —
*"as per the core principles of the `document-intelligence` skill"*.

So an explicit never-sum-across-currencies instruction in SKILL.md is now a real experiment
rather than a repeat of a failed one. It targets round 10's exact failure. Note the cost of
being wrong is low but the cost of *assuming* it works is not — measure it over several runs,
since the baseline itself is only 1-in-3.

## Known-open, none of them blockers

- **`fullMonthGate` over-triggers — now OBSERVED (round 11), not suspected.** It failed
  `"**Overall Combined Total:** **912.44 BGN + 196.40 EUR**"` for combining currencies
  "without disclosing that it isn't converting", while the next line of the same answer read
  *"(Note: No FX conversion was applied…)"*. Two figures, one per currency, with an adjacent
  disclosure. Fix this before relying on the check — it will produce false failures.
- **The grader's prose predicates are brittle as a class.** Three of this gate's checks are
  substring tests over free prose; two have now produced run-invalidating false negatives in
  consecutive rounds, each fixed reactively. The structural checks (`dbQueryReturnedRows`,
  `insertedRealRows`) carry the evidentiary weight. Consider moving provenance grading off
  substring matching before pointing this gate at a new model.
- **Per-token prefill cost climbs with context depth: 7.71 → 13.5 → 16.8 → 20.4 ms/token.**
  The largest remaining latency item; nobody has investigated it. Hardware/attention-depth,
  not cache.
- **The hysteresis cut has never been observed firing.** Rounds 9-11 peaked at 30 messages,
  below the 41 threshold. Verified: the cap no longer fires early. Unverified: the single
  amortized cut it should make at 41.
- **The EUR row lands as `Uncategorized`/`Travel-Other`** (196.40 EUR) while every BGN row is
  categorized. Not graded; a real extraction gap in the EUR path.

## Do not re-open

- Round 5's inference that `msgCount=20` on consecutive requests means the array is rebuilt.
  It was the `maxHistory` cap. Retired twice.
- Round 6's preflight suspicion — exonerated by byte-identical `doc_manifest`/`doc_batch` hashes.
- Round 4's extraction-accuracy finding — did not reproduce.
- Round 7 run A's "the `maxHistory` cap is benign" — falsified by run B.
- **The KV-reuse and wall-clock work generally.** Three consecutive clean runs. If a future run
  is slow, look at the per-token depth curve above, not at the cache.

## State of the worktree

The agent fixes, both grader fixes, the tests, `CHANGELOG.md`, `id/reference/tech-debt.md` and
the plan docs are **committed** on
`fix/docint-cache-and-skill-stickiness-250-signed-by-claude-opus-5`.
`tests/unit` + `tests/harness`: **2687 pass / 0 fail**.

`.gitignore`, `package.json`, `manual/`, `output/`, `scripts/manual-build.mjs`,
`tests/{unit,integration}/manual/` and `trash/plans/manual-visual-system-prototypes/` belong to
ANOTHER SESSION — they were deliberately left uncommitted. Do not touch, stage, or commit them.
Note `tests/integration/manual/build/preview.test.js` currently fails; it is that session's, not
ours, which is why a scoped `tests/unit`+`tests/harness` run is the meaningful check here rather
than a bare `npm test`.
