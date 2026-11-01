# Changelog

All notable changes to this project are documented here, following
[Keep a Changelog](https://keepachangelog.com/) and [SemVer](https://semver.org/).

> **This file starts fresh for Aperio v2.** The v1 changelog (v0.1.0 → v0.69.4, 1675 lines)
> is preserved in two places: `git show archive/v1-final:CHANGELOG.md`, and
> [`docs/changelog-v1.md`](docs/changelog-v1.md) for reading on the site.
>
> **Size rule:** when this file passes ~300 lines, the oldest released sections move to
> `docs/changelog-archive.md`. A changelog an agent has to read must stay cheap to read.

## Unreleased — v2

Aperio is being rebuilt as a small core that a 4–9B local model uses well.
Plan: `trash/plans/aperio-v2/aperio-v2.md`. First release will be **v1.0.0**.

### Added

- Tooling and CI for branch `v2` (step S1.3): a minimal `package.json` (Node ESM, `node --test`,
  c8), eslint with a working guard for each anti-pattern AP1–AP6, scripts for AP7 (file size) and
  AP9 (duplicate basenames), and two fresh workflows — `v2-ci.yml` (lint, guards, tests, npm audit)
  and `v2-codeql.yml`. Every trigger filters on branch `v2`. Each guard is proved by a planted
  violation in `tests/guards/`.

### Removed

- The v1 tree (1403 files). Every file stays readable at tag `archive/v1-final`.
  What returns, and when, is recorded per item in `trash/plans/aperio-v2/feature-ledger.md`.
- All 21 v1 GitHub Actions workflows. A minimal set (tests, lint, anti-pattern guards,
  CodeQL, npm audit) is written in step S1.3.
