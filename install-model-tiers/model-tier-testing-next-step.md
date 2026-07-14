# Completed checkpoint: exact model catalog and verification contract

**Implemented:** 2026-07-14 on `feat/model-tier-benchmark-runner`.

This checkpoint follows the campaign aggregate result contract and is complete.
It expands the candidate catalog and makes repository/quant verification a
validated preflight contract. It did not download models, run a campaign, rank
models, select installers, or integrate a score viewer.

## Catalog contract

The catalog contains 15 unique candidates covering 18 tier placements from the
runbook. Every entry records a stable ID, repository/quant identity, display
name, approximate size, eligible tiers, selection role, and dated Hugging Face
repository verification. The validator rejects identity drift, duplicate tier
values, unsupported roles, invalid sizes, and incomplete verification metadata.
Repository-only serving references are allowed only when the quant is explicit;
gpt-oss is recorded as `mxfp4`.

Validate without starting Aperio or llama.cpp:

```bash
npm run model-tier:pilot -- --validate
```

Focused verification passed 50 runner tests, catalog validation, syntax checks,
and `git diff --check`. No benchmark campaign was run.

## Next bounded checkpoint

Implement finalist full-exam orchestration and tier-decision generation from
already-valid campaign evidence. Keep installer decisions and score-viewer
integration out of that checkpoint.
