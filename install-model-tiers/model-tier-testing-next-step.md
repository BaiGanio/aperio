# Completed checkpoint: catalog-wide campaign execution

**Implemented:** 2026-07-14 on `feat/model-tier-benchmark-runner`.

This checkpoint adds catalog-wide execution without running models during
implementation. It consumes the private per-tier campaign plans, expands the
current catalog to all 38 eligible tier/model placements, invokes the existing
pilot lifecycle sequentially, and records private per-tier execution ledgers.
It does not select installers or integrate a score viewer or visuals.

## Review contract

The runner now supports:

- `.github/model-tiers/full-exam.json`, which enumerates all scored drills and
  repeat groups from the capability-exam sections;
- `--finalists`, which writes private `finalists.json` from valid comparable
  campaign rows;
- `--decide --evidence <path>`, which writes private `decisions.json` and
  `decisions.md` after validating the 81-observation evidence contract and
  applying the full-exam gates;
- deterministic tier roles: default, fallback, unsupported, or unverified.
- `--execute-campaign --campaign <id>`, which executes every placement in the
  private plan sequentially through the existing pilot runner;
- `--execute-campaign --dry-run --campaign <id>`, which validates placement
  ordering and scope without starting model processes;
- private `execution.json` ledgers that preserve campaign controls and each
  placement's process outcome.

Validate without starting Aperio or llama.cpp:

```bash
npm run model-tier:pilot -- --validate
```

Focused verification passed 48 runner tests, catalog validation, syntax checks,
and `git diff --check`. No benchmark campaign or model was run.

## Next bounded checkpoint

Run an explicitly approved isolated campaign dry-run or live campaign review,
then reconcile produced private artifacts before any finalist/full-exam
execution. Keep installer/runtime integration, score-viewer integration, and
new visuals out of that checkpoint.
