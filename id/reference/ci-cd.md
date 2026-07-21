# CI/CD

GitHub Actions workflows in `.github/workflows/`:

## CI Workflows

- `ci.codeql.yml` — CodeQL analysis
- `ci.codecov.yml` — test coverage upload + integration & E2E dashboard data
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

## Bot Workflows

- Issue claims, moderation, stale claims, nuke, pin SHAs to actions
