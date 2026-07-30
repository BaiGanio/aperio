# WS2 tests — before/after minimalism eval

Companion to [`ponytail-borrow-ws2.md`](./ponytail-borrow-ws2.md). Verify-first: **E0**
must be red before implementation starts, and every group below must be green before the
live run in Step 5 is trusted.

Home: `tests/integration/skills/minimalism-bench.test.js` (E1, E3, E4, E6) and
`tests/unit/helpers/minimalism-bench.test.js` (E2, E7). E5 is a manual live smoke,
recorded in the ledger — not a CI test.

## Coverage map

| Plan step | Test group | Coverage |
|---|---|---|
| Step 1 — sandbox + arms | **E1** | arm construction, index delta, per-task match pre-flight |
| Step 2 — metrics | **E2** | LOC counter, token accounting, correctness runner |
| Step 3 — task fixtures | **E3** | reference solutions pass, corner-cutting fails, prompts held out |
| Step 4 — runner + ledger | **E4** | dry-run pipeline, ledger row completeness |
| Step 4 — hygiene | **E6** | no stray state, teardown on failure, no orphan processes |
| Step 5 — live + verdict | **E5** (manual), **E7** | live smoke comparability; verdict thresholds incl. INCONCLUSIVE |
| — | **E0** | red gate: nothing exists yet |

## E0 — Red gate (run before implementing)

**Name:** the eval does not exist yet
**Setup:** clean checkout at WS1 HEAD.
**Expected:** `node scripts/minimalism-bench.js --dry-run` exits non-zero (module not
found); `var/autotune/minimalism.tsv` does not exist; both test files are absent.
**Assertions:** all three conditions hold simultaneously.
**Edge:** if any already exists, stop — someone started WS2 and this plan needs reconciling
before more code lands.

## E1 — Arm construction (offline, no model)

**Name:** arm A indexes the skill, arm B does not
**Setup:** build both sandboxes via the shared factory; call `loadSkillIndex(root/skills, root/var/skills, [])` on each.
**Expected:** the two indexes differ by exactly one entry, named `code-minimalism`.
**Assertions:** `A.length - B.length === 1`; `A.some(s => s.name === "code-minimalism")`;
`!B.some(...)`; every other skill name set is identical (sorted compare).
**Edge:** arm B must not contain a zero-keyword or empty-body remnant — assert by name
absence, not by keyword emptiness, so a future stub approach can't pass this by accident.

**Name:** every fixture prompt loads the skill in A and never in B
**Setup:** for each task fixture, run `matchSkills(task.prompt, index, { limit: 3 })` against both indexes.
**Expected:** arm A's result contains `code-minimalism`; arm B's does not.
**Assertions:** per-task, both directions. A failure here fails the *run*, not the task's score.
**Edge:** a prompt that also matches `code-simplification` is acceptable; a prompt matching
neither in arm A is a broken fixture.

**Name:** the sandbox assembles the real system prompt
**Setup:** build a sandbox; read `root/id/whoami.md`, `capabilities.md`, `self-nature.md`.
**Expected:** all three exist and are non-empty.
**Assertions:** `existsSync` + length > 0 for each — `createAgent` swallows read failures
into `""` (`lib/agent/index.js:146`), so a missing `id/` would silently produce a
persona-less agent in both arms and nobody would notice.

## E2 — Metrics (unit)

**Name:** LOC counter ignores blanks and comments
**Setup:** fixture files with blank lines, `//`, `/* … */`, a `//` inside a string literal, and JSDoc.
**Expected:** blank and comment-only lines excluded; the string-literal line counted.
**Assertions:** exact integer per fixture.
**Edge:** the string-literal case is the one a naive regex gets wrong — it is the point of the test.

**Name:** LOC counts only files created or modified in the workspace
**Setup:** workspace with one pre-existing untouched file, one modified, one new.
**Expected:** untouched file contributes 0; modified contributes its **delta**, not its size.
**Assertions:** total equals new-file LOC + modified delta.
**Edge:** a file deleted by the model contributes a negative delta, not a crash.

**Name:** token accounting sums usage across all turns
**Setup:** synthetic sink events: three `stream_end` frames with known `input_tokens`/`output_tokens`, one with `usage` absent.
**Expected:** sums are correct; the missing-usage frame contributes 0 rather than `NaN`.
**Assertions:** `input`, `output`, and `net === input + output` all exact.
**Edge:** `zeroUsage()` frames (error paths emit them, `providers/llamacpp.js:81`) must not be
mistaken for "no data" — they are real zeros.

**Name:** correctness runner reports honest failure
**Setup:** run the reference tests against (a) a passing solution, (b) a failing one, (c) a workspace where the solution file is missing.
**Expected:** `true`, `false`, `false` — never a throw that aborts the matrix.
**Assertions:** boolean per case; the runner's non-zero exit is captured, not propagated.
**Edge:** a reference test that hangs is killed by timeout and scores `false`.

## E3 — Task fixtures

**Name:** every fixture's reference solution passes its own tests
**Setup:** for each of the 6 tasks, run the reference tests against the committed reference solution.
**Expected:** all pass.
**Assertions:** exit code 0 per task.
**Edge:** a fixture with no assertions at all fails this group — an empty test file must not read as "correct".

