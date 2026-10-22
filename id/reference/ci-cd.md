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
  `aperio-continuous-audit-tests.md`). **`workflow_dispatch` only since S0.1
  (2026-10-22)** — it no longer runs on a push or a pull request. The gates
  assert against the real current source (`config-contract` reads
  `lib/config.js`, `registry-contract` calls the real `mcp/tools/*.js`
  `register()` functions, `provider-contract` reads the provider loops), so a
  change anywhere in `lib/`, `mcp/` or `db/` can turn them red. That is what
  they exist to catch, which is why they were never path-filtered — but it also
  meant they had master red since 2026-10-16 (#569) and blocked everything
  behind them. Run them on demand with `npm run test:audit` locally or
  `gh workflow run ci.audit.yml`. Whether the program is kept or deleted is a
  later decision (see `trash/plans/aperio-reset/aperio-reset.md`). Pure, no
  model, no network, ~1 s. Kept out of `test:ci` so the audit gates stay out of
  the product coverage figure and the unit/integration dashboards.
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
  Windows zip launcher flow, and opt-in extended ARM verification. The full
  Node test suite runs on `ubuntu-24.04-arm` and `macos-latest`; Windows ARM
  runs the shared PowerShell installation smoke contract instead, because the
  full suite depends on native modules and POSIX filesystem semantics that are
  not supported on `windows-11-arm`.
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

- `cd.release.yml` — release automation in three jobs: `version` (analyze, bump,
  changelog, tag), `package-source` (build and publish the zip), and
  `sync-release-branch` (force-push the released commit onto `release`, the
  branch the one-liner installer clones). **Gated on tests** (see below) — it
  does not run on `push`. A `workflow_dispatch` with a `tag` input packages an
  **existing** tag instead of cutting a new one.
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
    inputs:
      tag:          # empty → cut a new release; set → package that existing tag
        required: false
        default: ""
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
  `ref: ${{ inputs.tag || github.event.workflow_run.head_sha || github.ref }}`.
  Without it the *Analyze commits* step reads the wrong history
  and picks the wrong bump — or no bump at all.
- **The branch name is not `github.ref_name`.** On a `workflow_run` event that
  built-in resolves to the default branch. The job resolves the real branch once
  into `env.RELEASE_BRANCH` (`workflow_run.head_branch || github.ref_name`) and
  uses it for the branch push. (The `release`-branch sync is a separate job now
  and does not read it.)
- **Loop safety comes from GitHub's own `[skip ci]`.** The bump commit is
  `chore: release vX [skip ci]`, and GitHub does not start *any* workflow for a
  push whose head commit says that — so Codecov never runs, so there is no
  `workflow_run`, so the release cannot re-trigger itself. Verified against
  history: the v0.68.0 and v0.69.0 bump commits produced zero Codecov push runs.
  The `!contains(...)` clause in the `if:` is a redundant second check on the
  same fact, not the primary mechanism. `scripts/release-bump.js` drops
  `[skip ci]` subjects a third time, so a release commit inside the analyzed
  range cannot drive the next bump either.
- **`workflow_dispatch` bypasses the gate**, deliberately, so a release can
  still be cut by hand if the gate ever misfires. With a `tag` input it does
  something different — see *Packaging an existing tag* below.

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
version-numbering code inside the *Bump Version* step was unreachable after
that and was removed in S0.3 (2026-10-22); `package-source` still labels a
release "(Beta)" when the version string contains `beta`, but nothing produces
such a version any more.

### How the version is chosen

The bump comes from **every commit since the last version tag**, not from the
head commit of the push:

```bash
LAST_TAG=$(git describe --tags --abbrev=0 --match 'v*' HEAD)
git log --no-merges --pretty=%s "$LAST_TAG..HEAD" | node scripts/release-bump.js
```

`scripts/release-bump.js` is the single source of that rule and has tests in
`tests/integration/scripts/release-bump.test.js`. It emits `bump`,
`with_launchers` and `headline` to `$GITHUB_OUTPUT`, and `--notes-file` writes a
markdown bullet per counted commit — which is what the CHANGELOG entry lists, so
a multi-commit release no longer loses everything the head commit did not
mention. Any `feat:` makes it `minor`, otherwise any `fix:` makes it `patch`,
otherwise `skip`; a scope of exactly `launchers` also sets `with_launchers`.

Three details are load-bearing:

- **`--match 'v*'` is not optional.** Without it `git describe` happily returns a
  non-version tag such as `archive/pre-reset-2026-10-22`, and the commit range
  comes out wrong.
- **This replaced a `git log -1`** that read only the head commit, so a push of
  `fix: x` followed by `chore: y` saw the `chore:` and skipped the release. That
  ate the 2026-10-17 release (runs `38983863213`, `38988918842`, `39801399213`,
  all `→ bump=skip`).
- **A published release's tag can never be moved.** Before writing anything the
  job fails if `gh release view v$NEW_V` succeeds or the tag already exists, and
  it tags without `-f`. The previous `git tag -f` + `git push --force` would have
  silently repointed a published release's source snapshot.

Majors are **not** automated: `release-bump.js` reads a `!` breaking marker
(`feat!:`) as its base type, so a breaking change ships as a minor unless you cut
the major by hand.

### Packaging an existing tag

`workflow_dispatch` with a `tag` input (e.g. `v0.69.1`) runs the `version` job in
`mode=package`: it resolves the version from the tag and **skips every writing
step** — no bump, no changelog, no commit, no tag, no branch push. Only
`package-source` and `sync-release-branch` do real work. This is how a tag that
exists without a release gets one:

```bash
gh workflow run cd.release.yml -f tag=v0.69.1
```

### The `release` branch sync

`sync-release-branch` runs **after** `package-source` and is marked
`continue-on-error: true`. That placement is the whole point: the sync used to be
the last step of the `version` job, and when it failed the `version` job failed,
so `package-source` (`needs: version`) was skipped — the tag existed with no
release and no zip. Runs `32414251219` (v0.69.0) and `32934315335` (v0.69.1) both
died exactly there with `! [rejected] HEAD -> release (non-fast-forward)`, and
that is why nothing shipped between v0.68.0 and v0.69.2.

It pushes with `--force`, and both halves of that are deliberate:

- `release` sat on the v0.68.0 commit, which has **no merge base at all** with
  master after the history rewrite, so an ordinary push to it is rejected
  forever.
- Forcing is safe because `.github/lite/install.sh` updates an existing install
  with `git reset --hard FETCH_HEAD`, never `git pull`.

The `master-rules` ruleset is **not** involved, although it looks like a suspect:
it targets `~DEFAULT_BRANCH` only, never `release`, and grants the admin role
`bypass_mode: always`. Both failing logs show the master push succeeding.

**Editing caveat.** `workflow_run` always uses the copy of the workflow file on
the **default branch**. Changes to `cd.release.yml` take effect only once merged
to `master` — they cannot be tested from a branch. A `workflow_dispatch` run,
including the `tag` path, uses the file at the ref you dispatch.

## Bot Workflows

- `bot.nuke.yml` — dispatch-only blocklist enforcement over users and/or orgs,
  dry-run by default. Reads `.github/scripts/nuke.cjs` and
  `.github/data/blocklist.json`, both shared with `ci.pr-guard.yml`.
- `bot.pin-shas-to-actions.yml` — pins third-party action references to commit
  SHAs on any PR touching `.github/workflows/**`

## Community Workflows

None active. The gamification program is retired — see *Parked workflows*.

## Sync Workflows

- `sync.milestone-dates.yml` — mirrors milestone dates onto the date fields of
  every issue in project #18 on milestone create/edit and issue
  milestone/demilestone events
- `sync.update-dev-branch.yml` — after a successful `(cd) Release & Versioning`
  run on `master`, refreshes the `dev` branch's files. It copies an explicit
  file allowlist into a fresh `git init` repo and force-pushes it as
  `HEAD:dev`, so `dev` shares no history with `master` and anything outside the
  allowlist (`bootstrap.js`, `scripts/`, `id/`, `.github/`, `docs/`) is absent
  from it. **Grepping for `refs/heads/dev` will not find this** — the push
  target is written `HEAD:dev`.

## Parked workflows

Retired workflows live in `.github/workflows/obsolete/`. GitHub Actions scans only
`.github/workflows/*.yml`, never a subdirectory, so nothing in there can run. They are kept
for reference, not deleted — the work behind them stays recoverable and reviewable.

- `cd.aperio-lite-launchers.yml` — superseded; `cd.release.yml` builds `launchers/` itself
- `sync.leaderboard-to-wiki.yml` — mirrored `.github/LEADERBOARD.md` to the wiki

**Parked 2026-10-22 (Aperio Reset S1.2) — the bot/gamification program.** Each of these
also had its `on:` block stripped down to `workflow_dispatch:` so it cannot fire even if
the file is moved back up by accident. The original triggers are recoverable from the tag
`archive/pre-reset-2026-10-22`.

- `bot.issue-claim-guard.yml` — handled `/claim` comments (and `Yes` confirmations) on
  issues, skipping anything labelled `status: cooldown`
- `bot.issue-moderation.yml` — labelled, locked and milestoned newly opened issues, and
  reacted to label removal
- `bot.stale-claims.yml` — ran daily at midnight UTC and released claims that went stale
- `community.contributor-agreement.yml` — watched issue comments for "I agree" and recorded
  the contributor agreement
- `community.update-leaderboard.yml` — awarded XP when a PR was merged by a non-bot author;
  was dispatchable with a `pr_number` to award retroactively

Their data files are kept too, now unread by any active workflow:
`.github/data/seniority-tiers.json` (claim-guard tiers) and `.github/LEADERBOARD.md` (the
standings the leaderboard job wrote). The XP, `robin-hood` and `status: claimed` labels are
**deliberately not deleted** — they are still attached to 65 closed issues, and deleting a
label strips it from that history irreversibly.
