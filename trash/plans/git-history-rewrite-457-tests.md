# Tests — git history rewrite (issue #457)

Domain: infrastructure/ops. "Test" = a shell command whose output is a pass/fail
fact about the git history, checked against a known-bad baseline captured before
any destructive step runs.

**Scope note:** investigation found GitHub `origin` currently has only 4 branches
(`beta-docs_lang`, `dev`, `master`, `release`), and only `master` carries the
exposed paths. So this rewrite touches one branch, not the 13 originally assumed —
tests below are scoped accordingly.

## Coverage map

| Plan step | Test group | Coverage |
|---|---|---|
| Step 1 (backup) ✅ | Ops: backup integrity | Backed-up copy matches source byte-for-byte |
| Step 3 (scoped mirror) | Ops: ref scoping | Mirror contains exactly `refs/heads/master`, nothing else |
| Step 4–5 (filter-repo run + verify) | Ops: history strip | Target paths unreachable from `master`; size drops |
| Step 6 (pre-push review) | Ops: build/boot sanity | Filtered `master` installs and boots in an isolated worktree |
| Step 7 (force-push) | Ops: remote parity | `origin/master` tip hash matches filtered mirror's local hash |
| Step 8 (re-clone) | Ops: fresh-clone correctness | Fresh clone boots, tests pass, `.git` size reduced |
| Step 9 (housekeeping) | Docs: closeout | A2D entry gone; sync-documentation checked |

## Test cases

### T1 — Backup integrity (Step 1) ✅ DONE
- **Setup:** `trash/audits/continuous-audit/runs` copied to
  `~/backups/aperio-audit-runs-20260815-150024/`.
- **Result:** `diff -r trash/audits/continuous-audit/runs
  ~/backups/aperio-audit-runs-20260815-150024/runs` exited 0 (verified).

### T2 — Ref scoping in scratch mirror (Step 3)
- **Setup:** fresh `--bare --mirror` clone of `origin`, pruned to only
  `refs/heads/master`.
- **Expected:** exactly 1 head remains.
- **Assertion:** `git for-each-ref refs/heads/ | wc -l` equals 1.
- **Edge case:** a tag reachable only through `master`'s history — decide
  explicitly whether it survives the filter (default: keep tags; do not pass
  `--no-tags` unless the developer confirms tags should also be dropped).

### T3 — History strip completeness (Step 5)
- **Setup:** `filter-repo --invert-paths --path audit --path
  manual/preview-output --path output/pdf --force` run in the scratch mirror.
- **Expected:** zero commits reference any of the three paths.
- **Assertion:**
  ```
  git log --all --oneline -- audit manual/preview-output output/pdf | wc -l   # must print 0
  ```
- **Edge case (the one that matters most):** re-run the exact investigation query
  (`git log --all --oneline -- "audit"`) — if it returns non-zero, the path spec is
  wrong and Step 4 must be redone before touching `origin`. This is the check that
  would have caught Round 1's wrong-path mistake (`trash/audits/continuous-audit/runs`
  instead of `audit`) — a wrong path would make this assertion falsely pass (0
  hits, because it never matched anything) while `audit/` stayed fully exposed, so
  also require T4's size check to move, not just this query to return 0.

### T4 — Size reduction sanity (Step 5)
- **Setup:** scratch mirror `.git` size recorded before filtering and after
  `git reflog expire --expire=now --all && git gc --prune=now --aggressive`.
- **Expected:** post-filter size drop is in the same order of magnitude as the
  ~343 MB blob estimate computed during investigation (not near-zero).
- **Assertion:** `du -sh .` before/after; drop ≥ 250 MB.
- **Edge case:** if the drop is near-zero despite T3 passing, some other large
  blob was already the dominant contributor — investigate before proceeding
  rather than assuming success.

### T5 — F-R2-01 finding file unreachable (Step 5)
- **Setup:** note the blob SHA of `audit/runs/run-002/findings.json` from the
  pre-filter mirror (`git rev-list --objects --all -- audit/runs/run-002/findings.json`).
- **Expected:** that blob SHA is unreachable after filter + gc.
- **Assertion:** `git cat-file -e <sha>` exits non-zero (fails) after Step 5's gc.
- **Edge case:** none — this is the specific secret-egress finding named in the
  A2D entry as the reason for urgency; treat any pass here as load-bearing for
  sign-off.

### T6 — Filtered `master` boots (Step 6)
- **Setup:** checkout the filtered mirror's `master` into an isolated scratch
  worktree, `npm ci`.
- **Expected:** install succeeds; test failure count matches a pre-rewrite
  baseline run on the current `master` (no NEW failures caused by the rewrite).
- **Assertion:** `npm ci` exit 0; `npm test` failure count matches baseline.
- **Edge case:** re-grep `grep -rn "audit/\|manual/preview-output\|output/pdf"
  --include=*.test.js` in the filtered checkout — confirmed already repointed by
  `d69489df`, double-check nothing else references the stripped paths.

### T7 — Remote parity (Step 7)
- **Setup:** after `git push --force origin master:master`.
- **Expected:** `origin/master`'s tip matches the filtered mirror's local tip.
- **Assertion:** `git ls-remote origin refs/heads/master` hash equals
  `git rev-parse master` in the filtered mirror.
- **Edge case:** tip hash differs from expected because another session pushed to
  `master` between Step 3's mirror snapshot and now — abort, re-fetch, re-derive
  the filtered branch from the new tip, do not force through.

### T8 — Fresh clone correctness (Step 8)
- **Setup:** `git clone` from `origin` into a new directory after the push lands.
- **Expected:** clone succeeds, `master` boots (`npm ci`, smoke test), `.git` size
  reflects the rewrite.
- **Assertion:** `du -sh .git` in the fresh clone is within the same reduced range
  verified in T4; `npm ci && npm run test:ci` (or documented smoke command) exits
  with the same baseline failure count as T6.
- **Edge case:** any local uncommitted work in the pre-rewrite working directory —
  confirmed via `git status` before Step 8 begins; moved aside, not deleted.

### T9 — Closeout (Step 9)
- **Setup:** after T1–T8 all pass.
- **Expected:** A2D.md's "Release / git hygiene" entry removed; sync-documentation
  skill run and its recommendation acted on or explicitly declined.
- **Assertion:** `grep -c "Full git-history rewrite" A2D.md` returns 0;
  sync-documentation's output referenced in the handoff.

## Test execution order

T1 ✅ → T2 → T3 → T4 → T5 (all within the scratch mirror, no `origin` contact) →
**developer sign-off gate** → T6 (still scratch-only) → **developer sign-off
gate** → T7 (live against `origin`) → T8 (fresh clone) → T9.

T1–T6 are fully reversible (nothing touches `origin` or the real working repo).
T7 onward is not reversible — do not begin T7 until T1–T6 all pass and the
developer has explicitly approved proceeding past Step 6's gate.

## Required setup

- `git-filter-repo` installed ✅ done (Step 2, brew, v2.47.0).
- Scratch directory outside the repo (session scratchpad), cleaned up once
  T1–T8 all pass.
- `gh` CLI authenticated (already confirmed working during investigation).
- Baseline `npm test` failure count on current `master`, captured **before** Step
  4 runs, for T6/T8 comparison.