**Name:** corner-cutting solutions fail the two non-negotiable tasks
**Setup:** the two validation/error-path tasks ship an `anti-solution/` — correct on the happy path, no input validation, no error handling.
**Expected:** reference tests fail.
**Assertions:** exit code non-zero for both.
**Edge:** this is the teeth check for the whole "minimalism ≠ corner-cutting" claim; if the
anti-solution passes, the fixture is decorative and must be rewritten.

**Name:** fixture prompts are held out from the autotune eval set
**Setup:** load `skills/autotune/eval.json` + `eval.holdout.json`; normalize whitespace/case.
**Expected:** no fixture prompt appears in either.
**Assertions:** empty intersection.
**Edge:** near-duplicates are a judgment call — assert exact-match absence and flag any
prompt with >0.8 token overlap for developer review rather than failing the build.

## E4 — Runner + ledger (dry-run, CI-safe)

**Name:** `--dry-run` reproduces the eval end-to-end with no live model
**Setup:** `node scripts/minimalism-bench.js --dry-run --tasks=<two ids> --repeats=1`.
**Expected:** exit 0; the mock provider is used; no network; no llama-server spawned.
**Assertions:** ledger gains exactly 4 rows (2 tasks × 2 arms × 1 repeat); no listening socket opened.
**Edge:** with `NODE_ENV` unset the mock must refuse to resolve (`lib/providers/index.js`) —
the dry-run sets it or fails loudly; it must never silently fall through to a real provider.

**Name:** ledger rows are complete and typed
**Setup:** inspect the rows from the previous case.
**Expected:** all 12 columns present per row, tab-separated, one header line at file creation only.
**Assertions:** `net_tokens === input_tokens + output_tokens`; `arm ∈ {A,B}`; `correct ∈ {0,1}`;
`skill_sha` equals the sha256 of the arm-A `SKILL.md` and is identical across a run.
**Edge:** appending to an existing ledger must not rewrite the header; a schema change must
bump a version column rather than silently mixing shapes.

## E5 — Live smoke (manual, Step 5 gate)

**Name:** one task, both arms, real llama.cpp
**Setup:** live llama-server on Qwen2.5-Coder-7B; `--tasks=<one id> --repeats=1`.
**Expected:** 2 rows; both arms complete; token counts non-zero and plausible.
**Assertions:** arm A's `input_tokens` exceeds arm B's by roughly the skill's size
(~1.7k, ±30% for tokenizer and context-assembly variance) — the direct evidence the skill
was actually loaded in A and not in B, on the wire rather than by assumption.
**Edge:** if arm A's input tokens are *not* elevated, the eval is measuring nothing —
stop and fix arm construction before running the matrix.

## E6 — Hygiene

**Name:** no stray state after a run
**Setup:** record `git status --porcelain` and a listing of repo `var/` before and after a dry-run.
**Expected:** identical except `var/autotune/minimalism.tsv`.
**Assertions:** set difference is exactly that one path.
**Edge:** covers the standing no-stray-state rule; the sandbox lives under `mkdtemp`, never in the tree.

**Name:** teardown survives failure and interruption
**Setup:** force a mid-run throw; separately, send SIGINT mid-run.
**Expected:** the mkdtemp root is removed in both cases; any child process is killed.
**Assertions:** sandbox path absent afterwards; no orphan PID.
**Edge:** a hung `node --test` child must be killed by the same path, not left behind.

## E7 — Verdict function (unit)

**Name:** pre-registered thresholds produce the pre-registered verdicts
**Setup:** four synthetic ledgers — a clear win, an LOC win with positive net tokens, a
no-effect set, and one with a correctness regression plus a large LOC win.
**Expected:** `KEEP`, `TRIM`, `DROP`, `DROP`.
**Assertions:** exact verdict string per ledger. The fourth is the one that matters: a
correctness regression is disqualifying no matter how good the token numbers look.
**Edge:** an effect smaller than the inter-repeat spread returns `INCONCLUSIVE`, never a
rounded-up `KEEP`.

**Name:** medians, not means
**Setup:** a ledger with one extreme outlier repeat.
**Expected:** the verdict is unchanged by the outlier.
**Assertions:** same verdict with and without the outlier row.
**Edge:** with an even number of repeats the median is the mean of the middle two — assert
the exact value so the convention is pinned.

## Test execution order

1. **E0** first, red, before any implementation.
2. **E2** and **E7** — pure units, no sandbox, no fixtures. Independent.
3. **E1** — needs the sandbox factory (Step 1) and the fixtures' prompts (Step 3).
4. **E3** — needs fixtures and the correctness runner from E2.
5. **E4** — needs everything above.
6. **E6** — runs against an E4 dry-run.
7. **E5** — manual, last, only once 1–6 are green.

## Required setup

- Node's native test runner; no new dependencies.
- Fixtures at `tests/fixtures/minimalism-tasks/<id>/` with `task.json` (prompt, id),
  `tests/` (reference tests), `reference/` (passing solution), and — for the two
  non-negotiable tasks — `anti-solution/`.
- Live llama-server with `LLAMACPP_MODEL=Qwen2.5-Coder-7B` for **E5** only.
- `NODE_ENV=test` for the dry-run so the mock provider resolves.
- No repo `var/` writes other than `var/autotune/minimalism.tsv`.

## Teeth check (house convention)

Before declaring the suite green, break each of these one at a time and confirm exactly the
intended test goes red: remove `code-minimalism` from arm A's sandbox (**E1**), make the LOC
counter count blank lines (**E2**), let the anti-solution pass (**E3**), drop a ledger
column (**E4**), and flip the correctness-regression branch in the verdict (**E7**).
