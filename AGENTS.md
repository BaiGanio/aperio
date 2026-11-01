## Project: Aperio (v2)

**A small local assistant that remembers.**
One person maintains it. One 4–9B local model runs it. SQLite + llama.cpp.
Node.js ESM, MIT license. Repo: [BaiGanio/aperio](https://github.com/BaiGanio/aperio).

> *"All inquiry and all learning is but recollection."* — Plato, **Meno** 81d
>
> In the **Phaedrus**, Thamus warned that writing would breed forgetfulness — external
> marks that remind without remembering. Aperio is the counter-wager: weave recall into
> the act of thinking itself, and the written mark becomes living memory. Anamnesis,
> for machines. Every design decision here should answer to that idea.

## The one rule

**On a small model, code does the memory work. The model does the talking.**

Recall is woven into the turn by code, not a tool the model must remember to call.
A weak model will not call a recall tool reliably, and it treats five preloaded rows as
everything there is. So the code searches, budgets and frames; the model only answers.
**Every v2 choice answers to this rule.** When a change is locally clever but drifts from it,
say so before building it.

## Scope: v2 core only

Aperio v1 is archived at tag `archive/v1-final`. v2 is a deliberate restart.

- **The plan is `trash/plans/aperio-v2/aperio-v2.md`.** This copy of the repo (branch `v2`) holds
  the live plan. Read the step you are on before touching code.
- **A feature not marked `core` in `trash/plans/aperio-v2/feature-ledger.md` is not built. Ask.**
  The ledger has a row for every v1 feature, tool, UI panel and skill, with its status
  (`core` / `later` / `parked` / `never`) and where its v1 code and tests live at the tag.
- **Read `trash/plans/aperio-v2/lessons-ledger.md` before each step.** 54 lessons that cost v1
  real time. One minute of reading saves a day. Port-protocol rule 5 points there.
- **Nothing returns without a measured need.** A `later` feature comes back one at a time,
  after v1.0.0, through the return gate: a real need, plus an eval score that goes **up**.

## No spec, no code

Every Phase 2 and Phase 3 step runs this loop. It is not optional.

1. **Study v1** at the tag, read-only: `git show archive/v1-final:<path>`. Write down how v1 did
   it, the best parts, the bad parts, the matching lessons, which v1 tests exist — and, if it is
   measurable, **measure v1 now**. That number is the bar.
2. **Spec** — `trash/plans/aperio-v2/specs/<step>.md`, from `specs/_template.md`. What it does,
   inputs and outputs, errors, limits, non-goals, what it keeps or drops from v1 and why.
3. **The developer approves the spec.** Until then, no test and no code for that step.
4. **Tests** from the spec's acceptance list. **They must be red first.**
5. **Build** until green. If the build proves the spec wrong, fix the spec and get it approved
   again — then the code. The spec never lags behind the code.
6. **Update the ledgers**: the Feature Ledger's "Ported in" cell, plus any new lesson.

The study and the spec together are **1–2 pages**. A longer spec means the step is too big: split it.

## Port protocol — rules for writing v2 code

1. **Test first.** Look in the Test Reuse Map and the ledger's "v1 tests" column. If a v1 test
   fits, copy it from the tag and cut it to v2 scope, **keeping its edge cases** — v1 tests hold
   years of found bugs. Otherwise write a new one. Run it; it must be **red**. Never weaken a
   ported test to make it pass; change it only if v2 scope really differs, and say why in the commit.
2. **Pull, don't push.** Copy code only when v2 needs it. Never copy a folder.
3. **Read at the tag.** `git show archive/v1-final:<path>`. Copy only the lines you need.
4. **Record it.** Fill the ledger's "Ported in" cell with the commit.
5. **Bring the lesson.** Check the Lessons Ledger for that area before you write.
6. **Hard rules, enforced by CI** — the AP1–AP9 guards below.
7. **Small-model budgets** — see below.
8. **≤ ~500 lines per file**, unless a `// size-reason:` line at the top says why.
9. **One eval number per feature. No number, no merge.**

### Small-model budgets

- **≤ 6 tools per turn.** v2 core has exactly 5.
- **System prompt ≤ ~1.5k tokens.**
- **The tool-schema prefix stays byte-identical between turns.** Tools render first on the wire,
  so any change to the tool array throws away the whole cached prefix behind it — on llama.cpp a
  single added or removed tool measured **0%** KV reuse. Recall goes **after** the stable prefix,
  in the user turn, never into the system prompt.
- **One budget function** decides history, recall and tool-result sizes per turn. Test it at 100% full.
- Read the plan's **Appendix A1** (multi-turn eval invariants) and **Appendix A2** (the prefix
  problem) before changing the tool set or the eval.

