# Completed checkpoint: campaign aggregate result contract

**Implemented:** 2026-07-14 on `feat/model-tier-benchmark-runner`.

This checkpoint follows the honest-tier pilot measurement checkpoint and is
complete. It adds a non-live aggregate command for already-created artifacts;
it does not run a campaign, rank models, select installers, or integrate a
score viewer.

## Aggregate contract

Run:

```bash
npm run model-tier:pilot -- --aggregate --tier 16 --campaign <campaign-id>
```

The command scans the tier/model/campaign `run.json` artifacts and writes:

```text
var/benchmarks/model-tiers/<tier>gb/<campaign-id>/summary.json
var/benchmarks/model-tiers/<tier>gb/<campaign-id>/summary.csv
```

Completed runs are valid evidence even when one or more cases genuinely fail.
Invalid runs are listed as harness/environment evidence and never counted as
model failures. Valid runs whose campaign controls differ from the first valid
run are retained as `incomparable` and excluded from the comparable set.

The contract records model identity, case and hard-gate counts, section counts,
tool quality, qualification RAM/swap metrics, and the comparison-control
snapshot. Raw transcripts and logs remain private in the per-model artifact
directories.

## Verification

Focused runner tests cover valid failures versus invalid runs, control mismatch,
stable CSV output, and the existing pilot lifecycle. No live benchmark campaign
was run.

## What this checkpoint delivered

The pilot now treats tier selection as an admission and measurement policy. It
records whether the requested tier is physical or simulated, sizes served
context to the requested budget, and rejects hosts/configurations that cannot
represent that budget. Qualification sampling starts only after model load,
fixture import, embedding readiness, and graph readiness.

The checkpoint also exposed a retry/restart teardown race: a newly published
llama listener could appear after the first cleanup sweep. The runner now
performs a final sweep of the ephemeral port after stopping the Node process,
covered by a focused regression test.

## Completed bounded changes

1. Added the smallest cached exact model to `.github/model-tiers/models.json`:
   `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`.
2. Starts the isolated server and loads/warms the model before starting the
   qualification measurement window.
3. Waits for fixture import and embedding readiness before taking the post-load
   baseline.
4. Records load metrics separately from qualification metrics. The qualification
   baseline must be captured after model load and before the first case.
5. Makes tier semantics real. A tier run either enforces a memory budget or
   explicitly fail admission when the host cannot represent the requested tier;
   a `--tier` label alone is insufficient.
6. Preserves unconditional teardown of every runner-owned server/process after
   the measured run, including success, timeout, and invalid-run paths.

## Cached model inventory (exact GGUF facts, smallest first)

| Model | GGUF size |
|---|---:|
| `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL` | 3.93 GB |
| `unsloth/granite-4.1-8b-GGUF:Q4_K_M` | 4.98 GB |
| `unsloth/Qwen3.5-9B-GGUF:Q4_K_M` | 5.29 GB |
| `unsloth/Qwen3-VL-8B-Instruct-GGUF:Q4_K_M` | 5.97 GB |
| `unsloth/gpt-oss-20b-GGUF:Q4_K_M` | 10.83 GB |
| `google/gemma-4-26B-A4B-it-qat-q4_0-gguf:IT` | 13.45 GB |
| `unsloth/granite-4.0-h-small-GGUF:Q4_K_M` | 18.23 GB |
| `unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL` | 21.28 GB |

## Acceptance checks

- The smallest Gemma pilot starts only after the exact model is active and the
  28-memory fixture is embedding-ready.
- `run.json` distinguishes load timing/metrics from qualification timing and
  records the effective tier policy and host capacity.
- A requested 16 GB run cannot silently claim valid 16 GB evidence on a host or
  configuration that exceeds the defined budget.
- A successful five-case run is `status: "complete"`; timeout or admission
  failure remains `status: "invalid"` with a concrete reason.
- Owned Aperio and llama.cpp processes are gone after the run.
- Focused runner tests and `git diff --check` pass. The affected Gemma flow
  reached qualification with correct readiness and metric boundaries, but this
  verification pilot was invalid due to `fetch failed` in case 2 and must not be
  interpreted as model capability evidence. No full campaign was run.

## Next bounded checkpoint

Build the campaign-wide aggregate result contract: run-level summaries and
cross-model comparison artifacts for already-valid qualification results. Keep
finalist orchestration, installer decisions, and score-viewer integration out of
that checkpoint.

## Scope boundary

Implement and verify only this measurement/tier-integrity checkpoint. Do not
add the full catalog, full qualification suite, score-viewer integration, or a
campaign-wide ranking workflow in the same step.
