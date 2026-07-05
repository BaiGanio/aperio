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
| 2 | Uninstall | 🟡 **Half done** | `uninstall.sh` implemented (stops server, removes vendor/ + node_modules/ + var/ + Desktop launcher, offers model removal, spares Node & system Ollama). ❌ Missing: Windows equivalent (`uninstall.bat`/`.ps1`), UI "Uninstall/Reset" action. |
| 3 | `APERIO_LITE` profile flag | ❌ **Not started** | No `APERIO_LITE` in `lib/config.js` or anywhere. |
| 4 | Browser setup wizard | ✅ **Done** | `public/setup.html` (825 lines) drives bootstrap.js over `/api/bootstrap/stream`; wizard handles Ollama, model pull, DB, provider choice. Launchers reduced to ensure-Node + npm install + start (exactly the D2 design). |
| 5 | Lite UI / terminal stripping | ❌ **Not started** | Depends on Phase 3. Hide-list still undecided (see D2). |
| 6 | Packaging & release | ❌ **Not started** | No `install.sh` at repo root, no `release` branch (only `aperio-lite-db-split`, `aperio-lite-initial-split`). |

### #157 parts

| Part | What | Status |
|---|---|---|
| A | `curl \| bash` one-liner + `release` branch | ❌ Not started (folds into Phase 6) |
| B | Self-knowledge in system prompt | ✅ **Done** — `id/capabilities.md` + `id/self-nature.md` wired into the `FILES` array (`lib/agent/index.js:164`) |
| C | `file://` guard on setup.html | ❌ Not done (no `location.protocol` check found) |

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

### WS3 — Lite profile flag + UI stripping (Phases 3+5) — the big chunk
- [ ] `APERIO_LITE` in `lib/config.js` (env + Settings). When on: ollama/sqlite/
      transformers defaults, **codegraph off**, docgraph on, lite seed variant,
      cloud providers & external DBs behind an **Advanced** toggle.
- [ ] UI hide-list (proposal, confirm per surface — D2): hide codegraph panels,
      MCP config, raw config panel deep-knobs, skills authoring, exam harness,
      roundtable config, sampling tuning. Keep: chat, memory sidebar, docgraph,
      wiki, basic settings, provider/key entry, Quit.
- [ ] `start:lite` (and the PowerShell launchers) set `APERIO_LITE=1`.
- **Runtime flag, not build-time** — see D1. No component-switching build logic.

### WS4 — Install/uninstall completion
- [ ] **Windows uninstall** — `uninstall.bat` → `assets/uninstall.ps1`, mirroring
      uninstall.sh (stop server, remove vendor/node_modules/var, Desktop .vbs
      launcher, offer model removal). help.html currently tells Windows users
      "delete the folder; one-click uninstaller on its way" — update it when this
      lands.
- [ ] **BUG found 2026-07-05:** `uninstall.sh` removes `var/` but NOT
      `.sqlite/` — the memory database survives until the user trashes the
      folder. Either add `.sqlite/` to step 6 or document it; help.html's
      "drag the folder to the Trash" keeps the net result correct meanwhile.
- [ ] **`file://` guard** in setup.html + i18n key (#157 Part C, ~10 lines).
- [ ] Light provenance touch-up: record `nodePreexisting: true|false` in
      `bootstrap.lock` so uninstall messaging is accurate (full ledger skipped — D3).
- [ ] Refresh `.github/lite/how-to-install.*` + `install.txt` to match the
      shipped path (vendored Ollama, sqlite-vec, transformers, wizard); delete or
      regenerate the stale docx/pdf; retire `Aperio.bat` if START.bat supersedes it.

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
- **D2 — UI hide-list.** Proposal in WS3 above; confirm surface-by-surface before
  Phase 5 lands.
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