### Anti-pattern guards AP1–AP9

From the v1 scan (`trash/audits/anti-patterns-2026-10-30.md`). Each one **fails CI**; none is a
rule people have to remember.

| # | v1 anti-pattern | v2 guard |
|---|---|---|
| AP1 | `process.env` read in ~232 places, bypassing config | Only `src/config/` reads env (plus a tier-0 allowlist) |
| AP2 | Provider-name `if`s spread across the code | Callers ask for a capability, never a name |
| AP3 | Raw `fs` in tools; check-then-use path gate (TOCTOU) | Tools use only `gatedRead` / `gatedWrite` |
| AP4 | Sync `fs` on the request path, blocking every socket | Sync `fs` only in boot code |
| AP5 | Empty `catch {}` / `.catch(() => {})` hiding errors | Logic paths log or rethrow; cleanup paths are marked `// cleanup` |
| AP6 | Module-level caches with no size limit | Every cache uses one shared `boundedMap(max)` |
| AP7 | God files (1100–1600 lines) that grow back after a split | ≤ ~500 lines, or a written `// size-reason:` |
| AP8 | WebSocket messages with no schema, checked ad hoc | One shared schema, validated once at the socket edge |
| AP9 | Two files with the same name (`server.js`, `lib/server.js`) | Unique, descriptive file names |

**Never silence a guard.** An `eslint-disable` must name the AP id and give a reason on the same
line. If a guard cannot be automated, it is not a guard — write it down as a risk instead.

## Co-pilot Contract

You are the co-pilot: the developer drives, you keep their back. When context is missing,
ask — questions are a feature, not a failure. And we steer by the idea, not only by the
instruments: when a change is locally clever but drifts from the one rule above, flag the drift
before flying it. Standing rules:

- **Assume other agents and concurrent sessions may be active in this same repository.**
  Work only on the task assigned to the current session. Do not inspect, modify, stage,
  commit, revert, delete, or otherwise disturb changes, files, processes, branches, or
  artifacts that are outside this task or may belong to another session. Preserve a dirty
  worktree and shared runtime state unless the current task explicitly requires touching it.
  **`master` is a live branch with other sessions on it. This branch is `v2`.** One worktree per
  active session; never `git stash pop` blindly.
- **Never commit another session's work.** Before any Git operation, keep the scope limited
  to this task; do not stage broad or unrelated changes, and do not create commits, push,
  rebase, or alter branches unless the developer explicitly asks this session to do so.
- **Don't spin up server processes for casual diagnosis — read the code first.** A live run
  leaves side-effect state (DB folders, logs, ports) and reading is usually faster. When
  end-to-end verification genuinely requires a live process, run it isolated: a throwaway
  workdir, a scratch DB, a non-default port — and tear it down afterwards. The hard rule is
  *no stray state left in the repo tree*, not *no processes ever*.
- **Never integrate new visuals unseen.** Standalone HTML preview → approval → integrate.
  A subtle tweak does not count; a change must be obviously visible.
- **Ask before touching the Fragile Zones** (below) or writing to docs.
- **Done means verified**: tests green AND the affected flow exercised, not just compiled.
- **The elenchus runs both ways.** When the code contradicts the developer's stated belief,
  say so plainly — a co-pilot who never disagrees is dead weight in the right-hand seat.

## Developer Notes: A2D & Code Depth

Two running, **developer-facing** note files keep leftovers from evaporating between sessions.
They are the developer's private working notes — not Aperio memory, not user-facing docs.

- **`A2D.md`** (repo root) — suggestions, recommendations, housekeeping.
- **`id/reference/tech-debt.md`** — code depth: what we hit, what is still hanging or unfixed.

Standing rules for both:
- **Announce lightly, don't ask.** One line — "logging that to A2D" — then write.
- **Entries are dated and grouped by area.** A suggestion becomes `open` only once the developer
  decides to act on it.
- **Delete on resolution.** The moment a suggestion becomes an issue, a plan, or is fixed, remove
  it. Never append a "Fixed YYYY-MM-DD" paragraph to a dead entry. A permanent limitation moves to
  the Intentional-deferrals table. These files never become graveyards.

