# Completed checkpoint: slow multi-tool timeout repair

**Implemented:** 2026-07-15 on `feat/model-tier-benchmark-runner`.

Two approved cached Qwen3.5 9B Q4_K_M placements at the simulated 16 GB tier
reproduced the same invalid first-case timeout under the former 120-second
whole-turn deadline. Exact-model admission, the throughput probe, the 28-memory
fixture, embedding readiness, private artifacts, and cleanup all succeeded.
The model made successful `recall` calls, but its 34–57 second prompt-prefill
rounds left insufficient time for the next round to emit `turn_complete`.

The benchmark default now allows 300 seconds for the complete multi-tool case.
This matches llama.cpp's existing per-request ceiling while retaining a bounded
turn and preserving completed wall time as ranking evidence. A timeout remains
an invalid benchmark run, never a model failure. The repair changed only the
benchmark case-normalization contract and its focused test; it did not alter
`lib/context/`, installer/runtime behavior, score-viewer visuals, or model
selection.

## Review contract

- The five pilot cases inherit one fixed 300-second whole-turn timeout.
- Explicit positive per-case overrides remain supported by the validator.
- Timeout and retry controls must remain identical within a campaign.
- Raw artifacts remain private under `var/benchmarks/model-tiers/`.
- Invalid runs remain excluded from model scoring and ranking.
- The two earlier Qwen artifacts remain diagnostic evidence only:
  `placement-20260715-qwen35-9b-16gb-cf329a8` and
  `placement-20260715-qwen35-9b-16gb-cf329a8-retry1`.
- The misleading warm-request `model_status: loading` alias mismatch is a
  separate deferred observability issue.

Validate without starting Aperio or llama.cpp:

```bash
npm run model-tier:pilot -- --validate
node --test tests/lib/helpers/modelTierBench.test.js tests/scripts/model-tier-bench.test.js
```

Focused verification passed 62 tests, catalog validation, syntax checks, and
scoped whitespace checks. No model was executed after the timeout changed.

## Next bounded checkpoint

Reconcile the committed timeout repair, then propose one explicitly approved
rerun of the exact cached `qwen35-9b-q4km` placement at the simulated 16 GB tier
under a new private campaign ID. Reconcile that artifact and cleanup before any
other placement or harness change. Do not implicitly fix the model-progress
alias mismatch, execute a wider campaign, integrate installer/runtime behavior,
or integrate score-viewer visuals.
