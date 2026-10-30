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
| S2.2 | T2.2 Integration: watcher languages — **PASS** | per-language save → graph update |
| S2.3 | T2.3 Unit/UI: overlay timeout — **PASS** | busy message |
| S2.4 | T2.4 Integration: bridge races | delete/sweep/reindex interleavings |
| S2.5 | T2.5 Unit: redact round trip | restore or mode removed |
| S2.6 | T2.6 Integration: terminal loop + T2.6b protocol contract | commands via injected IO; every protocol member classified |
| S2.7 | T2.7 Core-chat parity — **PARKED** | staged discuss, /branch |
| S2.8a | T2.8 Ergonomics — **PARKED** with S2.7 | /attachments, /detach |
| S2.9 | T2.9 Config-contract gate — **PASS** | no unregistered reads, no blind spots |
| S2.10 | T2.10 Attachment bound | refuse before read, shared limit |
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

### T2.1 — server stays responsive while indexing — **PASS 2026-10-22**
- **Setup:** isolated scratch workdir + non-default port; index a large repo (e.g. this one with `node_modules` excluded).
- **Baseline:** record `/api/version` p95 latency during indexing **before** the change.
- **Assertions:** after the change, p95 < 200 ms during indexing; indexing result (symbol count) unchanged.
- **Edge cases:** a pathological file (huge single-line JS) does not stall the server; teardown leaves no state in the repo tree.
- **Method:** trivial HTTP server + the real indexer in one process; prober in a **separate**
  process, so a blocked loop is seen from outside. Each sample is classified by when it
  *started*, against a marker file the server writes immediately before `indexRepo` — without
  that, DB open + migrations + seeding get charged to indexing (a 306 ms artifact chased down
  and eliminated). Baseline re-measured from a pristine `git archive HEAD` tree so both sides
  used the identical method. Three corpora, two runs each.
- **Result:** p95 **8–11 ms** across all three corpora ✅, zero samples over 200 ms ✅, against
  a 200 ms target. Pathological file: worst slice **3012 → 138 ms** ✅. Index result identical ✅
  (code: 810 files / 53865 symbols / 175718 edges / 58223 resolved; docs: 189 / 2670 / 10125 —
  same figure on both sides of the change). Teardown clean ✅.
- **p95 was not sufficient on its own.** The code corpus passed at p95 *before* the change
  while the server froze for 3 s; the docgraph baseline blocked so hard the prober got 69 of
  ~250 samples, making its p95 meaningless. Worst-case is reported alongside p95 for this
  reason.
- **Committed regressions:** `tests/integration/codegraph/indexing-responsiveness.test.js`
  and `tests/integration/docgraph/indexing-responsiveness.test.js`. They watch event-loop
  heartbeat *coverage* (a timer that cannot fire records nothing, so a starved loop shows up
  as missing samples) plus a slow-slice count, and pin the index counts exactly. Both were
  verified to **fail** against a pristine `HEAD` checkout; the counts test passes on both
  sides. Unit cover: `tests/unit/helpers/timeSlice.test.js`,
  `tests/unit/helpers/extractorPool.test.js`, `tests/unit/codegraph/owner-index.test.js`
  (differential vs. the old scan, 300k+ probes), and real-worker equivalence in
  `tests/unit/{codegraph,docgraph}/extract-worker.test.js`.

### T2.2 — watcher handles every supported language — **PASS 2026-10-22**
- **Setup:** temp root with `.js`, `.cs`, `.py`, `.go` files; watcher running.
- **Assertions:** add/change/unlink on each file updates `code_symbols` within the debounce window.
- **Edge cases:** unsupported extension stays ignored; one shared predicate is used by both watcher and indexer.
- **Method:** a real `startWatcher` over a real `mkdtemp` tree with a real better-sqlite3
  database and the real tree-sitter extractors — only `isReadPathAllowed`, the embedding fn
  and the embedding queue are stubbed, so `indexRepo` / `indexFile` / `removeFile` /
  `sweepMissing` and chokidar itself are live. Each step waits on the watcher's own `change`
  event rather than a sleep, so the debounce is never raced. `indexRepo` gates on the
  app-wide allowed-folders list, not on the injected predicate, so the test sets it with
  `setAllowlist([root])` in `before()` and restores it in `after()`.
- **Result:** add / change / unlink all reach `cg_symbols` for `.js`, `.cs`, `.py` and `.go`
  ✅; `.txt` produces no event and no rows ✅; one shared predicate proved **by grep**, not by
  assertion — every `pickExtractor` call site in `lib/codegraph/` is `indexer.js:56`
  (definition), `indexer.js:102` (`walk`), `indexer.js:140` (`indexFile`), `watcher.js:95`
  (`isIndexable`), and there is no other extension test in the directory ✅. A unit test also
  pins `isIndexable(root, f) === (pickExtractor(f) !== null)` across every generic extension,
  so a future divergence fails for the diverging extension by name.
