Pick up the last open gate of the document-intelligence epic (#250): WS2 T-G2.3 (SQL provenance)
on the local hero model, gemma4-E4B. The infrastructure work is finished and merged (PR #452).
What is left is **a decision about the model, not another repair** — and one live run to test the
two changes made since the last measurement.

**Verify before you build on any of this.** Read the code rather than trusting this summary —
`git log --oneline -10` and `id/reference/tech-debt.md`. This epic has a consistent history of
confident handoff claims that turned out false: round 7's "the `maxHistory` cap is benign" (cost
473 s), round 6's preflight attribution (exonerated), round 4's extraction-accuracy finding (did
not reproduce), and in this session two of my own — "the model was never told `sql` was missing"
(it was told, all three times) and "the `isError` path never delivers a hint" (it already did,
`lib/agent/index.js`, the line after the image block). Distrust accordingly, including this file.

## Read first

1. `id/reference/tech-debt.md` → the four `#250` sections. In particular the **gemma4-E4B model
   behaviour** section, which holds the actual blocker, and the **grader** section's *pattern*
   entry about lexical predicates.
2. `trash/plans/document-intelligence-epic/document-intelligence-ws2-tg23-open-issues.md`.

## The blocker, unchanged and still yours to call

Four live runs, same command, same fixtures: **round 9 clean 16/16, rounds 10-12 fail, and no two
failed the same way** — a currency blend, an arithmetic double-count, runaway reasoning that spent
a full 900 s budget on thinking tokens and emitted nothing, and `insertedRealRows: false` on a run
that proposed `db_execute` and had the confirm approved.

One pass in four with four distinct failure modes is not a gate result, it is a coin. The honest
options have not moved: **raise the model, lower the gate to a stated pass-rate threshold, or fix
the defects at their source.** No further runs resolve this; it is a judgment call. A planned
6-run measurement (3 baseline + 3 with a SKILL.md change) was cut after round 12 because the
round-12 blend retired the premise of its second arm.

## What changed since the last measurement, and what a run would now test

Two things landed that no live run has exercised:

1. **A SKILL.md rule against counting one payment twice** (§4). This targets round 11's
   double-count and is the only defect in this epic that had never been tried in prompt. Note it
   was written against the corpus's documented duplication shapes, **not** against round 11 —
   see the caveat below.
2. **Better tool-call correction on malformed arguments.** A lost-sync parse is now classified as
   its own kind and the model gets a hint naming the tool's real parameters, where before it got
   only "`sql` is required" and retried the same broken shape three times. This targets round
   12's `insertedRealRows: false`.

A run measures both at once, which is exactly what you do NOT want if either fires — so record
which one moved. Neither addresses the runaway-reasoning mode or the currency blend.

## Do not re-open

- **The currency blend as a prompt problem.** `skills/document-intelligence/SKILL.md:261` already
  quotes the failing string `893.24 (696.84 BGN + 196.40 EUR)` character-for-character as a
  labelled counter-example, calls it "a failure, not a courtesy", and adds a pre-send re-read
  imperative. It was pinned in the cached system prompt every turn, and round 11's model cited the
  skill by name. 2 of 4 runs blended anyway. This wording has had a fair test and failed it. If it
  is to be fixed it needs a mechanism — deriving the closing line per currency out of the query
  result so no single blendable figure exists — not a fifth sentence.
- **The KV-reuse and wall-clock work.** Three consecutive clean runs; both ceilings passed. If a
  future run is slow, look at the per-token prefill depth curve (7.71 → 13.5 → 16.8 → 20.4
  ms/token, uninvestigated, hardware/attention-depth) rather than at the cache.
- Round 5's `msgCount=20` rebuild inference (it was the `maxHistory` cap), round 6's preflight
  suspicion, round 7 run A's "the cap is benign", round 4's extraction-accuracy finding.
- **Moving `db_execute` out of `DESTRUCTIVE_TOOLS`.** That set gates three things; two are
  load-bearing on this exact write path (`parseArgs` refusing to regex-repair args, which can
  shift string boundaries and land an altered statement, and `findPriorToolResult` never replaying
  a destructive result). The hint suppression was the only one worth changing and it is done.

## Caveat on the new duplicate rule

Round 11's arithmetic does not reconstruct. It claimed Fuel 431.20 against a true 215.60 — that is
2 × 215.60, the whole category doubled, which matches neither the fixture's statement-overlap
signature (240.00 = 120 × 2) nor "one of two receipts counted twice" (335.60 or 311.20). The
existing description of it as a single receipt double-counted does not survive arithmetic, and the
transcript was overwritten before the per-run archive existed. So the rule is aimed at the
duplication shapes the corpus documents, and a run testing it measures the rule — it does not
reproduce round 11.

## Known-open, none of them blockers

- **The EUR row's category is now graded** (`foreignCurrencyRowsCategorized`), and the root cause
  is not the model: `CATEGORY_RULES` (`lib/docgraph/facts/contract.js`) has no Travel or
  Accommodation category and its patterns are Bulgarian + English only, so `classifyCategory()`
  returns `null` for a German train ticket, a German hotel bill and a French airport café alike.
  Verified by running the real classifier against all three. **The check will therefore fail any
  run whose model reports the EUR total from the pipeline's own bucket** — the failure message
  names the taxonomy, not the model. Closing it means extending the taxonomy, which is product
  code touching how real users' documents are categorised and deserves its own review.
- `/\bcafé\b/i` in that same rule set can never match "café" — `é` is a non-word character, so the
  trailing `\b` demands a word character after it. Harmless today (the unaccented variant sits
  beside it); worth checking the other patterns for the same shape.
- **The grader's prose predicates are brittle as a class.** Three checks are substring tests over
  free prose; two produced run-invalidating false negatives in consecutive rounds. The structural
  checks carry the evidentiary weight. An audit of the remaining ones was deferred by the
  developer, not dismissed — it is now cheap, since `replay-grading.mjs` re-grades an archived run
  offline with a before/after diff.
- **The hysteresis cut has never been observed firing.** Runs peaked at 36 messages against a
  41-message threshold. Verified: the cap no longer fires early. Unverified: the single amortized
  cut it should make at 41.
- Whether grading should prefer the turn that *satisfied* the ladder over the last turn with
  content. Latent, not active — on a clean run they are the same turn.

## The command

```
DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
  LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL \
  APERIO_HARNESS_TIMEOUT_MS=900000 \
  APERIO_HARNESS_WALLCLOCK_TOTAL_MS=2400000 APERIO_HARNESS_WALLCLOCK_PERTURN_MS=550000 \
  APERIO_LOG_CACHE_FINGERPRINT=on \
  node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs \
  > /tmp/roundN.log 2>&1
```

Budget 10-20 min per run; turn 0's cold prefill alone is ~420-475 s and is unavoidable. Analyse
the cache with `msgdiff.py`, re-grade an archived run with `replay-grading.mjs` (no path takes the
newest; `--list` enumerates). The developer's standing rule: **kill the run on the first turn that
repeats a known failure shape** rather than letting the ladder run out.

## State of the worktree

Committed on `fix/toolcall-hints-and-docint-duplicate-rule-250-signed-by-claude-opus-5`
(branched from `master`, which already carries the merged PR #452). 229 tests pass across the
affected suites: `tests/integration/tools/schemaCheck.test.js`, `tests/unit/tools/executor.test.js`,
`tests/integration/workers/skills.test.js`, `tests/fixtures/household-gen/harness-gate.test.mjs`,
and the two `llamacpp-latency/*.test.mjs` files. The harness tests are not in the `npm test` glob
and must be run directly with `node --test`.
