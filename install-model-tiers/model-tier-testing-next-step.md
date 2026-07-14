# Completed checkpoint: finalist exam manifest and evidence contract

**Implemented:** 2026-07-14 on `feat/model-tier-benchmark-runner`.

This checkpoint prepares live finalist execution without running models. It adds
the machine-readable 65-drill manifest, expands the critical repeats to 81
observations, validates finalist evidence against the private artifact schema,
and keeps tier decisions limited to complete evidence. It does not execute a
campaign, select installers, or integrate a score viewer.

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

Validate without starting Aperio or llama.cpp:

```bash
npm run model-tier:pilot -- --validate
```

Focused verification passed 44 runner tests, catalog validation, syntax checks,
and `git diff --check`. No benchmark campaign or full exam was run.

## Next bounded checkpoint

Implement full campaign execution across the validated candidate catalog. Keep
installer/runtime integration, score-viewer integration, and new visuals out of
that checkpoint.
