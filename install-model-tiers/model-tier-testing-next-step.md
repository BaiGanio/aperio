# Next checkpoint: honest tier pilot measurements

## Why this checkpoint is next

The current pilot runner labels a run with `--tier`, but does not enforce that
RAM tier. It also starts memory sampling before llama.cpp finishes loading the
model. The Qwen3.5 9B pilot therefore reported a misleading system peak of
about 34.3 GB on a 32 GB host, with about 2.86 GB of swap already in use at
baseline. That is not valid evidence for a 16 GB installation tier.

The runner did stop its owned server after the timeout through `finally`; the
remaining problem is measurement boundaries and tier realism, not an
unreleased server.

## Required bounded changes

1. Add the smallest cached exact model to `.github/model-tiers/models.json`:
   `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`.
2. Start the isolated server and load/warm the model before starting the
   qualification measurement window.
3. Wait for fixture import and embedding readiness before taking the post-load
   baseline.
4. Record load metrics separately from qualification metrics. The qualification
   baseline must be captured after model load and before the first case.
5. Make tier semantics real. A tier run must either enforce a memory budget or
   explicitly fail admission when the host cannot represent the requested tier;
   a `--tier` label alone is insufficient.
6. Preserve unconditional teardown of every runner-owned server/process after
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
- A successful three-case run is `status: "complete"`; timeout or admission
  failure remains `status: "invalid"` with a concrete reason.
- Owned Aperio and llama.cpp processes are gone after the run.
- Focused runner tests, the smallest-model pilot path, `git diff --check`, and
  the affected flow are verified. Do not run a full campaign.

## Scope boundary

Implement and verify only this measurement/tier-integrity checkpoint. Do not
add the full catalog, full qualification suite, score-viewer integration, or a
campaign-wide ranking workflow in the same step.
