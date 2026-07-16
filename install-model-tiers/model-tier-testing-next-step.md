# Completed checkpoint: Stage 4 finalist evidence preparation

## Current decision posture — 2026-07-16

Gemma 4 E4B UD-Q4_K_XL is the primary provisional model for all four Aperio
RAM tiers: 8, 16, 24, and 32 GB. No broader model guessing is needed for the
next stage. It is not yet an approved installer default because the final
qualification and finalist evidence still have to be completed:

- A fresh hardware-tier 32 GB `chain-recall-wiki` verification passed in 201.5s
  with `statePassed: true`, three successful tool results, zero persistent tool
  failures, and zero qualification swap growth.
- Earlier isolated 8/16/24 GB runs passed the same chain case, but those lower
  tiers were simulated on the 32 GB host and remain provisional.
- The later full 32 GB campaign passed all four native recall cases and both
  guardrails, but was invalid after `chain-write-run-node` timed out. The
  remaining chain cases were then exercised individually: document-existence,
  web-source-memory, and wiki-provenance timed out; code-syntax-run exceeded
  the llama.cpp context limit; the two file cases failed tool behavior. These
  are preserved as evidence and are not silently scored as passes.
- Gemma 4 12B was tested from a scratch catalog at simulated 16 GB; it timed
  out on `recall-filter-tag` after two slow but completed recall cases and is not
  a stronger candidate under the current bounded contract.

The fresh 24 GB confirmation was run on the 32 GB host as simulated-tier
evidence in private campaign `20260716T120000Z-e4b-24gb-confirm`. It reached
case 10 before `chain-code-syntax-run` exceeded the llama.cpp context size and
therefore did not produce a valid 14-case aggregate. The overflow reproduced
in isolated campaign `20260716T120000Z-e4b-24gb-chain-code-rerun`.

The completed cases are retained as evidence: all four native recall cases and
`chain-recall-wiki` passed; `file-read-selection`, `file-write-sandboxed`,
`chain-write-run-node`, and `chain-recall-document-existence` completed with
behavior failures. The unstarted continuation cases were exercised separately:
`chain-web-source-memory` and `chain-recall-wiki-provenance` completed with
behavior failures. The 24 GB guardrails were not rerun after the user accepted
the prior 32 GB guardrail evidence. These results are sufficient to proceed to
private finalist-exam evidence by explicit operator acceptance, but E4B is not
fully qualified and must not be called an approved installer default.

## Bounded live verification closeout — 2026-07-15

Operator-approved live campaign `20260715T083512Z` was intentionally stopped
after bounded verification rather than running all 38 catalog placements. The
run remained cache-only and isolated; no model downloads were performed.

Captured private results:

- 8 GB Gemma 4 E4B: complete, 3/5 pilot cases passed.
- 16 GB Gemma 4 E4B: complete, 3/5 pilot cases passed.
- 16 GB Qwen3.5 9B: invalid after the chain case timed out.
- 24 GB Gemma 4 E4B: complete, 4/5 pilot cases passed.
- Uncached placements were rejected before process startup.

The campaign was stopped before a 32 GB placement ran. These artifacts are
qualification evidence only, not tier decisions; no model was promoted and no
installer or runtime behavior was changed. Raw artifacts remain private under
`var/benchmarks/model-tiers/20260715T083512Z/`.

**Reconciled:** 2026-07-15 on `feat/model-tier-benchmark-runner`.

The catalog-wide campaign preparation checkpoint is complete. The validated
catalog contains 15 models and 38 eligible placements (4/8/12/14 across the
8/16/24/32 GB tiers). Private campaign `20260715T-stage3-prep` was planned and
dry-run validated without starting Aperio, llama.cpp, or any model. A live
campaign now requires the explicit `--approve-live` flag.

Future approved command:

```bash
npm run model-tier:pilot -- --execute-campaign \
  --campaign <approved-campaign-id> --approve-live
```

The run remains sequential and isolated per placement: exact cached-model
admission, throwaway database/workspace, non-default ports, private `var/`
artifacts, fixed 300-second case envelope, and owned-process teardown. Do not
add `--allow-download` without separate approval.

**Reconciled:** 2026-07-15 on `feat/model-tier-benchmark-runner`.

The benchmark contract now enforces argument-level behavior for the two filtered
recall cases. `recall-filter-type` requires `type: "decision"`, and
`recall-filter-tag` requires `tags: ["redis"]`. Completed turns with missing or
incorrect arguments are model-behavior failures; whole-turn timeouts remain
harness-invalid.

Private artifact review showed that the third case was not blocked in the
`recall` tool. Four recall calls completed in a combined 43 ms, while their model
rounds consumed about 92.5, 56.6, 68.2, and 57.5 seconds. Context reached 93%,
was trimmed after every tool round, and a fifth model round began without
reaching `turn_complete`. The calls used an empty request, a limit-only request,
and two semantic Redis queries; none used the requested `tags: ["redis"]`
filter.

Each persisted case result records the assertion's expected and observed
arguments plus a per-assertion pass/fail outcome. Structured tool arguments are
also retained in the private benchmark event evidence. The catalog and full-exam
definitions carry the same assertion contract.

The private placement directory is:

`var/benchmarks/model-tiers/16gb/qwen35-9b-q4km/placement-20260715-qwen35-9b-16gb-93792a3/`

The opaque campaign ID was chosen while `93792a3` was `HEAD`, but a concurrent
docs-only commit landed during launch. `run.json` correctly records the actual
commit as `759107b`. Do not rename or promote the raw artifact. Cleanup was
complete: artifact files are mode `600`, the directory is `700`, and no
runner-owned process, listener, or temporary workdir remained.

## Current stage

The work is at **Stage 3 of 5 — bounded live verification complete**:

1. **Runner foundation — complete.** Isolation, exact-model admission, private
   artifacts, readiness, metrics, retries, teardown, aggregation, campaign
   planning/execution, and finalist evidence validation exist.
2. **Pilot contract hardening — complete.** Timeout, cleanup, and argument-level
   case assertions are covered by focused tests.
3. **Live qualification campaign — bounded checkpoint complete.** The
   operator-approved run was intentionally curtailed after representative
   cached placements; the full 38-placement catalog campaign was not required
   for this checkpoint and is not represented as complete.
4. **Finalist evidence — next.** Execute the 65-drill exam once, then repeat
   the four native recall and four multi-tool chain drills twice each. Record
   all observations, tool results, state assertions, context, RAM/swap, and
   native/scaffold recall split in private evidence.
5. **Tier decisions — not started.** Generate decisions only after finalist
   evidence validates, then obtain human review.
6. **Installer/runtime integration — not started.** Defaults must not change
   before approved tier decisions exist.

The tracked score viewer is now integrated at
`docs/model-tier-score-viewer.html` and linked from the docs navigation. That
visual deliverable is no longer part of the remaining benchmark-runner work.

## Next bounded checkpoint

Proceed to the E4B finalist exam under the private evidence contract in
`.github/model-tiers/full-exam.json`. Use the existing 24 GB campaign and its
continuation artifacts as qualification context; do not overwrite them or
rerun the already accepted benchmark cases. Do not generate `decisions.json`
or change installer/runtime/catalog wiring until the full exam, required
repeats, and human review are complete.

Keep the deferred `aperio-main` model-progress alias issue and installer/runtime
integration out of scope. Raw artifacts remain private under `var/`.
