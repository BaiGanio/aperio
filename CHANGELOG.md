# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## Unreleased

### Added

- DEFAULT_LOCALE config option (server-side fallback locale; default `en`).
- zh, ja server-side locale detection in SUPPORTED_LOCALES (was 24, now 26 — mirrors i18n.js LOCALE_META).
- Locale-drift sync test (`tests/locale-drift-sync.test.js`) that asserts server, client, and file-system locale lists are in lockstep.
- Phase D audit: no verbatim tool output is rendered unescaped in the public UI (safe by design).

### Fixed

- Resume card, memory inbox, and tag-filter UI now show real translated text instead of raw key names (`resume_card_messages`, `mem_inbox_title`, `mem_tag_filter`, etc.).
- All 26 locale JSONs now have full parity with the English baseline (371 keys each, `diff-locales.js` exits 0).

### Changed

- `scripts/check-docs-i18n.js` switcher check validates against `docs/lang-map.js` (world-map) instead of stale `data-lang` markup in `index.html`.

- Complete model-tier candidate catalog: 15 unique exact Hugging Face model
  entries expand to 38 eligible tier placements through their catalog `tiers`
  arrays, with
  quantization, size, role, tier eligibility, and verification metadata.
- Model-tier catalog validation now rejects repository/quant drift, duplicate
  tier assignments, unsupported roles, invalid sizes, and incomplete
  Hugging Face verification metadata; repository-only quantized models such as
  gpt-oss MXFP4 are supported explicitly.

- Model-tier campaign aggregation: a non-live `--aggregate` command now emits
  private `summary.json` and `summary.csv` artifacts, enforces comparable
  campaign controls, and separates invalid runs from genuine model failures.
- Model-tier finalist review: non-live `--finalists` creates a private full-exam
  manifest from valid campaign evidence, and `--decide --evidence <path>` applies
  the full-exam gates to generate private tier decisions without starting model
  processes.
- Model-tier finalist execution contract: the tracked full-exam manifest enumerates
  all 65 scored drills and 81 required observations, while finalist evidence is
  validated against the private tier-first artifact layout before tier decisions.
- Model-tier campaign execution: `--execute-campaign` now consumes private
  per-tier plans, runs all catalog placements sequentially through the existing
  pilot lifecycle, and records private per-tier execution ledgers; `--dry-run`
  validates the 38-placement scope without starting model processes.
- Model-tier retry restoration now waits for both HTTP routes and the
  WebSocket/app-ready handshake, preserves the retry phase in invalid-run
  diagnostics, and forces copied llama logs to private `600` permissions.

- Memory-aware llama.cpp VLM preset selection: native-vision main models omit
  the bridge, while oversized main/VLM pairs use router swap mode
  (`models-max = 1`) and report the decision at startup.
- Model download/load progress banner — llama.cpp weight pulls/loads inside a request now surface as a self-dismissing main-window banner (live GB, staged `downloading → loading → ready`, fades 5 s after ready) instead of a stale label crowding the header model chip; warm models stay silent
- Skill quick-access chips collapse to a single measured row with a `+N more` expander (wraps open, `− less` collapses), recomputed on resize
- Branch conversation redesign — labeled "Branch" button, a discoverable entry in the new `+` actions menu, and a friendly inline confirm card replacing the browser `confirm()`

- Terminal context pressure indicator: navbar now shows `ctx N%` when context usage exceeds warning threshold (#189)
- Ollama provider: cached tool schema serialization across tool-call loop iterations to avoid redundant `zodToJsonSchema` transforms (#189)

- First-class OpenAI Codex CLI provider with Aperio MCP tools, sandbox controls,
  persisted per-session resume, setup/configuration UI, background completions,
  round-table support, documentation, and provider-contract tests.

### Fixed

- Model-tier benchmark runner leaked detached llama-server engines. Its cleanup
  never ran when a run was interrupted (Ctrl+C/SIGTERM skips `finally`), and it
  only killed the last engine PID recorded in `state.json` — so interrupted and
  multi-restart runs orphaned multi-GB router+worker groups that accumulated
  across runs until the machine hit swap. The runner now installs
  SIGINT/SIGTERM/SIGHUP handlers that reap engines and the temp workdir on
  abort, and teardown sweeps every engine PID the run spawned plus whatever
  still holds the ephemeral llama port. `stopLlamaCpp` now reports the real kill
  result (keeping ownership on failure instead of masking a leak as a clean
  stop), and `ensureLlamaCpp` group-kills a stale still-recorded engine before
  overwriting `state.json` on restart.
- llama.cpp router loaded the main model twice, doubling resident RAM. Several
  paths sent the raw Hugging Face `repo:quant` as the `/v1/chat/completions`
  `model` field, which the router resolves to its auto-discovered cache preset
  (full model context) and loads as a SECOND resident instance alongside the
  tier-sized `aperio-main` preset: background completions — memory proposals and
  workflow suggestions (`lib/helpers/completion.js`), wiki refresh
  (`lib/handlers/wiki/regenerate.js`), and the model-tier benchmark's throughput
  probe. They now send the stable `aperio-main` alias, matching the interactive
  chat path; on the 16 GB tier this halved llama-server RSS (13.3 → 6.3 GB).
- Model-tier benchmark retry never recovered: its post-restart readiness check
  polled `/health`, a route the Aperio app does not serve (only llama-server
  does), so it 404'd for the full 180 s window and marked any run with a
  first-attempt case failure `invalid`. It now polls `/api/metrics`.
- llama.cpp no longer duplicates GGUF models into the repo. It previously forced
  `LLAMA_CACHE=./var/models`, so llama-server re-downloaded every model into the
  app folder even when the user already had it in the standard Hugging Face hub
  cache — a full duplicate hoard (tens of GB). The cache now defaults to that
  shared HF hub cache (`HF_HUB_CACHE`, else `$HF_HOME/hub`, else
  `~/.cache/huggingface/hub`) — the same location `llama-cli` and every other HF
  tool use — so existing models are reused and nothing is stored in-repo. Set
  `LLAMA_CACHE` to override.
- Tool-call failure observability (#223): error-log entries were attributed to the
  first `node_modules` stack frame (e.g. `readable-stream/_stream_transform.js`)
  instead of the real call site — the caller resolver now skips `node_modules` and
  points at app code. Weak-model tool-call failures (leak / corrupted native name /
  system-prompt echo) were only ever logged to the console at `warn` level and left
  no on-disk record; they are now appended to a persistent ledger at
  `var/toolrepair/failures.tsv` (`ts, model, kind, persisted, detail`), with
  `persisted=1` marking the cases a retry did not recover.
