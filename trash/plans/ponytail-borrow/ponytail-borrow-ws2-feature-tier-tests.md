# WS2 feature-tier tests

Companion to [`ponytail-borrow-ws2-feature-tier.md`](./ponytail-borrow-ws2-feature-tier.md).
Extends, not replaces, [`ponytail-borrow-ws2-tests.md`](./ponytail-borrow-ws2-tests.md) — E0-E7
still apply unchanged to the sanity tier and to the shared plumbing (sandbox, metrics, ledger,
verdict). This file covers only what's new: the `cache-entry-ttl` fixture and the tier split.

## Coverage map

| Plan step | Test group | Coverage |
|---|---|---|
| Step F1 — fixture files | **F1** | reference passes merged tests, anti-solution fails, prompt held out, prompt loads the skill |
| Step F2 — dry-run integration | **F2** | multi-file seed/reference round-trips through the existing pipeline unmodified |
| — | **F0** | red gate: the fixture does not exist yet |

## F0 — Red gate

**Name:** the feature-tier fixture does not exist yet
**Setup:** clean checkout before this work.
**Expected:** `tests/fixtures/minimalism-tasks/cache-entry-ttl/` does not exist.
**Assertions:** directory absence.

## F1 — Fixture correctness (reuses E1/E3's existing generic loops)

**Name:** the fixture is picked up by the existing generic checks with no test-file changes
**Setup:** none beyond adding the fixture directory — `loadFixtures(null)` in
`minimalism-bench.test.js` already iterates every directory under `tests/fixtures/minimalism-tasks/`.
**Expected:** E1's "every fixture prompt loads the skill in A and never in B" and E3's "every
fixture's reference solution passes its own tests" / "prompts held out" tests cover
`cache-entry-ttl` automatically.
**Assertions:** those three existing tests stay green after the fixture is added, with no edits
to their bodies.

**Name:** the merged seed-tests + grading-tests directory runs both without conflict
**Setup:** `runFixtureTests({ testsDir: <fixture>/tests, solutionDir: <fixture>/reference })`.
**Expected:** scratch ends up with both `tests/store.test.js` (from `reference/`, unchanged from
`seed/`) and `tests/ttl.test.js` (the fixture's own grading tests) present and both executed.
**Assertions:** exit code 0; a temporary variant with a bug reintroduced into the unchanged
`store.test.js`-covered behavior (e.g., break `delete`) makes the run fail, proving that file is
actually being executed and not silently shadowed.

**Name:** the anti-solution fails on the non-negotiable behavior, not on the happy path
**Setup:** `runFixtureTests({ testsDir, solutionDir: anti-solution })`.
**Expected:** exit code non-zero; specifically the "expires from `has`", "negative `ttlMs`
throws", and "non-numeric `ttlMs` throws" cases fail while every `store.test.js` case (get/set/
delete/size, no ttl) still passes.
**Assertions:** add `cache-entry-ttl` to the two hardcoded id lists in
`minimalism-bench.test.js` ("ships a reference test file with real assertions" and "corner-cutting
anti-solutions fail") alongside `divide-with-validation`/`parse-config-value`; both loops pass
for the new id.

**Name:** the prompt is held out and not a near-duplicate of a tuned autotune prompt
**Setup:** normalize + exact-match against `eval.json`/`eval.holdout.json` (existing E3 test,
covers this fixture automatically since it iterates all fixtures).
**Expected:** no exact match.
**Assertions:** existing test passes. **Edge (manual, not automated):** the prompt was
deliberately phrased to differ structurally from `eval.json`'s `min.feature` case
("Add a small feature to X: Y") rather than just swapping the nouns — a judgment call recorded
here per the WS2 test spec's near-duplicate guidance, not something a test can enforce.

## F2 — Dry-run integration (multi-file round-trip)

**Name:** `--dry-run --tasks=cache-entry-ttl` reproduces the eval with a 3-file seed
**Setup:** isolate the ledger first (today's 34 rows backed up + cleared per developer
confirmation, so this doesn't mix with them); run
`node scripts/minimalism-bench.js --dry-run --tasks=cache-entry-ttl --repeats=1`.
**Expected:** exit 0; ledger gains exactly 2 rows (arm A, arm B); each row's `loc` reflects only
the `store.js` delta — the unchanged `index.js` and `store.test.js` contribute 0 even though they
exist in both `seed/` and `reference/`.
**Assertions:** row count; `loc` matches `countSourceLoc` of the reference `store.js` minus the
seed `store.js` (a small positive number, not the whole project's line count).
**Edge:** confirms `snapshotDir`/`locDelta`/`buildMockScript` — all unmodified since WS2 shipped —
handle a nested `lib/`+`tests/` seed correctly; this is the actual integration risk the brief
called out, not a new code path.

**Name:** the existing suite stays green with the new fixture present
**Setup:** `node --test tests/unit/helpers/minimalism-bench.test.js
tests/integration/skills/minimalism-bench.test.js`.
**Expected:** all pass, including the SIGINT/hygiene tests that enumerate every fixture id in
`--tasks=`.
**Assertions:** exit 0 for both files.

## Test execution order

1. **F0** first (trivially true — nothing built yet).
2. **F1** — needs the fixture files (Step F1) and the sandbox/matching plumbing from WS2 (reused,
   already green).
3. **F2** — needs F1 green and a ledger safe to write to (backup + clear done first).

## Required setup

- Dry-run tests may use `var/autotune/minimalism.tsv`, but a live model run must use an
  evaluator-owned server on dedicated port `18080`, a run-specific runtime/log root and a
  per-model ledger outside the repository. Never reuse the app's current server, database,
  logs, or ledger. Readiness (`/health` plus requested model) must pass before the first cell;
  any cell with both usage counters at zero invalidates the run.
- No new dependencies, no `--tier=` flag (see plan doc's "No new CLI flag").
- Live model only for Step F3 (out of scope for this test file — see the main plan's Step F3).

## Teeth check

Break these one at a time and confirm exactly the intended test goes red: remove the `ttlMs`
validation from `reference/lib/store.js` (F1's reference-passes check should fail); make
`anti-solution/lib/store.js`'s `has()` also check expiry (F1's anti-solution check should now
wrongly pass, i.e. the fixture would need rewriting — this is the check that the anti-solution
is genuine, not decorative); delete `reference/tests/store.test.js` (F2's dry-run `loc` assertion
should now see the untouched file miscounted, since it would fall out of both snapshots
identically rather than confirming the merge path).
