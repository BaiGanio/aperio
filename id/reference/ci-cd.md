# CI/CD

GitHub Actions workflows in `.github/workflows/`:

## CI Workflows

- `ci.codeql.yml` — CodeQL analysis
- `ci.codecov.yml` — test coverage upload + unit, integration, and E2E dashboard
  data. `coverage-tests` and `e2e-dashboard` jobs run a `pgvector/pgvector:pg16`
  service container (`APERIO_E2E_POSTGRES_URL`) so the SQLite/Postgres store
  contract suite (`tests/integration/db/contract/`) exercises its Postgres
  backend on every run.
- `ci.agent-harness.yml` — deterministic assistant-behavior harness
  (`tests/harness/`, agent-harness-epic WS0). Path-filtered to
  `lib/agent/**`, `lib/tools/**`, `lib/context/**`, `lib/providers/**`,
  `tests/harness/**` — a fast (~5 min budget, sub-second actual run), no-model,
  no-network regression gate for the agent loop. The behavior-checks dashboard
  data itself is generated unconditionally inside `ci.codecov.yml`'s
  `coverage-tests` job instead (so the Pages site stays fresh even when this
  workflow doesn't fire).
- `ci.audit.yml` — the continuous-audit gates (`audit/tests`, T1–T9 of
  `aperio-continuous-audit-tests.md`). Deliberately **not** path-filtered,
  unlike `ci.agent-harness.yml`: the contract gates assert against the real
  current source (`config-contract` reads `lib/config.js`, `registry-contract`
  calls the real `mcp/tools/*.js` `register()` functions, `provider-contract`
  reads the provider loops), so a change anywhere in `lib/`, `mcp/`, or `db/`
  can turn them red — a filter on `audit/**` would miss exactly what they exist
  to catch. Pure, no model, no network, ~1 s. Kept out of `test:ci` so the audit
  gates stay out of the product coverage figure and the unit/integration
  dashboards.
- `ci.lite-smoke.yml` — lite install-path boot gate. On every push/PR touching the
  server boot path (`server.js`, `bootstrap.js`, `lib/**`, `db/**`, `mcp/**`) or
  the launchers under `.github/lite/**`, across Linux, macOS, and Windows:
  install deps, syntax-check the shell launchers, parse-check the PowerShell
  launchers, then boot `node server.js` headless and assert
  `/api/bootstrap/state` answers. No llama.cpp engine, model download, or
  bootstrap required — it catches launcher/zip/boot regressions that would
  otherwise ship green.
- `ci.install-matrix.yml` — the release-facing install flows end to end: the
  one-liner installer on `ubuntu-latest` and `macos-latest`, the packaged
  Windows zip launcher flow, and an opt-in `full_suite` job on ARM runners.
  Triggered by PRs touching `.github/lite/**`, `vms/**`, `server.js`, `db/**`,
  or the manifests; nightly at 03:17 UTC (scheduled runs are `dev`-only); or by
  dispatch. Both POSIX and Windows jobs drive the shared `vms/smoke` contract,
  so they stay in lockstep with the local VM executors below.
- `ci.docker-smoke.yml` — builds `docker/Dockerfile` and smokes the resulting
  local image; a second job smokes an explicit GHCR reference or digest supplied
  through the `ghcr_digest` dispatch input. PR-triggered on `docker/**`,
  `vms/docker/**`, `server.js`, `db/**`, `lib/**`, and the manifests.
- `ci.e2e-real.yml` — manual only (`workflow_dispatch`): runs
  `npm run test:e2e:real`, the real-app end-to-end suite, on `ubuntu-latest`.
- `ci.sri-pins.yml` — verifies the hand-pinned Subresource Integrity hashes in
  `public/*.html` (#466): fetches each `integrity=` asset from jsDelivr,
  recomputes the digest, and asserts one URL never carries two different hashes
  (the bootstrap-icons pin is duplicated across three pages). Path-filtered to
  `public/**.html` + `scripts/check-sri.js`, **plus a weekly cron** — a pinned
  version is supposed to be immutable, but the bytes sit on someone else's
  server and no PR would touch these paths to notice a change. The one job here
  that needs the network, which is why it is standalone: `npm run check:sri`
  exits 0 with an `UNVERIFIED` warning on a fetch failure (network error,
  timeout, 5xx) and exits 1 only on a real hash mismatch, a vanished pinned URL
  (4xx), or a cross-file conflict, so a jsDelivr outage cannot redden an
  unrelated PR. Dependency-free, so it skips `npm ci`.
- `ci.codacy.yml` — Codacy quality
- `ci.sonarqube.yml` — SonarQube
- `ci.npm-audit.yml` — dependency audit. Runs `scripts/npm-audit-gate.js`
  (`npm run audit:gate`) rather than `npm audit --audit-level=high` directly, so a
  high/critical advisory with no upstream fix can be accepted explicitly with a written
  reason and a `reviewBy` date instead of leaving the check permanently red. The
  acceptance expires: once that date passes, or once the advisory stops appearing in the
  audit at all, the gate fails and names the stale entry. It also refuses to read a
  report npm could not produce — an unreachable registry makes `npm audit --json` print
  `{"error": …}` and exit zero, which would otherwise look like a clean audit.
- `ci.pr-guard.yml` / `ci.pr-lint-feedback.yml` — PR validation

## Local installation executors

The release-facing install flows also have local ARM64 smoke coverage:

- `npm run vmtest:linux` provisions a disposable Ubuntu 24.04 ARM64 guest with
  Vagrant + Parallels and runs the one-liner installer.
- `npm run vmtest:linux:debian` provisions Debian 12 ARM64 and runs the
  development clone/install flow.
- `npm run vmtest:windows` resets a Windows 11 ARM Parallels VM to its `clean`
  snapshot and runs the real `START.bat` flow.

These are host-driven checks rather than GitHub-hosted jobs. Each executor
invokes the shared `vms/smoke` contract, collects logs under `vms/out/`, and
destroys or restores disposable guest state in an exit trap. Full prerequisites
and one-time VM setup are documented in [`vms/README.md`](../../vms/README.md).

## CD Workflows

- `cd.release.yml` — release automation (version bump, changelog, publish).
  **Gated on tests** (see below) — it does not run on `push`.
- `cd.gh-pages.yml` — docs site deployment
- `cd.k3s-deploy.yml` — cross-compiles the ARM64 image with QEMU on GitHub's
  AMD64 runners, pushes it to `ghcr.io`, then sends an HMAC-signed webhook to the
  Raspberry Pi k3s cluster so it pulls and rolls out. Fires on pushes to `master`
  touching the boot path, `public/**`, `docker/**`, or `k8s/**`, or by dispatch
  (with `branch` and `skip_build` inputs). Requires the `APERIO_PI_WEBHOOK_URL`
  and `APERIO_PI_WEBHOOK_SECRET` repository secrets; Pi-side setup is documented
  in the workflow header and `k8s/aperio-webhook.service`.

### The release gate

`cd.release.yml` used to trigger on `push: branches: [master, beta-m*]`, which
raced `ci.codecov.yml` rather than waiting for it: a push that broke the suite
still bumped `package.json`, tagged, and published the ZIP (#455, timed fault
\#3). It now uses the same `workflow_run` shape `cd.gh-pages.yml` already used:

```yaml
on:
  workflow_run:
    workflows: ["(ci) Codecov Run tests and upload coverage"]
    types: [completed]
  workflow_dispatch:
```

with the `version` job guarded by:

```yaml
if: >-
  github.event_name == 'workflow_dispatch' ||
  (github.event.workflow_run.event == 'push' &&
   github.event.workflow_run.head_branch == 'master' &&
   github.event.workflow_run.conclusion == 'success' &&
   !contains(github.event.workflow_run.head_commit.message, 'skip ci'))
```

Four things follow from that trigger change, and all four are load-bearing:

- **Checkout needs an explicit ref.** `workflow_run` checks out the default
  branch tip, not the commit that triggered the upstream run, so the job passes
  `ref: ${{ github.event.workflow_run.head_sha || github.ref }}`. Without it
  the *Analyze Commit* step (`git log -1 --pretty=%s`) reads the wrong message
  and picks the wrong bump — or no bump at all.
- **The branch name is not `github.ref_name`.** On a `workflow_run` event that
  built-in resolves to the default branch. The job resolves the real branch once
  into `env.RELEASE_BRANCH` (`workflow_run.head_branch || github.ref_name`) and
  uses it for the branch push and the `release`-branch sync.
- **Loop safety comes from GitHub's own `[skip ci]`.** The bump commit is
  `chore: release vX [skip ci]`, and GitHub does not start *any* workflow for a
  push whose head commit says that — so Codecov never runs, so there is no
  `workflow_run`, so the release cannot re-trigger itself. Verified against
  history: the v0.68.0 and v0.69.0 bump commits produced zero Codecov push runs.
  The `!contains(...)` clause in the `if:` is a redundant second check on the
  same fact, not the primary mechanism.
- **`workflow_dispatch` bypasses the gate**, deliberately, so a release can
  still be cut by hand if the gate ever misfires.

A `concurrency: { group: release }` block keeps two runs from bumping the
version at once.

**Why Codecov alone is the gate.** `ci.generated-artifacts.yml` and
`ci.sri-pins.yml` are *not* wired in, on purpose:

- Both are path-filtered, so on most commits they never run at all. A hard
  dependency on a workflow that legitimately did not run would deadlock every
  release. `workflow_run` also keys off a single upstream workflow, so a second
  gate would mean polling the Actions API for a sibling run's conclusion.
- Their substance is largely already inside `npm run test:ci`, which the Codecov
  run executes: `tests/integration/scripts/gen-env-example.test.js` (case C3)
  shells out to the real `gen-env-example.js --check`, and
  `tests/unit/security/sri-check.test.js` covers the SRI logic. The unique
  residue is the mascot-derivative check and the SRI *network* fetch — and the
  SRI workflow is fail-soft on network errors by design, which makes it a poor
  release gate regardless.

**Branches.** `beta-m*` was dropped from the trigger on 2026-08-24. Codecov only
ever ran on `master`, so a `beta-m*` push could not be gated at all; the branch
pattern had also never produced a release run in recorded history. The beta
version-numbering code inside the *Bump Version* step is left in place but is
now unreachable.

**Editing caveat.** `workflow_run` always uses the copy of the workflow file on
the **default branch**. Changes to `cd.release.yml` take effect only once merged
to `master` — they cannot be tested from a branch.

## Bot Workflows

- `bot.issue-claim-guard.yml` — handles `/claim` comments (and `Yes`
  confirmations) on issues, skipping anything labelled `status: cooldown`
- `bot.issue-moderation.yml` — labels, locks, and milestones newly opened issues,
  and reacts to label removal
- `bot.stale-claims.yml` — daily at midnight UTC, releases claims that went stale
- `bot.nuke.yml` — dispatch-only blocklist enforcement over users and/or orgs,
  dry-run by default
- `bot.pin-shas-to-actions.yml` — pins third-party action references to commit
  SHAs on any PR touching `.github/workflows/**`

## Community Workflows

- `community.contributor-agreement.yml` — watches issue comments for "I agree"
  and records the contributor agreement
- `community.update-leaderboard.yml` — awards XP when a PR is merged by a
  non-bot author; dispatchable with a `pr_number` to award retroactively

## Sync Workflows

- `sync.milestone-dates.yml` — mirrors milestone dates onto the date fields of
  every issue in project #18 on milestone create/edit and issue
  milestone/demilestone events
- `sync.update-dev-branch.yml` — after a successful `(cd) Release & Versioning`
  run on `master`, refreshes the `dev` branch's files

Retired workflows are parked in `.github/workflows/obsolete/`
(`cd.aperio-lite-launchers.yml`, `sync.leaderboard-to-wiki.yml`) — kept for
reference, not scheduled by GitHub.