- **Both watch modes verified.** Native and the polling fallback are both green; set
  `APERIO_TEST_WATCH_POLLING=1` to force polling. A pass under native fs events only is not
  a pass, and the watch mode is printed and quoted in every failure message.
- **Verified red on a pristine `git archive HEAD` tree, with the two bugs separated.**
  Under a macOS temp root (`/private/var/...`) **5 of 6** failed — the absolute-path
  `SKIP_DIRS` split rejects every file, the `.js` one included. Re-run with `TMPDIR` on a
  path holding no skip-dir segment, **exactly** `.cs`, `.py` and `.go` failed while `.js`
  passed, which isolates the language gap with no help from the other bug. The new unit
  tests go red on `HEAD` too, but only as a missing-export `SyntaxError` — a weak red,
  recorded as such; the integration test is the one that carries the proof.
- **Committed regression:** `tests/integration/codegraph/watcher-languages.test.js` (6) plus
  42 unit tests in `tests/unit/codegraph/watcher.test.js`.
- **Suites:** `test:unit` 2984/2984, `test:harness` 33/33, `test:integration` 2750/2750.
  Teardown clean — nothing left in the repo tree.

### T2.3 — settings overlay timeout — **PASS 2026-10-22**
- **Assertions:** a mocked never-settling `/api/config/schema` shows the busy message after the timeout; a normal response still renders the panel.
- **Edge cases:** closing the panel mid-load aborts the fetch.
- **Method:** the existing `tests/integration/public/panel-visibility.test.js` harness, which
  already runs this exact file through a `vm.createContext` sandbox and already injects a fake
  `fetch`. **The harness had to be extended, not the fix weakened** — it stubbed `setTimeout`
  as a no-op (a timeout-based fix would never fire) and had no `AbortController` global (a
  correct fix would throw there while working in every browser). It now carries a real
  `AbortController` and a real `clearTimeout`, and a test can inject its own hand-driven clock
  through `extras`, which is spread last and wins. `FakeElement` gained `append`/`appendChild`/
  `prepend`/`querySelectorAll` and the fake `document` gained `createElement`, so the happy
  path exercises the real `render()` rather than bailing out of it.
- **Result:** the never-settling fetch keeps index.html's shipped `Loading…` placeholder up to
  the deadline, then is aborted and replaced by `stov_load_busy` ✅; a normal response renders
  the category nav with no busy/failed text and the deadline timer cleared ✅; a close click
  mid-load aborts the signal, hides the overlay, clears the timer and paints **no** error ✅.
  The 60 ms search-focus nudge that `toggleSettingsOverlay()` also arms is distinguished from
  the load deadline by delay, so the clock assertions pin the right timer.
- **Verified red on a pristine `git archive HEAD` tree:** the busy test and the close-aborts
  test both **fail** there (the first on "load() must pass an AbortSignal to fetch"), while the
  normal-response test passes on both sides — that one is the control that proves the happy
  path is unchanged. The fix was removed, the red was observed, the fix was put back.
- **Committed regression:** 3 tests in `tests/integration/public/panel-visibility.test.js`.
- **Locale gate:** `stov_load_busy` landed in all 26 `public/locales/*.json` **and** the bundled
  `TRANSLATIONS.en` block in `public/scripts/i18n.js`; `locale-drift-sync.test.js` 5/5 green.
- **Suites:** `test:unit` 2984/2984, `test:integration` 2753/2753 (2750 + 3 new),
  `test:harness` 33/33 (cheap sanity — this step touches no agent/tool/context/provider code).
  No live server was needed, so nothing was left in the repo tree.

### T2.4 — docgraph bridge races (#532)
- **Assertions:** concurrent delete + reindex and sweep + reindex leave no orphan bridge memories, on SQLite **and** Postgres.

### T2.5 — redact round trip (#531)
- **Assertions:** with `APERIO_CLOUD_SENSITIVE_MODE=redact`, a reply echoing a placeholder is shown with the original value; placeholders never reach the user; the map is not logged or persisted beyond the turn.
- **Edge cases:** placeholder that the model mangled is left as-is, not mis-restored.

### T2.6 — terminal interactive loop — **PASS 2026-10-24**
- **Setup:** `runStandalone(false, { stdin, stdout, root, createAgent, hydrateRuntime,
  processAttachments })` — a pipe for stdin, a fake agent, a `mkdtemp` root, and
  `APERIO_CLI_PREFS` set **before** the dynamic import. `runProxy(port, false, { stdin,
  stdout })` against a stub `ws` server on port 0.
