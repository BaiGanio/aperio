# Completed checkpoint: isolated retry-readiness verification

**Implemented:** 2026-07-15 on `feat/model-tier-benchmark-runner`.

This checkpoint verifies the retry-readiness and private-artifact fixes in the
isolated pilot runner. Verification placement
`verification-20260715-readiness-fix` loaded the exact cached Gemma 4 E4B
`UD-Q4_K_XL` model at the simulated 8 GB tier, completed all five pilot cases,
and finished with four passes and one model-behavior failure. Retry restoration
completed without the previous generic `fetch failed` harness invalidation.
Artifacts remained private (`600` files, `700` directory), and no runner-owned
process, listener, or temporary directory remained. It does not select
installers or integrate a score viewer or visuals.

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
- retry restoration that waits for both HTTP routes and the WebSocket/app-ready
  handshake before importing the fixture;
- retry failures that preserve their phase (`state restoration` or `context
  creation`) in the invalid-run reason;
- copied llama diagnostics forced to private mode `600`.

Validate without starting Aperio or llama.cpp:

```bash
npm run model-tier:pilot -- --validate
```

Focused verification passed 50 runner tests, catalog validation, syntax checks,
and `git diff --check`. The approved readiness verification completed all five
pilot cases and produced private artifacts. Its 4/5 result is verification
evidence only, not campaign-ranking evidence.

## Next bounded checkpoint

Reconcile the private readiness-verification artifact, then propose the next
explicitly approved live placement one model/tier at a time. Reconcile each
private pilot artifact before any finalist/full-exam execution.
Keep installer/runtime integration, score-viewer integration, and new visuals
out of that checkpoint.
