# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## Unreleased

### Changed

- **CSV path separation**: plain CSV/TSV requests no longer activate the heavyweight
  `file-generate` profile or inject the XLSX skill. `classifyProfiles` in
  `lib/agent/tool-profiles.js` only loads `file-generate` for CSV/TSV when paired with
  explicit Excel/spreadsheet/workbook intent (e.g. "convert csv to xlsx"). Plain
  CSV requests now use `file-edit` (write_file) instead. The XLSX skill keywords and
  description no longer mention CSV/TSV, so `matchSkills` will not trigger it for
  plain CSV requests. (#300)
- **Tool-schema budget for all context sizes**: `capToolsForWindow` now applies the
  schema-token budget (20% of context window) at ALL context sizes, not just windows
  below `SMALL_WINDOW_TOKENS` (default 32k). Large windows no longer bypass schema
  capping — the recall floor and intent tools are preserved, then as many core tools
  fit within the budget. The tool-count cap (`SMALL_WINDOW_MAX_TOOLS`) remains
  small-window-only. (#300)
- **UI timing decomposition**: the answer stats badge now shows llama-server's
  prompt evaluation tok/s (`⚡P:`) and generation tok/s (`💨G:`) as a secondary
  line below the blended speed metric, when llama.cpp timings are available. (#300)

### Added

- `frontend-design` skill for polished, responsive, accessible interfaces and
  self-contained HTML artifacts. HTML page/file requests now load this guidance
  automatically.
- Generated-file previews now provide explicit Preview and Code tabs for HTML,
  plus Open in browser, Show in folder, and Copy actions. Folder reveal is
  limited to regular files inside Aperio's `var/scratch/` artifact workspace.
- Regression tests for CSV vs XLSX classification: 6 tests covering plain CSV
  creation, CSV+Excel intent, CSV analysis, and CSV read scenarios in
  `tests/lib/agent/tool-profiles.test.js`. (#300)
- Schema-budget test for large windows in `capToolsForWindow`: ensures 131k+
  contexts are capped by the token budget while preserving the recall floor. (#300)

- Extended `docs/evaluate/lie-catcher.html` from 5 to 11 tests across three new sections: gullibility (3 misleading-prompt tests) and memory recall (3 memory-set verification tests). Renamed to "Honesty &amp; Robustness" to reflect broader scope.
- Extended `docs/evaluate/doc-graph.html` from 5 to 10 tests with a new vision pipeline section (5 VLM extraction tests). Renamed to "Document Graph &amp; Vision".
- Cleaned up `trash/temp/`: removed superseded plan files and source materials whose content was ported to the evaluate pages.

- Conversational folder indexing through the main chat agent: explicit requests
  can queue an authorized repository, document folder, or both through the shared
  indexing service, with progress reported in the existing Code Graph and
  Document Graph panels. Repeated and in-flight requests are idempotent, and the
  tool never expands the configured Allowed Paths boundary.
- llama.cpp offline start: when every model in the router preset is already in
  the local cache, `llama-server` now starts with `--offline`, so loading a
  model never re-checks Hugging Face — an upstream re-upload of the same repo
  can no longer trigger a surprise multi-GB re-download mid-conversation. New
  `LLAMACPP_CHECK_UPDATES=on` opts back into per-load revalidation; models not
  yet cached are always downloaded regardless.
- Boot-time model preload (`lib/helpers/modelPreload.js`): the main llama.cpp
  model is downloaded/loaded right after `llama-server` starts — via the
  prompt-cache warm-up, so the system-prompt prefix is prefilled by the same
  request — instead of lazily on the user's first message. Download/load
  progress is published on an app-wide `model_status` bus; every WebSocket
  connection forwards it and replays the latest status on connect, so a
  browser opened mid-download shows a "downloading model" banner instead of a
  ready-looking chat.

- Re-enabled browser Content-Security-Policy headers with CSP-safe static and
  dynamically generated UI event wiring; added `APERIO_CSP=on|report|off` modes.

- `grep_files`, a path-guarded recursive literal search tool for code and text
  files. It returns line-numbered matches and skips secrets, symlinks,
  dependencies, build output, unsupported extensions, and files over 500 KB.
- Disposable ARM64 installation smoke executors: Vagrant + Parallels profiles
  for Ubuntu/Debian Linux and a Parallels snapshot runner for Windows 11 ARM;
  all invoke the shared `vms/smoke` contract and collect logs under `vms/out/`.
- `npm run vmtest:linux`, `npm run vmtest:linux:debian`, and
  `npm run vmtest:windows` contributor commands.
- Real-app E2E test harness: callable `createApp()` composition root in `lib/server.js`,
  thin production `server.js` entrypoint, child-process fixture, contract-faithful test agent.
  Six test groups covering architecture (6), HTTP middleware (9), SQLite persistence (6),
  WebSocket chat (8), security boundaries (12), and lifecycle/CI (9) — 50 real-app E2E tests.
- `npm run test:e2e:real` — focused script for real-app E2E tests only.
- Port-0 fix: listen URL now uses `httpServer.address().port` instead of the configured
  PORT variable, so OS-assigned ports work correctly.
- E2E test dashboard (`docs/e2e-dashboard.html`) with pass-rate metrics, suite-by-suite expandable results, per-test durations, error display, and test file listing — same visual style as the coverage dashboard.
- JSON test reporter (`tests/reporters/e2e-json.js`) and generator script (`scripts/generate-e2e-dashboard.js`) that runs `tests/e2e/` with structured output.
- `npm run e2e:dashboard` and `npm run test:e2e:dashboard` npm scripts.
- E2E dashboard generation step in `cd.gh-pages.yml` — `docs/e2e-data.js` is now regenerated and deployed to GitHub Pages on each push to `master`.
- DEFAULT_LOCALE config option (server-side fallback locale; default `en`).
- zh, ja server-side locale detection in SUPPORTED_LOCALES (was 24, now 26 — mirrors i18n.js LOCALE_META).
- Locale-drift sync test (`tests/locale-drift-sync.test.js`) that asserts server, client, and file-system locale lists are in lockstep.
- Phase D audit: no verbatim tool output is rendered unescaped in the public UI (safe by design).
- `npm run prompt-cache:bench` — parses llama-server's debug log (`sim_best`/
  `f_keep`/prompt-eval timing per request) to report KV-cache prefix reuse
  across a conversation (`scripts/prompt-cache-bench.js`,
  `lib/helpers/promptCacheLog.js`).

### Fixed

- `edit_file` confirmations no longer fail with "Target changed since confirmation
  was requested" when two edits to the same file are proposed in the same turn
  and confirmed back to back (#299). Each proposal used to snapshot a whole-file
  digest and a pre-computed replacement from the file's pre-turn content, so
  confirming the second edit after the first had already written would either
  bounce on a stale digest or silently discard the first edit's change.
  `edit_file` now revalidates and applies `old_string`/`new_string` against the
  file's live content at execution time instead, so sequential edits to the same
  file chain correctly. `write_file`/`append_file`/`delete_file` keep the
  whole-file digest check, since a full overwrite/delete has no narrower target
  to revalidate against.

### Changed

- **Confirm-on-write gate narrowed to tainted turns only** (#299 follow-up):
  `write_file` / `edit_file` / `append_file` now execute directly for any target
  already inside `APERIO_ALLOWED_PATHS_TO_WRITE`, instead of only inside the
  session's ephemeral `var/scratch/` workspace. A model editing many fields in
  one allowed file no longer needs a confirmation click per field. Confirmation
  is still required — for any path, scratch or not — when the current turn has
  read untrusted content (`__tainted`, set by the prompt-injection tool-hook),
  and `delete_file`/`db_execute`/GitHub mutations are unaffected and remain
  always confirmed. Writes outside the configured allowlist were, and remain,
  rejected outright — this only changes the auto-execute boundary *within* the
  already-allowed area.
- HTML artifact previews no longer open as an empty modal. The iframe and source
  pane had inherited a CSP utility class that kept both views hidden.
- Windows one-liner installer (`assets/start.ps1`) no longer aborts silently
  on benign `npm`/`winget` stderr output. `$ErrorActionPreference = "Stop"`
  made Windows PowerShell treat any stderr line from a native command —
  including routine `npm warn deprecated ...` warnings present in nearly
  every install — as a terminating error, killing the script before its own
  exit-code check ever ran. Real effect: double-clicking `START.bat` could
  close the window with dependencies never installed and no error message.
  Same trap fixed in `vms/smoke.ps1`'s migration step. Found via the
  `ci.install-matrix.yml` Windows job, which exercises the real
  zip-and-double-click install path.
- `ci.install-matrix.yml`: the Windows job's dependency-install wait polled
  for `node_modules/` existence, which npm creates almost instantly and
  populates over the following seconds — the shared smoke check could run
  against a half-installed tree. Now waits on `node_modules/.package-lock.json`
  (npm's own last write of an install) and prints the launcher's live
  console output on timeout for diagnosis. The POSIX jobs' post-uninstall
  assertion also expected the whole install directory to disappear, but
  `uninstall.sh`/`uninstall.ps1` deliberately leave the container folder in
  place (the user drags it to Trash) — the assertion now checks the pieces
  the uninstaller actually removes.
- `.env.example` generator now only activates the START HERE group; every
  entry outside it renders commented regardless of its registry `show` field.
  Previously the Postgres block (`POSTGRES_PASSWORD`/`DATABASE_URL`, known-default
  `aperio_secret`) and a few advanced tier-1 keys shipped uncommented, so
  `cp .env.example .env` could spin up a Docker Postgres with a public password
  while `assertNonDefaultDbUrl()` rejected that same URL and silently fell back
  to SQLite — and, combined with the template's `APERIO_CONFIG_PRECEDENCE=env`
  default, those active lines would have outranked anything saved in Settings.
- Prompt-cache tail relocation (WS-A): the model-context middleware pipeline
  now detects each request's hop position within a tool-calling turn
  (`isFirstHop`) and exposes a generic `tailAppend` mechanism that splices
  content into a *clone* of the request's newest message instead of the
  cached system prompt — laying the plumbing for moving per-turn skill
  injection out of the byte-stable prefix without touching any provider code.
- Removed the per-minute clock directive (`buildClockDirective()`,
  `APERIO_INJECT_CLOCK`, `APERIO_CLOCK_TZ`) entirely rather than relocating
  it: closing its cache-invalidation cost via relocation required a
  nontrivial cross-hop caching mechanism, which wasn't worth it for a one-line
  capability (date-awareness + a stale-training-data nudge) of uncertain
  value. Agents no longer receive a "current date & time" line in the system
  prompt.
- Prompt-cache tail relocation (WS-C): per-turn skill injection now attaches
  to the request's newest content (`tailAppend`) instead of the cached system
  prompt, re-splicing at the turn's originating message on every hop of a
  tool-calling turn (not just the first) so the request prefix stays
  byte-stable for llama.cpp's KV cache regardless of which skill matched.
  llama.cpp's small-context budget fallback (`exceed_context_size_error`) now
  rebuilds the request without the tail's skill block instead of rebuilding
  the system prompt; `deepseek.js` has no equivalent fallback today, so
  nothing there needed updating.

- E2E dashboard reporting now includes top-level tests as well as nested suite
  cases, so the published totals match the tests executed by Node's runner.

- llama.cpp performance profiles now resolve cache type, Flash Attention, and
  RAM sizing from one policy. The existing `fast-low-vram` q8_0 KV cache now
  scales both growing and fixed KV costs consistently, while `long-context`
  remains on f16 after b9938 Metal benchmarks showed material q8_0 throughput
  regressions on dense and MoE/native-vision models.
- Wiki refreshes using llama.cpp now report the requested model and currently
  served models when the configured refresh model is absent, with guidance to
  restart Aperio so the regenerated model preset takes effect.
- Windows lite launchers now apply the complete `start:lite` environment,
  including database-first configuration precedence.
- VM install verification now returns cleanly from automated one-liner installs,
  keeps Windows smoke stdout/stderr separate, preserves PowerShell arguments,
  and runs the scheduled ARM suite through Bash on every hosted OS.
- Prompt-cache hygiene: the session memory pointer is now computed once at
  session start instead of being rewritten on every `remember`/`forget`
  mid-session, and the LLM-generated greeting was replaced with a static,
  locale-aware line plus a background KV-cache warm-up request. Neither
  source rewrites the system prompt mid-session anymore, so llama.cpp's slot
  cache survives across turns instead of re-prefilling from scratch —
  reprocessed-token volume on stable turns drops well below a cold start in
  live testing. The clock directive and per-turn skill injection were left as
  unaddressed, unconditional cache-invalidation sources at the time — both
  are now closed (see the clock-directive removal and prompt-cache tail
  relocation entries above).
- llama.cpp model priming now uses an OS-assigned scratch port, retries once
  if the port is raced, and identifies the attempted port in failures.
- Removed the orphaned generated `scripts/en-output.json` artifact.

- Workflow suggestions now require two successful calls from an explicit set of
  meaningful action tools, excluding recall, file reads, searches, and failed
  calls. Preference-driven filesystem scopes now activate from the original
  user query or generated grep pattern and always resolve to one valid search
  path, including when the model supplied an existing path (#256).

- `update_github_issue` now leads its tool description with the commenting
  use-case so small models map "comment on the issue" onto it instead of
  replying that no such capability exists (#237 Symptom B). Regression test
  guards the description ordering.

- Weak-model text-form tool calls are now caught when they begin with a bare
  registered tool name, while the web UI holds suspicious leading content long
  enough for a server-side retract to remove it without flashing raw syntax.
  Tool-repair ledgers also recognize direct `node --test` runs, keeping fixture
  failures out of dogfood data (#237 Symptom A).

- Wiki writes now pass source-memory strings through MCP validation so the
  handler can omit malformed, expired, or unknown citations while preserving
  valid provenance. This prevents one mistyped memory UUID from invalidating an
  otherwise valid synthesized article.

- Real-app E2E fixtures now treat `PORT=0` as an OS-assigned bind request
  instead of probing or attempting to kill an imaginary port-zero occupant.
  Persistence fixtures inject the contract-faithful test agent across restarts,
  and early fixture exits include captured stdout/stderr diagnostics. Production
  local/cloud ports remain `31337` and `1701` respectively.

- Local llama.cpp tool chains now reserve request headroom using dynamic schema
  budgets and a serialized-request preflight, account for newly appended recall
  results before the next model round-trip, and steer oversized recall results
  toward narrower retrieval before full artifact expansion. Model-tier runs now
  classify completed context-limit responses as invalid infrastructure evidence
  instead of model-quality failures or behavioral retries.

- Model-tier timeout diagnostics are now persisted per invalid case: structured
  `timeoutKind` and `timeoutEvidence` fields distinguish explicit llama.cpp
  context-limit evidence from generic model-loop deadline expiry and survive
  retry failures for offline harness tracing.

- Resume card, memory inbox, and tag-filter UI now show real translated text instead of raw key names (`resume_card_messages`, `mem_inbox_title`, `mem_tag_filter`, etc.).
- All 26 locale JSONs now have full parity with the English baseline (371 keys each, `diff-locales.js` exits 0).

### Changed

- **Breaking (#252):** `APERIO_CONFIG_PRECEDENCE` now defaults to `db` — settings
  saved in the app's Settings UI win over `.env` lines. Developers who want the
  file to rule set `APERIO_CONFIG_PRECEDENCE=env` once (the one-line remedy); a
  new shadow warning (boot log + `GET /api/config/schema` warnings) names every
  `.env` line being beaten by a differing DB value. Tier-0 bootstrap/security
  vars remain env-only in both modes.
- **Breaking (#252):** `.env.example` slimmed from ~420 lines to the essentials
  (tier-0 bootstrap + a START-HERE provider block). Every other variable still
  works when hand-written into `.env`; the full annotated catalog moved to the
  generated `docs/config-reference.md`. `npm run gen:env` now emits both files
  and `gen:env:check` gates both in CI.
- An empty/unset `AI_PROVIDER` no longer silently falls back to `anthropic`:
  fresh installs default to local `llamacpp` (initial model picked by machine
  RAM tier), and a genuinely unconfigured provider now produces an explicit
  not-configured notice in the CLI and the web UI instead of a key-less cloud
  boot. The setup wizard writes provider choice/key/model to DB settings
  instead of `.env` (tier-0 values like PORT still go to `.env`).
- The right-side Config panel and the Settings drawer's config rows merged into
  one full-screen **Settings overlay** (categories, search, Simple↔Advanced
  toggle, provenance chips, secret masking, restart banner), driven by
  `GET /api/config/schema` with new registry `category`/`advanced` metadata.
  All overlay strings are localized in all 26 locales, and a locale key-parity
  test now guards `public/locales/` against drift. Paths, DB-connections, and
  GitHub-triage now live as category views inside the same overlay, reusing
  their existing path, encrypted connection, token, and webhook flows; the old
  drawer entry points were removed.

- Push and pull-request CI now runs unit/integration coverage alongside the
  non-real E2E dashboard suite, preserving fresh dashboard data without starting
  real-app child processes. Real-app E2E remains available as a concurrency-
  limited, manually dispatched workflow when production-process validation is needed.

- Model-tier evidence now records Gemma 4 E4B UD-Q4_K_XL as the preferred
  provisional candidate pending full qualification, finalist examination,
  real-tier hardware evidence, and human approval; no installer default was
  changed.

- Controlled model-tier audits now run tiers in descending `32 → 24 → 16 → 8`
  order and stop after genuine failures at both 32 GB and 24 GB, preserving the
  private artifacts for diagnosis before attempting smaller tiers; invalid
  harness/readiness evidence does not count toward the stop condition. High-tier
  audits prioritize the Gemma 4 26B-A4B and Gemma 4 E4B catalog placements. The
  existing five-minute deadline remains unchanged to tolerate foreground load.

- Contributor documentation now explains the model-tier pilot/campaign
  workflow, isolated per-case execution, private artifact layout, retry-aware
  result classification, and the evidence gates required before changing tier
  defaults.

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

- Model-tier pilot cases now allow a fixed 300-second whole-turn envelope so
  slow local multi-tool loops can complete and retain latency as ranking
  evidence instead of being invalidated before llama.cpp's own request timeout.
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
