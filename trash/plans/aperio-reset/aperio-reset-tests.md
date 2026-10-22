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
| S1.1 | T1.1 Repo grep: infra gone | no live refs |
| S1.2 | T1.2 Repo grep: bots gone | no live refs, docs updated |
| S1.3 | T1.3 Badges + checks | README links, ruleset unaffected |
| S1.4 | T1.4 Dead code gone | suite green, zero callers |
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

### T0.4 — release is real and usable
- **Setup:** S0.3 merged, release cut.
- **Assertions:** `gh release view v0.70.* --json assets` lists `aperio-lite.zip`; lite-smoke workflow green on that tag; `git rev-parse origin/release` == the tag's commit.
- **Edge cases:** zip size stays near the v0.68.0 size (not ~350 MB — #455 timed fault).

### T1.1 — infra removed
- **Assertions:** `git ls-files k8s vms .github/workflows/cd.k3s-deploy.yml` empty; `grep -rnI "k3s\|aperio\.live" --exclude-dir={node_modules,trash,coverage,var} .` returns only CHANGELOG history; #239–241 closed.
- **Edge cases:** docs site build (`cd.gh-pages`) still green.

### T1.2 — bots removed
- **Assertions:** none of the removed workflow names appear in `grep -rn` outside CHANGELOG; CONTRIBUTING.md has no "claim"/"XP"/"leaderboard"; labels removed (`gh label list`).
- **Edge cases:** Dependabot + SHA-pinning still work if `bot.pin-shas-to-actions.yml` is kept.

### T1.3 — Codacy + Sonar removed
- **Assertions:** no `codacy`/`sonar` in workflows, README, or config files; every README badge URL returns HTTP 200; next PR shows `GitGuardian` + `code_quality` checks.
- **Edge cases:** Codecov upload still runs and the badge updates.

### T1.4 — spawn dead code removed
- **Assertions:** `npm test` green; `grep -rn "spawnChild\|spawnParallel" lib mcp` = 0; `npm run test:harness` green.
- **Edge cases:** only if the developer confirms spawn is not on the roadmap.

### T1.5 — tracker reflects reality
- **Assertions:** #335, #202, #105, #455 closed; every remaining open issue is named in the plan or carries a `parked` note; `muted` label no longer on active items.

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
