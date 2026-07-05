# Aperio-lite — Progress Tracker

> **Target: July 14, 2026.** Main focus: non-coder / non-technical users on modest
> hardware. Tracks issues [#186](https://github.com/BaiGanio/aperio/issues/186)
> (install / uninstall / lite profile), [#157](https://github.com/BaiGanio/aperio/issues/157)
> (self-knowledge + installer), and the model-preload wishes in
> [#204](https://github.com/BaiGanio/aperio/issues/204).
>
> Audited against the codebase on 2026-07-05. Update this file as work lands.

---

## 1. Status snapshot

### #186 roadmap phases

| Phase | What | Status | Evidence |
|---|---|---|---|
| 0 | Consolidate launchers, retire `lib.sh` | ✅ **Done** (docs pending) | `.github/lite/` is now START.sh / START.bat / launch-hidden.sh + assets/{start,launch-hidden}.ps1; `lib.sh`, `Aperio.command`, `Aperio.sh`, `start1.sh` gone (commit 6285c4e, Jul 4). ⚠️ `how-to-install.md/.docx/.pdf`, `install.txt`, `Aperio.bat` still stale (Apr/Jun dates — LanceDB/mxbai era). |
| 1 | Install ledger | 🟡 **Largely obviated by design** | bootstrap.js now *vendors* Ollama into `./vendor/ollama` (pinned, checksum-verified) instead of installing system-wide — provenance is folder-contained. Remaining gap: Node/nvm provenance (deliberately never removed) and the Desktop launcher (uninstall.sh already handles it). Full JSON ledger likely unnecessary; see Open Decisions D3. |
| 2 | Uninstall | ✅ **Done (CLI, both OS)** | `uninstall.sh` + `uninstall.bat`→`assets/uninstall.ps1` (WS4, Jul 5): stop server, remove vendor/ + node_modules/ + var/ + `.sqlite/` + Desktop launcher, offer model removal, spare Node & system Ollama. Remaining nice-to-have: in-app UI "Uninstall/Reset" action (not required for July 14). |
| 3 | `APERIO_LITE` profile flag | ✅ **Done** | Registered in `lib/config.js` (WS2) + `liteDefault` behavior shipped (WS3, Jul 5). |
| 4 | Browser setup wizard | ✅ **Done** | `public/setup.html` (825 lines) drives bootstrap.js over `/api/bootstrap/stream`; wizard handles Ollama, model pull, DB, provider choice. Launchers reduced to ensure-Node + npm install + start (exactly the D2 design). |
| 5 | Lite UI / terminal stripping | ✅ **Done (web UI)** | `.lite-hide` gating + Advanced toggle shipped Jul 5 (see WS3). Terminal untouched — `help` already tiers by audience. |
| 6 | Packaging & release | ❌ **Not started** | No `install.sh` at repo root, no `release` branch (only `aperio-lite-db-split`, `aperio-lite-initial-split`). |

### #157 parts

| Part | What | Status |
|---|---|---|
| A | `curl \| bash` one-liner + `release` branch | ❌ Not started (folds into Phase 6) |
| B | Self-knowledge in system prompt | ✅ **Done** — `id/capabilities.md` + `id/self-nature.md` wired into the `FILES` array (`lib/agent/index.js:164`) |
| C | `file://` guard on setup.html | ✅ **Done** (WS4, Jul 5) — inline `location.protocol === "file:"` guard + `setup_file_guard_*` i18n keys |

### Shipped since the roadmap was written (not in any issue)

- **Self-memory system** ("the gift") — `self_memories` table (migration 005),
  `self_*` tool quad, `db/self-memory-seed.js` (6 lite-lifecycle troubleshooting
  entries), and **wake-up preload**: `lib/agent/index.js:438` preloads
  `self_recall limit:6` for local models so they "wake up already remembering".
  This is the exact mechanism Problem A below extends.
- Vendored-Ollama install path (macOS/Windows), idle auto-shutdown watchdog,
  Quit button, hidden-window Desktop launchers.

---

## 2. Remaining workstreams → July 14

### WS1 — Model self-awareness (Problem A) — ✅ DONE 2026-07-05
- [x] Three **identity entries** added to `SELF_MEMORY_SEED` (importance 5, tag
      `identity`): where I am / who Aperio is for; one-self-many-models (the
      store is shared and persists — write for your successors); how to orient
      at wake-up (capabilities.md maps the tools, exam trigger, tours). They
      lead the wake-up preload (importance DESC) ahead of the troubleshooting
      entries; idle-shutdown/quit/vendored-ollama drop out of the top-6 but stay
      searchable.
- [x] #204 folded in: qwen's orientation wish → identity entries; gemma's
      workflow-chain wish → covered as "write for your successors" guidance
      (learned self-memories, not seeds).
- [x] Verified by test (`tests/db/memory-seed.test.js`): identity entries are in
      the top-6 `recallSelf` preload. **Manual follow-up:** live turn-one check
      on qwen2.5:3b + token-breakdown sanity (needs a running server — not done
      from an agent session).
- Boundary kept: capabilities.md = subsystem map; self-memories = experiential.

### WS2 — Universal user memories (Problem B) — ✅ DONE 2026-07-05
- [x] **`db/memory-seed-lite.js`** — 8 non-coder entries: privacy/overview,
      memories explainer, documents headline (pdf/docx/xlsx/pptx/images/VLM),
      getting-started (pinned, links tours + /help.html), models-differ
      (the "learn AI" mission), what-the-installer-added + where data lives,
      start/stop, + the capability-exam entry reused from `MEMORY_SEED` by its
      `exam` tag (single source).
- [x] Gated in **both adapters** (`db/sqlite.js`, `db/postgres.js`):
      `APERIO_LITE=on` → lite set, else dev set. `APERIO_LITE` registered in
      `lib/config.js` (essentials, boolean) and `.env.example` regenerated
      (`gen:env:check` passes). `start:lite` + both PowerShell launchers now set
      `APERIO_LITE=on` — WS3's flag now exists; only its UI behavior remains.
- [x] **`public/help.html`** — self-contained, light/dark, non-coder language:
      what was installed & why, where data lives, start/stop, settings-after-
      install, documents examples, models/tours, uninstall, troubleshooting.
      Served by the existing static mount. Linked from the wizard finish screen
      (`setup_help_link` key in i18n.js + en.json; other 23 locales fall back to
      English).
- [x] Tests: `tests/db/memory-seed.test.js` (seed shapes, exam reuse, lite gate
      on a real store, preload order) — 7 tests; db/store/memory suites 248/248.
- **Follow-ups:** localize help.html + `setup_help_link` (23 locales); consider
      an `APERIO_DOCGRAPH` default for lite (help page says "enable the document
      index in Settings" — keep honest with whatever WS3 decides).

### WS3 — Lite profile flag + UI stripping (Phases 3+5) — ✅ DONE 2026-07-05
- [x] **Lite defaults, registry-driven**: `liteDefault` field in `lib/config.js`
      (`AI_PROVIDER=ollama`, `DB_BACKEND=sqlite`, `APERIO_DOCGRAPH=on`;
      codegraph has none → stays off; transformers already the builtin default).
      `applyLiteDefaults(tier)` applies them in two stages in server.js +
      terminal.js: tier-0 before the store opens (DB_BACKEND beats Docker
      auto-detect), tier-1 **after** `applyConfigToEnv` so .env / UI-saved
      values always win — a lite user turning docgraph off in Settings sticks.
- [x] **UI hide-list shipped** (`.lite-hide` class + `public/styles/lite.css`,
      driven by `data-lite` on `<html>`): sidebar Code / DB / Agents / Skills /
      System buttons, Discuss (roundtable) button, Settings → GitHub triage +
      Database connections sections. Config panel stays but renders
      **essentials only** (group `start`) in lite — that keeps provider/key
      entry per the keep-list; deep knobs + Imported section hidden.
      Kept: chat, memory sidebar, Chats, Docs, Wiki, Config(essentials),
      Settings, Quit. (MCP config / exam harness / sampling tuning from the
      old proposal have no web-UI surface — nothing to hide.)
- [x] **Advanced mode escape hatch**: lite-only Settings row toggling
      `data-lite-advanced` (persisted in localStorage) — reveals every hidden
      surface at runtime, no restart. Deviation from "cloud providers behind
      Advanced": provider/key entry stays visible in lite essentials because
      the keep-list demanded it; only deep knobs/external DBs are gated.
- [x] **Plumbing**: `public/scripts/lite.js` loads in `<head>`, stamps
      `data-lite` synchronously from a localStorage cache (no flash), then
      reconciles with `GET /api/config/client` (now returns `lite`).
      `start:lite` + both ps1 launchers already set `APERIO_LITE=on` (WS2).
- [x] **Lite always runs db precedence** (added on review): `resolvePrecedence`
      returns `db` whenever lite is on (env **or** DB-saved flag), overriding
      any `APERIO_CONFIG_PRECEDENCE` in .env — a lite user never edits .env;
      it only spins the app up, then the Settings UI rules. The no-op
      precedence knob is hidden in the lite-basic config panel.
- [x] Tests: `tests/lib/lite-defaults.test.js` (10 tests incl. forced-db
      precedence end-to-end); full suite green
      except one **pre-existing** failure (`api.test.js` expects
      /config/client heartbeat default 10, code ships 60 — predates WS3).
- Runtime flag per D1 ✓ — no build-time component switching.
- **Manual follow-up:** visual pass with `npm run start:lite` (lite chrome,
  Advanced toggle round-trip, config panel essentials-only).

### WS4 — Install/uninstall completion — ✅ DONE 2026-07-05
- [x] **Windows uninstall** — `uninstall.bat` → `assets/uninstall.ps1`, mirrors
      uninstall.sh step-for-step (stop server on 31337 via Get-NetTCPConnection,
      stop only *our* vendored ollama by path, remove node_modules/vendor,
      delete Desktop `Aperio.lnk` + `launch-hidden.vbs`, offer model removal,
      remove var/ + .sqlite/, leave Node). Parse-checked with pwsh. help.html +
      how-to docs updated ("double-click uninstall.bat").
- [x] **BUG fixed:** `uninstall.sh` now removes `.sqlite/` too (step 6), so the
      memory database goes with the rest. Mirrored in uninstall.ps1.
- [x] **`file://` guard** in setup.html: inline `location.protocol === "file:"`
      check replaces the page with a "start me via the launcher" message and
      halts the wizard. i18n keys `setup_file_guard_{title,body,url}` (en only;
      inline English fallback if i18n hasn't loaded).
- [x] **`nodePreexisting`** written to `bootstrap.lock` (`checkNode` returns the
      flag) and read by both uninstallers to word the "left behind" line
      honestly (installed-by-us vs. you-already-had-it). Full ledger still
      skipped per D3.
- [x] Docs refreshed to the shipped path (vendored Ollama, SQLite + transformers,
      browser wizard, START launchers, uninstallers): rewrote
      `.github/lite/how-to-install.md` + `install.txt`; **deleted** the stale
      `how-to-install.docx/.pdf` (Apr LanceDB/mxbai era — couldn't regenerate
      binaries faithfully; git keeps history) and **retired `Aperio.bat`**
      (START.bat supersedes it — sets lite env + hidden-window Desktop shortcut,
      which Aperio.bat did not). Fixed `cd.release.yml` to copy `.md`+`.txt`
      instead of the removed `.pdf`.
- **Follow-ups:** localize the 3 `setup_file_guard_*` keys (23 locales); the
      release zip still `-x ".github/*"` so it excludes the launchers — that's a
      WS5 packaging fix, not WS4.

### WS5 — CI/CD & release (Problem C + Phase 6 + #157 Part A)
- [ ] Create the **`release` branch** (per #157: name locked, manual push at first).
- [ ] **`install.sh`** at repo root: shallow-clone `release` → `~/aperio` →
      delegate to `.github/lite/START.sh`. Handle dir-exists (skip/update/abort).
- [ ] Extend `cd.release.yml`: push `release` branch on release cut; build an
      **`aperio-lite.zip`** artifact (repo snapshot + launchers + how-to) with
      SHA256 checksum.
- [ ] CI smoke test: matrix job (ubuntu/macos/windows) that runs the launcher
      path far enough to boot the server headless (skip model pull; assert
      `/api/health` responds). Keeps launchers from silently rotting.
- [ ] Round-trip verify on a clean VM per OS: install → use → uninstall → no traces.

- Dev note : how this release branch will help non code or code users? we have a download link fpr the zip, so what will change? explain me this - why we need this and what will happen when we have it? how it affects or compete or complain with the other installation methods?

---

## 3. Suggested order (9 days)

| Days | Work |
|---|---|
| Jul 5–6 | WS1 + WS2 seeds & instructions page (high value, low risk, independent) |
| Jul 7–9 | WS3 `APERIO_LITE` flag + UI hiding (biggest chunk, gates the lite seed) |
| Jul 10–11 | WS4 Windows uninstall, file:// guard, docs refresh |
| Jul 12–13 | WS5 release branch, install.sh, zip artifact, CI smoke |
| Jul 14 | Clean-VM round-trips (macOS/Win/Linux) + fixes |

---

## 4. Open decisions

- **D1 — Lite is runtime, not build-time.** #186 locked "lite = profile, no fork,
  no prune". The "switch components off while building" idea contradicts this;
  recommendation: keep one artifact, hide via `APERIO_LITE` at runtime. Only the
  *zip packaging* is a build step.
- **D2 — UI hide-list.** ✅ Resolved 2026-07-05 — shipped as listed in WS3.
  Judgment calls made without per-surface confirmation (all trivially
  reversible — one class per surface): DB browser / Agents / System hidden
  (not on the keep-list); provider/key entry kept visible via config-panel
  essentials instead of behind Advanced. Flag anything to re-show.
- **D3 — Full install ledger: skip.** Vendoring made the install folder-contained;
  a JSON ledger now only adds value for Node/nvm, which we deliberately never
  remove. Do the light `nodePreexisting` touch-up instead. Reopen only if we ever
  install system-wide components again.
- **D4 — Self-memories: shared or per-model?** `self_memories` has **no model
  column** — today every model wakes up with the same self-store. #204 shows
  models want different things. Options: (a) keep shared (one "self" per install —
  matches `id/self-nature.md` doctrine), (b) add a `model` column + filter.
  Leaning (a) for July 14; revisit after.
- **D5 — Base model set.** bootstrap.js defaults `qwen2.5:3b`; wizard model menu
  vs. the agreed 3-tier set (verify exact Ollama tags for the gemma tiers) —
  confirm what setup.html currently offers matches `docs/tours/` models.

---

## 5. Log

- **2026-07-05** — File created. Audit: Phases 0/4 done, uninstall.sh shipped
  (Unix only), capabilities.md + self-nature.md wired, self-memory seed + wake-up
  preload shipped. Open: APERIO_LITE flag, UI stripping, Windows uninstall,
  file:// guard, release branch + install.sh + CI, seed content for
  non-coders.
- **2026-07-05 (later)** — **WS1 + WS2 done.** Identity self-memories (3× imp-5),
  `db/memory-seed-lite.js` (8 entries) gated on new `APERIO_LITE` flag in both
  DB adapters, flag registered in config + set by start:lite and both ps1
  launchers, `public/help.html` + wizard finish-screen link (i18n key en only).
  New `tests/db/memory-seed.test.js` (7 tests); db/store/memory suites 248/248;
  `gen:env:check` green. Found: uninstall.sh misses `.sqlite/` (logged in WS4).
  Remaining manual: live qwen2.5:3b turn-one check; help.html localization.
- **2026-07-05 (later still)** — **WS3 done.** `liteDefault` registry field +
  two-stage `applyLiteDefaults()` (server.js, terminal.js), `lite` exposed via
  `/api/config/client`, `public/scripts/lite.js` + `styles/lite.css`
  (`data-lite` gating, localStorage-cached — no flash), hide-list applied
  (Code/DB/Agents/Skills/System/Discuss/GitHub-triage/DB-connections),
  config panel essentials-only in lite, Settings → Advanced mode toggle as
  escape hatch. help.html + lite seed docgraph wording updated ("on out of
  the box"). `tests/lib/lite-defaults.test.js` (6 tests); full suite green
  except pre-existing api.test.js heartbeat-default mismatch (expects 10,
  code ships 60 — predates WS3, left alone). D2 resolved.
  Remaining manual: visual pass via `npm run start:lite`.
- **2026-07-05 (review follow-up)** — **Lite forces db precedence.** Per review:
  a lite user can never "choose .env", so `resolvePrecedence` now returns `db`
  unconditionally when APERIO_LITE=on (checked in env and DB settings) — .env
  is spin-up only, the Settings UI rules afterwards. Precedence knob hidden in
  lite-basic config panel; help texts + .env.example regenerated; 4 new tests
  (incl. end-to-end: UI-saved value beats launcher env var).
- **2026-07-05 (terminal consistency)** — lite users may open the terminal too,
  so the profile now survives outside the launchers: **the wizard persists
  `APERIO_LITE=on` into the .env it creates** (envFile.js; .env is the one file
  every entry point loads → `chat:local` gets db precedence + SQLite pinned +
  lite defaults, same as the web UI). And **load-env.js no longer falls back to
  .env.example** — placeholder secrets (e.g. the default Postgres password)
  must never become live config; the terminal now follows server.js's
  only-a-real-.env rule. 2 new envFile tests; suites green with and without a
  .env present. (Correction to earlier audit note: the wizard DOES create .env
  on first run via lib/helpers/envFile.js — it was never .env-less; the file is
  create-once, spin-up-only.)
- **2026-07-05 (WS4 complete)** — Install/uninstall finished. Windows uninstaller
  (`uninstall.bat` → `assets/uninstall.ps1`) mirrors `uninstall.sh`
  step-for-step (pwsh parse-checked). `.sqlite/` bug fixed in both. `file://`
  guard in setup.html (#157 Part C) + `setup_file_guard_*` en keys.
  `nodePreexisting` recorded in `bootstrap.lock` (`checkNode` returns it) and
  used by both uninstallers for honest "left behind" wording. Docs rewritten
  to the shipped path: new `how-to-install.md` + `install.txt`; deleted stale
  `how-to-install.docx/.pdf` + retired `Aperio.bat` (superseded by START.bat);
  `cd.release.yml` now copies `.md`+`.txt`. help.html Windows uninstall line
  updated. #186 Phase 2 + #157 Part C now green. Syntax/JSON/shell/pwsh checks
  + lite & memory-seed suites pass. Next: WS5 (release branch, install.sh, zip,
  CI) — note the release zip currently excludes `.github/*`, so launchers must
  be added to the artifact there.
