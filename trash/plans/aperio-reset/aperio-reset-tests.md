# Aperio Reset — verification tests

Companion to `trash/plans/aperio-reset/aperio-reset.md`. Verify-first: confirm each check
is **red** on today's master before starting the step, then make it green.

## Coverage map

| Plan step | Test group | Coverage |
|---|---|---|
| S0.1 | T0.1 CI: audit non-blocking | workflow triggers, local audit run |
| S0.2 | T0.2 Unit: deterministic sampler | repeat-run stability |
| S0.3 | T0.3 CI: release pipeline | bump calc, packaging, dispatch path |
| S0.4 | T0.4 Release smoke | asset present, zip boots, release branch |
| S1.0 | T1.0 Archive tag reachable | tag pushed, files restorable |
| S1.1 | ~~T1.1 Repo grep: infra gone~~ | **RETIRED** — S1.1 dropped 2026-10-22, nothing deleted |
| S1.2 | T1.2 Bots parked, not deleted | no active refs, docs updated |
| S1.3 | T1.3 Badges + checks | README badges true, ruleset unaffected, CodeQL live |
| S1.4 | T1.4 Spawn kept, parked | no deletion, #319/#320 point at #498 |
| S1.5 | T1.5 Tracker state | every open issue mapped or parked |
| S2.1 | T2.1 Perf: server stays responsive | latency under indexing |
| S2.2 | T2.2 Integration: watcher languages | per-language save → graph update |
| S2.3 | T2.3 Unit/UI: overlay timeout | busy message |
| S2.4 | T2.4 Integration: bridge races | delete/sweep/reindex interleavings |
| S2.5 | T2.5 Unit: redact round trip | restore or mode removed |
| S2.6 | T2.6 Integration: terminal loop | commands via injected IO |
| S3.1 | T3.1 Review checklist | every slop-touched file accounted for |
| S3.2 | T3.2 Refactor safety | suite + harness green, no behaviour change |
| S4.1–S4.2 | T4.1 Launch map | decisions listed, date set |

## Test cases

### T0.1 — audit gate is not triggered by push
- **Setup:** edited `.github/workflows/ci.audit.yml`.
- **Expected:** `on:` contains only `workflow_dispatch`.
- **Assertions:** after the push, `gh run list --workflow "(ci) continuous-audit gates" --limit 1`
  shows no new run for that commit; `npm run test:audit` exits 0 or reports #569 only.
- **Edge cases:** PR to master also starts no audit run.

### T0.2 — metrics sampler is deterministic
- **Setup:** fake timers / injected clock in `tests/unit/helpers/metricsSampler.test.js`.
- **Expected:** "never runs overlapping samples" asserts repeated sampling without real waits.
- **Assertions:** `for i in $(seq 50); do node --test tests/unit/helpers/metricsSampler.test.js || exit 1; done` passes; next macOS install-matrix run green.
- **Edge cases:** test still **fails** if the overlap guard in `lib/helpers/metricsSampler.js` is removed (has teeth).

### T0.3 — release bump uses every commit since last tag
- **Setup:** bump logic extracted into a testable script (or a bats-style shell test) fed with commit lists.
- **Expected:** `[fix: a, chore: b]` → patch; `[chore: a, feat: b]` → minor; `[chore: a]` → skip; `[feat(launchers): a]` → minor + launchers.
- **Assertions:** each case returns the right `bump` / `with_launchers`; `workflow_dispatch` with `tag=v0.69.1` runs `package-source`.
- **Edge cases:** `[skip ci]` release commits never count; no tag is re-forced once it has a release; root cause of the v0.69.1 `git push` failure written in the PR.

### T0.4 — release is real and usable — **PASS 2026-10-22 (v0.69.2)**
- **Setup:** S0.3 merged, release cut. The version is **v0.69.2**, not `v0.70.*`: the bump
  is computed from the commits since the last tag and the range held no `feat:`. v0.70.0 is
  reserved for S4.1.
- **Assertions:** `gh release view v0.69.2 --json assets` lists `aperio-lite.zip` **✅ 6.44 MB**
  (plus `aperio-lite-v0.69.2.zip`, same size), `draft: False`; lite-smoke green on the tag
  **✅ 5/5 runners** (needs `gh workflow run ci.lite-smoke.yml --ref v0.69.2` — the workflow
  triggers on push to master/dev and on PRs, never on tags; run `39820710035`);
  `git ls-remote origin refs/heads/release` == the tag's commit **✅ both `52778b7b`**.