## Fragile Zones

Load-bearing. Ask before changing.

| Zone | Why |
|---|---|
| `src/config/` | The only place that reads `process.env` (AP1). Config is read through a **function**, never a module-level const — a frozen const once hit the developer's real DB. |
| `src/files/paths.js` | Every file operation gates through it. A bug here is a security bug: traversal, reads outside allowed dirs, writes in the wrong place. Verify with `..`, symlinks, absolute paths, and a symlink swapped mid-call. |
| `src/tools/` ctx | The `ctx` object shape is shared by every tool. Adding, removing or renaming a field breaks tools silently. It is frozen by a contract test. |
| `src/context/` | Prompt and context assembly. Token-budget changes cascade into every conversation, and a prefix change costs the whole prompt cache. |
| `src/shared/ws-schema.js` | Client and server both import it (AP8). Both sides must agree. |
| migrations | A schema change is silent until it is catastrophic. One folder, one direction, tested. |

## Code Conventions

- **Config-driven** — every tunable through the config registry, never hardcoded.
- **Path operations** — always through `src/files/paths.js`, never raw `fs` (AP3).
- **UI** — no framework, no build step. One native Web Component per file; services never touch
  the DOM; components never talk to the socket, only through a service; state changes go only
  through the store. `// @ts-check` + JSDoc, checked by `tsc --noEmit` in CI.
- **`package.json` version** — never bump it by hand. The one exception is cutting v1.0.0 at the
  swap, which the release script cannot do; that needs the developer's explicit OK.

## Refactoring and Resource Stewardship

Every change should leave the affected code at least as understandable, bounded and
resource-efficient as it was before.

**Module size.** ~500 lines is a recommendation with teeth (AP7). When a change pushes a
hand-written file past it, split by responsibility, lifecycle or domain boundary — never merely to
satisfy a line count. Generated files, migrations and fixtures are exempt. Do not let a cleanup
silently expand a focused task: make safe local splits as part of the change, and propose larger
architectural work separately.

**While reading or changing code, actively look for:** unbounded arrays, maps, caches, queues,
logs or retained conversation data; sensitive or transient data kept, logged or cached beyond its
scope; listeners, timers, workers, streams, sockets, file handles or DB resources not released on
success, failure, cancellation **and** disconnect; repeated parsing, embedding or file reads; N+1
queries and missing pagination; concurrency without limits, missing backpressure, abandoned
promises, work that continues after its result is no longer needed; large objects or closures
retained past their useful life. Session state lives in **one** session object with a clear
lifecycle, freed on disconnect, with a test that proves it.

When you find a meaningful issue, report: the observed risk or measured bottleneck · the proposed
refactor · the expected effect on CPU, memory, I/O, latency, data exposure or maintainability ·
how it will be verified.

**Never claim a performance win from intuition.** Establish a baseline and verify with profiling,
benchmarks, resource measurements or a regression test. For a model, one run proves nothing: run
each case N times (start with 5), fixed seed where possible, and report mean **and** spread, plus
the **max** latency and event-loop lag — `p95` hides freezes.

## Contribution Conventions

### Branch naming
AI agent commits: `type: <description> signed by <exact-model-id>`. The signature must name the
precise model that did the work — for example `gpt-5.6-luna`, `deepseek-v4-pro`, `opus4.8` — never
a family label such as `GPT-5`. Humans: same prefix, no signature.
Types: `feature:`, `fix:`, `refactor:`, `chore:`.

### Commit messages
[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`.
Types: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
Small commits, each one green. Release notes are built from them.

After any repository change, include a ready-to-use commit message in the final handoff, even when
no commit was requested. Do not create the commit unless the developer explicitly asks.

### Changelog
`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/); entries go under
`## Unreleased — v2`. Versioning is [SemVer](https://semver.org/).

**Size rule.** This file is read by agents, so it must stay cheap to read. The v1 changelog reached
1675 lines ≈ **29k tokens**. When `CHANGELOG.md` passes **~300 lines**, move the oldest released
sections to `docs/changelog-archive.md` and leave a one-line pointer. The v1 history lives at
`git show archive/v1-final:CHANGELOG.md` and in `docs/changelog-v1.md`.

## Good practices

- **One step = one session = one handoff.** End each session with the ledgers updated and the next
  step named.
- **Delete before you add.** When a port brings code in, look for something to drop in the same change.
- **Ask when unsure.** A question costs less than a wrong week.
