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
- `ci.generated-artifacts.yml` — lockstep gate for every file generated from a
  source of truth rather than hand-written: `lib/config.js` → `.env.example` +
  `docs/config-reference.md` (`npm run gen:env:check`), and
  `id/agent-rules/aperio-memory.md` → `integrations/agent-rules/**`
  (`npm run gen:agent-rules:check`). Both generators byte-compare the committed
  artifact against a fresh build, so changing a source without regenerating
  fails here instead of drifting silently. Path-filtered to those sources and
  outputs; no database, model, or network, so it stays a sub-minute job. Note
  `gen:env:check` had no workflow at all before this one existed despite being
  described as a CI gate — it is enforced now.
- `ci.codacy.yml` — Codacy quality
- `ci.sonarqube.yml` — SonarQube
- `ci.npm-audit.yml` — dependency audit
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

- `cd.release.yml` — release automation (version bump, changelog, publish)
- `cd.gh-pages.yml` — docs site deployment
- `cd.k3s-deploy.yml` — cross-compiles the ARM64 image with QEMU on GitHub's
  AMD64 runners, pushes it to `ghcr.io`, then sends an HMAC-signed webhook to the
  Raspberry Pi k3s cluster so it pulls and rolls out. Fires on pushes to `master`
  touching the boot path, `public/**`, `docker/**`, or `k8s/**`, or by dispatch
  (with `branch` and `skip_build` inputs). Requires the `APERIO_PI_WEBHOOK_URL`
  and `APERIO_PI_WEBHOOK_SECRET` repository secrets; Pi-side setup is documented
  in the workflow header and `k8s/aperio-webhook.service`.

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
