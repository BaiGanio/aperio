# Completed checkpoint: finalist exam review and tier decisions

**Implemented:** 2026-07-14 on `feat/model-tier-benchmark-runner`.

This checkpoint consumes the campaign aggregate result contract and is complete.
It selects up to two valid comparable finalists per tier, records the full-exam
manifest, and generates private tier decisions from already-valid finalist
evidence. It does not execute a campaign, select installers, or integrate a
score viewer.

## Review contract

The runner now supports:

- `--finalists`, which writes private `finalists.json` from valid comparable
  campaign rows;
- `--decide --evidence <path>`, which writes private `decisions.json` and
  `decisions.md` after applying the full-exam gates;
- deterministic tier roles: default, fallback, unsupported, or unverified.

Validate without starting Aperio or llama.cpp:

```bash
npm run model-tier:pilot -- --validate
```

Focused verification passed 42 runner tests, catalog validation, syntax checks,
and `git diff --check`. No benchmark campaign or full exam was run.

## Next bounded checkpoint

Implement full campaign execution across the validated candidate catalog. Keep
installer/runtime integration, score-viewer integration, and new visuals out of
that checkpoint.