- **Assertions:** `tests/integration/terminal/standalone-loop.test.js` (16) — boots on the
  injected agent, greets through the injected stream, writes nothing into the checkout;
  `/help` (and that `/pending` is discoverable from it), `/help pending`, `/pending`,
  `/attach`, an unknown command, a plain turn, `/restart`; then the P1 flow: a proposal shown
  with tool + target + token and **not** as `[event: …]`, `/pending` listing it, `/approve`
  calling the tool with `{ confirmation_token }` and nothing pending afterwards, `/reject`
  calling nothing, `/respond` refused with what *is* available, `/approve` on nothing refused.
  `tests/integration/terminal/proxy-decisions.test.js` (16) — the same flows over a real
  socket, asserting the frames that leave: `confirm_action` for a live approve, **no frame at
  all** for a live reject, `interrupt_decision` with `response` / `editedArguments` for the
  durable rows, a restored 2-row replay listed with each tool and target, `/approve` refusing
  to guess between two, `/edit` refused on a row that does not allow it and **not** reaching
  the server, and the `/discuss` capability gate in all four states (refused with the server's
  reason, no `roundtable` flag on the next chat, accepted once available, flag then present,
  auto-off when a `provider` frame withdraws it).
  `tests/unit/terminal/confirm.test.js` (82) — the pure rule set.
- **Edge cases found and fixed in the code:** a numeric interrupt-id prefix read as a huge
  list index; `/edit 42` reading `42` as the item and leaving an empty payload.
- **Traps worth remembering:** (1) lines cannot be written ahead — the loop re-arms
  `rl.once("line")` from `promptUser()`, so a line typed before the previous step finishes is
  emitted with no listener and silently lost; the proxy suite hung on this. (2) In proxy mode
  every step that leaves the client waiting must be closed with a `stream_end`, or the prompt
  never re-arms. (3) Waits must read a **window** of output, not the cumulative buffer — a
  string from an earlier test satisfies a later wait instantly and the test then races the
  loop. (4) A `process.stdout.write` stub **must forward**: node:test's reporter writes
  through it, and a capture-only stub silently hid 11 of 16 results. (5) `runProxy` needs its
  `{ close }` handle in teardown, or the 1.5s reconnect keeps the process alive forever.

### T2.6b — terminal protocol parity contract — **PASS 2026-10-24**
- **Setup:** `tests/helpers/protocolInventory.js` scrapes the protocol surface from source.
- **Assertions:** `tests/integration/terminal/protocol-parity.test.js` (16) — every one of
  the 60 outbound events and 18 inbound types carries a policy; `internal`/`web-only` carry a
  reason; every `handled` claim has a real `case` in `cliEmitter.js` and vice versa; every
  `sends` claim is really built by the proxy; the proxy sends nothing `wsHandler.js` lacks a
  case for; no policy entry names an event or message that no longer exists.
- **Red/green proof (run, not assumed):** deleting one policy entry fails and names the
  producer file (`session_branched (lib/emitters/handlers/ws/session.js)`); renaming a
  `cliEmitter` case fails with `claimed handled but no case in lib/emitters/cliEmitter.js`.
- **Edge cases:** the staleness assertion is what caught `delete_confirm_pending` — a case in
  `cliEmitter.js` that nothing had emitted for months. An event built by a factory and sent
  whole cannot be scraped; `INDIRECT_EVENT_PRODUCERS` declares those and a test asserts the
  named file still mints the type, so a rename fails instead of shrinking the surface.

### T2.7 — terminal core-chat parity (#539 Phase 2) — **PARKED 2026-10-30**
All five protocol types stay `web-only` with their existing written reasons; the S2.6 contract
test keeps the surface honest while this sleeps. Scope below kept for the unpark.
- **Assertions:** the staged discuss flow drives `discuss_start` → `discuss_summary` → a
  terminal accept/skip → `discuss_confirm`; `/branch` creates a child session or returns a
  tested limitation; `session_branched` renders. Each type moves from `web-only` to
  `handled`/`sends` in the parity policy tables — the contract test fails until it does.
- **Edge cases:** reuse the stub-`ws` harness from T2.6 rather than booting a real server.

### T2.8 — terminal ergonomics (#539 Phase 3) — **PARKED with S2.7**
- `/attachments` and `/detach <n|all>` through the T2.6 IO seam. The attachment-limit half of
  this entry moved to T2.10, because it tests a bug rather than an ergonomic.

### T2.9 — config-drift gate has no blind spots — **PASS 2026-10-30**
- **Assertions:** the real scan reports zero unregistered env reads; **every**
  `REVIEWED_EXCEPTIONS` entry is actually read somewhere in the scanned surface (the old test
  only asserted `length >= 10`, so a stale entry went silent); a `//` comment naming a glob
  path does not swallow the code after it; a `/*` or `//` inside a string literal survives;
  real comments of both kinds are still stripped.
- **Edge cases:** the glob-comment fixture must contain **both** the `//`-with-`/api/*` line
  **and** a later genuine `/* ... */`. Without the closing half the old regex fails to match
  at all and the fixture passes under the buggy stripper — proved red against it before
  keeping. `npm run gen:env:check` must stay clean, since no registry key was added.

### T2.10 — terminal attachment bound (from T2.8)
- **Assertions:** boundary-size tests at just-under / exactly-at / just-over the limit, plus a
  regression test that a rejected file is **never** read or base64-encoded — the current code
  allocates both representations and only `statSync`s afterwards.
- **Edge cases:** the limit must be the *same* constant the web upload path uses; a test should
  fail if the two drift apart. Drive the command surface through the T2.6 IO seam.

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