- **Edge cases:** zip size **6.44 MB** against the 5.1 MB v0.68.0 baseline — +26%, nowhere
  near ~350 MB (#455 timed fault) **✅**. Zip root carries `START.sh`, `START.bat`,
  `assets/` and `how-to/` **✅**.
- **Found while verifying, already covered elsewhere:** the user zip also ships `trash/`
  (56 entries, including this plan), `audit/` (34), `k8s/` + `vms/` (32), `AGENTS.md`,
  `CONTRIBUTING.md`, `id/` and `scripts/`. Not logged to A2D because
  `trash/plans/lite-zip-decouple/lite-zip-decouple.md` already names every one of those
  paths and the dead `ZIP_EXCLUDES` env var behind them.

### T1.0 — archive tag reachable
- **Assertions:** `git ls-remote --tags origin archive/pre-reset-2026-10-22` returns the tag; in a scratch clone `git checkout archive/pre-reset-2026-10-22 -- k8s vms lib/agent/spawn.js` restores all three.
- **Edge cases:** tag is annotated (`git cat-file -t` = `tag`, not `commit`), so it survives a later history rewrite discussion; run before any Phase 1 delete, never after.

### T1.1 — infra removed — **RETIRED 2026-10-22**
S1.1 was dropped: `k8s/`, `vms/` and `cd.k3s-deploy.yml` stay on `master`. The stripping
moves to the `release` branch, so there is nothing to assert here. Closing #239–241 moved
to **T1.5**.

**Carried forward for whoever strips `release`:** a strip of `vms/` must keep
`vms/smoke.sh`, `vms/smoke.ps1` and `vms/docker/run.sh` — `ci.install-matrix.yml`,
`ci.lite-smoke.yml` and `ci.docker-smoke.yml` execute them, and `tests/integration/vms/`
pins that contract in `smoke-contract.test.js`, `ci-workflows.test.js` and
`docker-executor.test.js` (16 of its 27 tests). Only the Vagrant/mac/win executor tests
(11) are local-only.

### T1.2 — bots parked, not removed — **PASS 2026-10-22**
Revised with S1.2: files are **moved to `.github/workflows/obsolete/`**, not deleted, and
**no label is deleted**. Assert inertness, not absence.
- **Assertions:**
  - `ls .github/workflows/*.yml` does not list the five parked names **✅ 23 active files**
  - each parked file's `on:` block is exactly `workflow_dispatch:` **✅ 5/5**
  - no **active** workflow or doc names a parked file:
    `grep -rnI "issue-claim-guard\|stale-claims\|update-leaderboard\|contributor-agreement\|issue-moderation" --exclude-dir={node_modules,coverage,var,trash} .`
    returns only `.github/workflows/obsolete/*`, `CHANGELOG.md` and the *Parked workflows*
    section of `id/reference/ci-cd.md` **✅**
  - `actionlint .github/workflows/*.yml` exits 0 bar the pre-existing shellcheck
    info/warnings in `bot.pin-shas-to-actions.yml`, `ci.pr-lint-feedback.yml`,
    `ci.sri-pins.yml` **✅**
  - `gh label list` still shows all six gamification labels **✅ deliberate**
- **Edge cases:**
  - Dependabot + SHA-pinning still work — `bot.pin-shas-to-actions.yml` stays active **✅**
  - `bot.nuke.yml` stays active, and `.github/scripts/nuke.cjs` +
    `.github/data/blocklist.json` are still read by `ci.pr-guard.yml` **✅ nothing orphaned**
  - `cd.release.yml` builds `launchers/` itself, so parking
    `obsolete/cd.aperio-lite-launchers.yml` changes no release behaviour **✅**
  - a parked file moved back to `.github/workflows/` still cannot fire on its own, because
    its triggers are gone **✅ by construction**

### T1.3 — Codacy + Sonar parked, CodeQL revived — **PASS 2026-10-22**
Revised with S1.3: the files are **parked, not deleted**, and the step also re-enables
CodeQL. Assert inertness plus badge honesty, not absence.
- **Assertions:**
  - `ls .github/workflows/*.yml` lists neither `ci.codacy.yml` nor `ci.sonarqube.yml`
    **✅ 21 active files**
  - each parked file's `on:` block is exactly `workflow_dispatch:` **✅ 2/2**
  - no `codacy`/`sonar` in README, `SECURITY.md`, `FEATURES.md` or any active workflow:
    `grep -rni "codacy\|sonar" --exclude-dir={node_modules,coverage,var,trash,.git} .`
    returns only `.github/workflows/obsolete/*`, `CHANGELOG.md`, the parked section of
    `id/reference/ci-cd.md`, and `jsonArgs` in `tests/e2e/helpers/test-agent.js:174`
    **✅**
  - `gh api repos/BaiGanio/aperio/actions/workflows` reports `ci.codeql.yml` as `active`
    **✅ was `disabled_manually` since 2026-07-05**
  - `master-rules` still requires exactly `GitGuardian Security Checks` **✅ `code_quality`
    is not and was not in the ruleset — the plan's claim was stale**
  - `actionlint .github/workflows/*.yml` exits 0 bar the pre-existing shellcheck
    info/warnings **✅**
- **Edge cases:**
  - Codecov upload still runs and its badge updates **✅ `ci.codecov.yml` is `active`, last
    run 2026-10-22 `push` success**
  - `ci.sonarqube.yml` chained off `(ci) Codecov Run tests and upload coverage` via
    `workflow_run`; parking it changes no Codecov behaviour, because the dependency pointed
    the other way **✅**
  - there were **no separate config files** — both tools were configured inside their own
    YAML, so nothing was left orphaned **✅**
  - `ci.codeql.yml` has no `push` trigger, so its badge refreshes on a PR to `master`, the
    Sunday 08:17 UTC schedule, or `gh workflow run ci.codeql.yml` — **not** on a direct
    commit to `master`. Worth one dispatch to make the badge true immediately.
- **Report-only:** `CODACY_PROJECT_TOKEN`, `SONAR_TOKEN`, `SONAR_HOST_URL` are dead
  repository secrets.

### T1.4 — spawn kept and parked
- **Assertions:** `lib/agent/spawn.js` still tracked (`git ls-files lib/agent/spawn.js` non-empty); #319 and #320 each carry a comment pointing at #498; F-R3-04 still listed in `id/reference/tech-debt.md`.
- **Edge cases:** if #498 is later decided against planning UX, re-open this step as its own change with its own test — do not fold the deletion into another Phase 1 push.

### T1.5 — tracker reflects reality — **PASS 2026-10-22**
- **Assertions:** #239, #240, #241 (moved here from the retired T1.1) **✅ closed 2026-10-22**;
  #335, #202, #105, #455 **✅ closed as *not planned*** (`gh issue view <n> --json state,stateReason`
  → `CLOSED NOT_PLANNED` on all four); every remaining open issue **✅** is named in the plan
  (nine of them) or carries a parked/in-scope comment (thirteen); `muted` **✅** no longer on any
  open issue (`gh issue list --label muted --state open` → empty) while the label itself survives.
- **Final count:** 22 open, down from 26.
- **Gotcha:** GitHub's label search index lags the write by minutes — a `--label muted` listing
  run straight after the edits still showed #569. Re-read the issue's own labels
  (`gh issue view 569 --json labels`) before believing a stale listing.

### T2.1 — server stays responsive while indexing
- **Setup:** isolated scratch workdir + non-default port; index a large repo (e.g. this one with `node_modules` excluded).
- **Baseline:** record `/api/version` p95 latency during indexing **before** the change.
- **Assertions:** after the change, p95 < 200 ms during indexing; indexing result (symbol count) unchanged.
- **Edge cases:** a pathological file (huge single-line JS) does not stall the server; teardown leaves no state in the repo tree.

### T2.2 — watcher handles every supported language
- **Setup:** temp root with `.js`, `.cs`, `.py`, `.go` files; watcher running.
- **Assertions:** add/change/unlink on each file updates `code_symbols` within the debounce window.
- **Edge cases:** unsupported extension stays ignored; one shared predicate is used by both watcher and indexer.

### T2.3 — settings overlay timeout
- **Assertions:** a mocked never-settling `/api/config/schema` shows the busy message after the timeout; a normal response still renders the panel.
- **Edge cases:** closing the panel mid-load aborts the fetch.

### T2.4 — docgraph bridge races (#532)
- **Assertions:** concurrent delete + reindex and sweep + reindex leave no orphan bridge memories, on SQLite **and** Postgres.

### T2.5 — redact round trip (#531)
- **Assertions:** with `APERIO_CLOUD_SENSITIVE_MODE=redact`, a reply echoing a placeholder is shown with the original value; placeholders never reach the user; the map is not logged or persisted beyond the turn.
- **Edge cases:** placeholder that the model mangled is left as-is, not mis-restored.

### T2.6 — terminal interactive loop
- **Assertions:** `runStandalone` with injected IO handles `/attach`, `/help`, `/restart`; parity list from #539 covered.

### T3.1 — slop review complete
- **Assertions:** a checklist of the 284 touched files (from `git log -i --grep=slop --name-only`) has each file marked reviewed / deleted; findings logged to tech-debt.md or fixed.

### T3.2 — refactor safety
- **Assertions:** `npm test` + `npm run test:harness` green; public exports unchanged; SQLite and Postgres store tests both green.

### T4.1 — launch map
- **Assertions:** new map issue lists each #455 decision as kept/changed, has a date, and local models lead.

## Test execution order

1. T0.1 → T0.2 → T0.3 → T0.4 (release only after CI is green).
2. Phase 1 groups are independent of each other; all need T0.4 done.
3. Phase 2 groups are independent; T2.1 needs its baseline recorded first.
4. T3.x after Phase 2. T4.1 last.

## Required setup

- `gh` CLI authenticated with repo admin (rulesets, releases, labels).
- Node ≥ 24, `npm ci`.
- For T2.1 / T2.2: scratch workdir under the scratchpad, `SQLITE_PATH` set **before** any import, non-default `PORT`, full teardown.
- For T2.4: Postgres via docker compose with an isolated project name (no hardcoded volume names).
