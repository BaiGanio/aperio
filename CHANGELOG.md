# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## Unreleased

- **Live Postgres in CI** (issue #310): `ci.codecov.yml`'s `coverage-tests` and
  `e2e-dashboard` jobs now provision a `pgvector/pgvector:pg16` service
  container and set `APERIO_E2E_POSTGRES_URL`, so the SQLite/Postgres store
  contract suite (`tests/integration/db/contract/`, issue #307 Phase 3) runs
  its Postgres backend automatically on every push instead of only when a
  developer opts in locally. `real-app-lifecycle.test.js`'s T64 check now
  exercises the real URL-shape assertion instead of always skipping.
- **Memory-compaction WS0 baseline** (issue #286): `npm run memory:baseline` measures real token cost for the self-memory preload and formatted `recall` payloads, and scores recall hit-rate@k separately for semantic and full-text search, against a throwaway seeded SQLite DB — the measurement gate every future compaction rule must clear before shipping. Found and corrected several stale assumptions along the way: there is no wiki-preload path today (only on-demand `wiki_get`), and a fresh in-memory DB is not actually empty (`SqliteStore.init()` seeds baseline demo content unconditionally). Plan and companion tests: `trash/plans/memory-compaction/`.
- Reorganized benchmark inputs under `docs/benchmarks/tools/`, grouped test dashboards under `docs/benchmarks/`, and added a private-safe metrics export for the model-tier viewer.
- Renamed the model-tier viewer integration test to `benchmarking.test.js` and made qualification-case cards collapsed by default.
- Extracted the WebSocket chat/init turn-interruption mutex out of `lib/emitters/handlers/wsHandler.js` into `lib/emitters/handlers/ws/turnLock.js` (`createTurnLock()`), isolating the concurrency-safety logic from `handleChat`'s business logic (issue #307 Phase 5b). No behavior change; added characterization coverage for a previously-untested socket-close-during-active-turn scenario and a deeper interruption race.

### Fixed

- **Docgraph amount-label extraction, language-agnostic signals** (issue
  #312): `lib/docgraph/extract-facts.js`'s `AMOUNT_LABELS` keyword matching
  only recognized English (plus BG/DE/FR patches from the household
  eval corpus), so every other language's amount evidence came back
  `label: null` and small models grabbed an early line-item figure instead
  of the real total. Added two structural signals that need no per-locale
  translation: an unlabeled amount on the line immediately after a
  tax/VAT percentage figure (`"%"` needs no translation) is now tagged
  `likely_total`, and the whole-document `likely_total` fallback no longer
  disables itself when only a `subtotal`-shaped label matched — a document
  whose breakdown we recognized but whose actual total keyword we don't
  still gets a total guess instead of silence. `doc_batch`'s tool
  description updated to match.
- **Docgraph split-field amounts and utility-query over-filtering** (issue
  #313): `extractAmountCandidates()` returned `[]` for bilingual bank-transfer
  forms where the amount and currency are declared on separate labeled lines
  ("Сума (Amount): 29,99" / "Валута (Currency): BGN") rather than adjacent —
  added a narrowly-anchored `"(Amount)"`/`"(Currency)"` gloss pair (scoped to
  avoid matching unrelated "amount"/"currency" text elsewhere in a document)
  that links the two. Separately, `buildCandidateManifest()`'s "utilities"
  scoring bonus had hardened into a hard `score >= 5` floor that eliminated
  *every* candidate below it from the pool whenever the query said
  "utilities"/"utility" — not just as a tie-break. A query naming several
  categories in one breath (the household eval corpus's actual gate prompt:
  "Break it down by category: utilities, fuel, groceries, transport, and
  internet") silently dropped every document whose title/filename didn't
  happen to carry a utility keyword — including a fuel receipt and the
  corpus's internet-bill payment form — even though the candidate pool was
  nowhere near the 48-candidate bound and nothing needed truncating. The
  bonus now only affects ranking, never elimination, matching the existing
  period-filter's "never hard-exclude when nothing needs truncating"
  contract.
- **Docgraph retrieval evidence contract** (issue #311): `doc_manifest`'s
  `date_hint` blended filesystem `mtime` with filename/title text into one
  field, letting indexing-time noise masquerade as a document date and wrongly
  exclude eligible documents from period-filtered manifests. Replaced with
  `file_mtime` (raw, always labeled as filesystem time) and
  `filename_date_hint` (derived only from the filename/title, never mtime);
  period filtering no longer uses mtime at all. Content-duplicate merges now
  record the dropped copies under `duplicates` instead of silently discarding
  them. `doc_batch` now extracts role-labeled `dates` (invoice/document/
  statement/receipt/payment/due/service-period) and currency-tagged `amounts`
  from each read document's real text via a new `lib/docgraph/extract-facts.js`
  module, so missing/ambiguous fields are explicit empty arrays or `null`
  rather than requiring the model to parse an undifferentiated blob or
  silently reading a gap as zero.
- **Bounded dataset-run, folder-authorization, and metrics retention**: dataset
  experiments no longer keep a second copy of every result row in memory once
  the artifact is persisted — finished runs collapse to a small status/summary
  record, expire after a grace period, and the registry is capped, while active
  runs stay queryable and cancellable. Historical results are read back from the
  persisted artifact, which now honors an injected artifact root on the read path
  as well as the write path. Abandoned `index_folder` authorization proposals are
  pruned once their window closes instead of holding a validated host path for
  the process lifetime. Metrics sampling moved to an owned sampler with explicit
  `start`/`stop`, a single-flight guard so a slow `store.counts()` or `vm_stat`
  cannot overlap the next sample, and release through graceful shutdown, so a
  re-mounted API router no longer leaves an earlier sampler running.
- **Capability exam scorecard normalization**: negative pass counts now clamp to
  zero without becoming blank, while genuinely blank rows remain incomplete.
  Clamped values persist consistently, Reset clears derived score state, and
  result templates emit the correct tier label.
- **Skill matching collisions from Aperio vocabulary**: bundled skill
  descriptions no longer treat generic host/actor terms such as `Aperio`,
  `agent`, and `every` as independent intent evidence. Presentation prompts
  describing Aperio's personal-memory layer now load only `pptx`, rather than
  also injecting `memory-protocol`, `handoff`, or `conversation-lifecycle`.
  Handoff keywords are now explicit intent phrases while preserving natural
  requests such as “compact this conversation” and “rotate the context”; user
  and agent-authored skills retain their full description vocabulary.
- **PptxGenJS API hallucination guidance**: the PPTX skill now requires reading
  its installed-version API reference before generating code and documents
  common invented methods alongside their working v4 equivalents. Generated
  CommonJS scripts also receive a fail-fast API compatibility guard.
- **Truthful generated-file reporting**: XLSX/DOCX generator calls now execute
  in the trusted agent host so they retain the active session scratch context.
  The model receives the exact verified artifact path returned by the tool;
  filename directory components are treated as display input instead of a
  promised destination, and the final-answer guard no longer falsely retracts
  generator artifacts that exist outside the requested prose path.
- **Graph progress started from chat**: Code Graph and Document Graph panels now
  reload their indexed-folder lists whenever reopened and keep a bounded status
  poll alive while visible, so indexing started through `index_folder` appears
  without requiring a panel-local action or page refresh. Polling slows while
  idle, accelerates during active indexing, and is invalidated cleanly when a
  panel closes.
- **Complete, synchronized test dashboards**: E2E CI no longer drops the five
  `real-app` files, recursive dashboard discovery now lists all nested test files,
  and unit/integration reporters include top-level skipped tests and correctly
  group root-level files. The Codecov job now runs unit and integration coverage
  together with explicit LCOV output and feeds both dashboards from one combined
  `tests/results/test-results.json` artifact. All transient reporter JSON now
  lives under the ignored `tests/results/` directory instead of the repository
  root. A combined structured reporter replaces the two
  parallel JSON reporter pipelines, eliminating Node 26's `TestsStream`
  max-listener warning without suppressing warnings or raising global limits.
  Real-app fixtures run from disposable working directories and clean them on
  startup failure as well as normal shutdown.
- **Silent dedup-worker failures**: `deduplicateMemories`'s 10-minute background
  loop (`lib/workers/deduplicate.js`) swallowed any error from
  `deduplicate_memories` with an empty `catch {}` — a persistent failure (e.g.
  embedding backend down) produced zero trace anywhere. Now logs via
  `logger.warn`, matching every other background worker (`session-prune.js`,
  `agent-run-prune.js`, `llamacpp-log-prune.js`, `infer.js`).

### Added

- **Spreadsheet artifact preview**: generated `.xlsx` cards now open a bounded,
  sandboxed table modal with sheet tabs, formula inspection, styled header cells,
  and both horizontal and vertical scrolling for large worksheets. Preview parsing
  is server-side and restricted to verified files under `/scratch` or the legacy
  `/uploads` compatibility mount.
- **Integration test tier**: formal three-tier test classification (unit/integration/e2e).
  Tests moved to `tests/unit/` (104 files, pure function), `tests/integration/` (93 files,
  module wiring), and `tests/e2e/` (10 files, real server), with unit and E2E tests
  grouped into descriptive subdirectories. New npm scripts:
  `test:unit`, `test:integration`, `test:ci:unit`, `test:ci:integration`,
  `test:integration:ci:dashboard`, and `integration:dashboard`. New reporters at
  `tests/reporters/unit-json.js` and `tests/reporters/integration-json.js`, with
  dashboards at `docs/benchmarks/unit/unit.html` and `docs/benchmarks/integration/integration.html`.
- **Expanded real-app E2E coverage** (18% → 35%+ route coverage): 28 new tests
  across agent job lifecycle (create/run/history/delete/gate-toggle), session
  lifecycle (chat/list/get/pin/delete), data import round-trips, WebSocket
  `resume_session`/`switch_model`/`set_paths`, the memory inbox
  (`propose_memory` → approve/reject), file-write interrupts
  (confirm/reject), and a code graph smoke test (index/repos/search/outline).
  The test-agent stub (`tests/e2e/helpers/test-agent.js`) gained an opt-in
  sentinel (`__e2e_call_tool__:<name>:<args>`) that spawns a real, scoped
  `mcp/index.js` child to exercise tool-only surfaces (`propose_memory`,
  `write_file`) that `injectAgent` mode has no other path to reach.

### Removed

- **Unreferenced streaming duplicate**: deleted `public/scripts/streaming.js`, a
  2,395-line copy of the browser streaming client that nothing loaded — the page
  and every test use the split `public/scripts/streaming/*` modules.

### Changed

- **Server boot/resource composition split**: `lib/server.js`'s ~330-line `bootApp()`
  and setup-wizard routing moved into six cohesive `lib/server/` modules —
  `hydrateRuntime.js` (DB/config/embeddings/allowlist), `graphWatchers.js`
  (codegraph/docgraph watcher boot), `roundtable.js` (Discuss agent pair),
  `backgroundWorkers.js` (dedup/infer/pruners), and `locale.js` + `setupRoutes.js`
  (locale detection, static/setup routes, bootstrap SSE). `createApp()`'s public
  contract, the pre-boot signal-handling race, and route registration order are
  unchanged — this is a structural refactor only (#307 Phase 4).
- **Streaming events dispatch through one router**: the browser client's ~45-branch
  `handleMessage()` if-chain became an explicit type→handler map owned by
  `streaming/handler.js`, with the handlers themselves registered by domain files
  under `public/scripts/streaming/events/` (lifecycle, turn, context, knowledge,
  tools, round table). Behavior is unchanged: each type still has exactly one
  handler, duplicate registration is now a load-time error, and an unrecognized
  type remains a deliberate silent ignore. New contract tests pin the full type
  list, the page's module load order, and an end-to-end streamed turn.
- **Session-owned artifact storage**: new generated XLSX/DOCX files and persisted
  image/scanned-PDF attachments now live under `var/scratch/<session-id>/` and are
  deleted or retained with their owning session. Standalone MCP generation uses
  isolated `var/scratch/mcp-<run-id>/` workspaces pruned with
  `SESSION_RETENTION_DAYS`. `/uploads` remains a cookie-protected, read-only
  compatibility mount for existing session cards, but receives no new writes.
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
- **Honest pricing (OpenRouter sync)**: Removed all hardcoded, inaccurate cost rates.
  Server now fetches real model pricing from OpenRouter's public catalog once per day,
  caches to `var/pricing-cache.json`, and sends accurate $/1M rates to the client.
  When pricing is unavailable (offline, API unreachable), navbar shows `—` instead of
  a guess. Gracefully falls back to stale cache on network failure. Verified against
  OpenRouter: DeepSeek V4 Flash was overstated 461%, Gemini 2.5 Flash underquoted by
  100%. Context windows now accurate (e.g., DeepSeek: 1,048,576 not 128,000). Models
  tracked: DeepSeek V4 Pro/Flash, Claude Opus/Sonnet/Haiku, Fable, Gemini 2.5,
  GPT-5.6 variants.

### Added

- **Honest capability signals for Codex/Claude Code** (provider-ux-parity WS6):
  attaching an image while either provider is active now surfaces a visible
  notice (`capability_notice`/`images_dropped`) at send time instead of the
  image silently vanishing — both providers build their prompt from the last
  user message's text only and never saw it. New `providerDropsImages`
  predicate in `lib/providers/index.js`. Skills matching's absence on these
  two providers (neither calls `getSystemPrompt`, so no `skills_matched` chip
  ever appears for them) is now documented in `FEATURES.md` as a known gap
  rather than an undocumented one — no behavior change there, this workstream
  confirmed the silence was already consistent and just made it legible.
- **Error and empty-turn parity for Anthropic/Gemini** (provider-ux-parity WS5):
  Anthropic no longer throws on a failed stream open or a mid-stream error —
  both now stream the same `⚠️` token bubble + `stream_end` every other
  provider loop already used, instead of surfacing through wsHandler's
  separate `error` event path. The "(model produced no response)"
  empty-completion fallback (previously only reachable via the
  llama.cpp/DeepSeek `ToolExecutor` path) is now a single shared helper
  (`emitEmptyResponseFallback` in `lib/tools/executor.js`) that Anthropic and
  Gemini's terminal branches call too, so a genuinely empty or whitespace-only
  completion shows the fallback bubble instead of a silent empty turn.
- **Reasoning parity across all providers**: Anthropic, Gemini, Claude Code, and
  Codex now stream the same collapsed `reasoning_start`/`reasoning_token`/
  `reasoning_done` bubble the llama.cpp/DeepSeek loops already used, with a real
  thinking-token count from each provider's own usage breakdown instead of an
  estimate (Anthropic `output_tokens_details.thinking_tokens`, Gemini
  `thoughtsTokenCount`, Codex `reasoning_output_tokens` — all pre-existing;
  Claude Code's was hardcoded to 0, now read from the SDK's raw stream events).
  Anthropic extended thinking is opt-in via new `ANTHROPIC_THINKING_BUDGET`
  (default 0/off — thinking tokens are billed output); its `redacted_thinking`
  content blocks (present when thinking content is encrypted rather than shown)
  are preserved verbatim in replayed history, required for a subsequent
  tool-use turn to validate. Gemini gates on the existing
  `GEMINI_THINKING_BUDGET` plus new `includeThoughts: true`. Codex needs the
  CLI's own `-c model_reasoning_summary` flag to emit a `reasoning` item at all
  (new `CODEX_REASONING_SUMMARY`, default `auto` — free, a summary of tokens
  already billed). Also fixes a latent bug where Claude Code's `stream_event`
  messages never fired at all in production (missing
  `includePartialMessages`), silently disabling not just reasoning but the
  existing text-token streaming and built-in tool cards too.
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

- **Tool cards now visible on Codex and Claude Code turns**: both providers ran
  tool calls invisibly to the user. Codex's shell/MCP calls execute in a
  subprocess that bypasses the shared tool hook entirely, so no card was ever
  emitted; Claude Code's SDK built-in tools (Bash, WebFetch, Read, …) had no
  card path at all, only its Aperio MCP tools (bridged through the existing
  hook) did. Codex now synthesizes `tool_start`/`tool_result` cards from
  `item.started`/`item.completed` events — canonical tool name (the raw shell
  command no longer leaks into the chip label), real command/args, and an
  honest ok/timing readout that never fabricates a checkmark for a status the
  subprocess didn't report (a `declined` item — rejected by approval policy —
  now correctly renders as failed, not a false success). Claude Code
  synthesizes cards for SDK built-in tools from `assistant`/`user` message
  tool_use/tool_result blocks, filtered by the `mcp__aperio__` prefix so its
  already-hooked Aperio tools are never double-carded; both loops share the
  hook's per-turn card sequence so a mixed turn (one Aperio tool + one
  built-in) can't collide on the same sequence number. On either provider, a
  card left pending by an abort, crash, or a dropped completion event now
  resolves as failed instead of staying stuck "running" forever.

- Standalone CLI chat messages that carry a queued `attach`ment placed the
  attachment's `[Image: ...]` label block before the user's own typed text.
  Every downstream intent classifier (tool-profile selection, skill matching,
  standalone-vision detection) reads "the first text block" as the user's
  request, so a task-shaped prompt like "Describe this bill. Report the
  provider, date, and total." was silently replaced by the label text —
  losing the standalone-vision classification that would otherwise withhold
  all tools for an already-inlined image, and leaving a native-vision local
  model to hallucinate malformed calls to `preprocess_image`/`read_image`.
  `buildAttachedUserContent` (`lib/terminal/commands.js`) now puts the user's
  text first, matching the WebSocket handler's existing ordering.

- Shutdown signals received during late application boot now wait for boot to
  install the full teardown path, ensuring scheduler, watchers, llama.cpp,
  embeddings, store, and HTTP resources are all released. (#301)

- **Speed metric restored for non-llamacpp providers**: the answer stats badge
  now shows `🚙 speed: {n} tok/s` — an overall/average rate computed from the
  displayed answer's token count ÷ full turn wall-clock time — for providers
  that do not expose llama-server per-phase timings. The numerator is derived
  from the visible answer text (not accumulated provider-reported usage which
  includes tool-payload and intermediate-model tokens), and the elapsed timer
  spans the whole request including tool execution and provider setup latency.
  `settleTurnTimer` no longer consumes `requestStartTime`, so every stream in a
  multi-stream turn (round-table, thought‑before‑tool) sees the same full
  wall-clock — the per-stream timing fallback only activates when the request
  timer has genuinely been cleared (abort/error). Elapsed is naturally
  overwritten by the next `startLiveTimer()` call on the next message.
  When llama.cpp timings
  ARE available, only the `⚡P`/`💨G` split is shown. The `{speed}` placeholder
  now works in all 26 locales (including the inline English defaults), and the
  stripping logic for the llamacpp branch uses a locale-agnostic regex. (#301)

- Artifact path safety now reuses the app-wide gate instead of a private copy.
  `lib/helpers/artifactActions.js` hand-rolled its own realpath/containment
  checks against raw `node:fs`, so any future hardening of traversal or symlink
  handling in `lib/routes/paths.js` — the module `AGENTS.md` designates as the
  single gate for every file operation — would not have reached scratch-artifact
  reveal. `realpathSafe` and `isUnder` are now exported from `lib/routes/paths.js`
  and consumed there. Both containment checks in that module also join on the
  platform separator (`path.sep`) rather than a hardcoded `/`, which on Windows
  had collapsed `isReadPathAllowed`/`isWritePathAllowed` to exact-path equality
  and rejected every legitimate subpath of an allowed folder. (#301)

- Direct skill-name matching no longer loses naturally inflected mentions.
  `hasPositiveSkillName` (`lib/workers/skills.js`) compared raw message tokens
  against the skill name, so "extract the text from these PDFs" or "run a couple
  of web searches" failed to name the `pdf` / `web-search` skills even though a
  singular mention matched. Name and message tokens are now compared on the same
  folded stems already used by keyword scoring; `foldToken`'s 3-character floor
  keeps short names intact, so "cis" still does not fold onto a `ci` skill, and
  negated mentions ("not PDFs", "don't use PDFs") remain suppressed. (#301)

- Tool-schema capping now stops at an over-budget higher-priority intent tool
  instead of skipping it and admitting cheaper core tools, preserving priority
  order across small and large llama.cpp context windows. (#301)

- File-edit tools no longer load for generic `generate`, `export`, or `convert`
  prompts without an explicit file target, while CSV creation and conversion
  requests retain their intended CSV/XLSX routing. (#301)

- Windows artifact reveals no longer report a failure when `explorer.exe`
  successfully delegates to an existing Explorer process but exits with code 1;
  genuine launch errors such as `ENOENT` are still surfaced. (#301)
- Skill-name negation matching now checks the actual multi-token match span,
  preventing an earlier compound word from making a later negated skill name
  appear positive. Common negative contractions such as `don't`, `doesn't`,
  `can't`, and `won't` are normalized before matching. (#301)
- Generated-file preview actions are hidden when the artifact fetch fails, so
  stale Open in browser and Show in folder buttons cannot target an unavailable
  file. (#301)
- Streaming cursor no longer appears frozen during a build. The answer bubble was
  rebuilt on every streamed chunk, so the cursor was a new DOM node each token and
  its blink animation restarted before completing a cycle, rendering permanently
  solid. Markdown now streams into its own container and the cursor persists across
  frames. Because a build's source is stripped from the bubble, nothing else on
  screen changed for the whole generation — the UI looked hung while the model was
  working normally.
- Build cards now report progress instead of a static `⏳` placeholder: they are
  reconciled in place rather than recreated each frame, which lets them carry a
  spinner and a live byte count as the artifact is written.
- Inline HTML artifacts now offer Open in browser and Show in folder, matching
  tool-written files. `persistAnswerArtifacts` returns file descriptors (name, URL,
  size) and the server emits `answer_artifacts`, so a card built from the message
  text can reach the real file in `var/scratch/`. Previously those actions were
  hidden because the client only had the in-memory string, never a path. The card
  also now shows the filename the server actually wrote, rather than an
  independently derived guess that could differ from the file on disk.
- The "answered with code instead of writing files" warning no longer fires when
  the model's code block was captured and persisted to the workspace. The file
  exists on disk in that case, so the warning was simply false; a persisted
  artifact now clears the no-tool streak the same way a tool call does.
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
  complete E2E dashboard suite, including isolated real-app child processes.
  Real-app E2E remains available as a concurrency-limited, manually dispatched
  workflow for focused production-process validation.

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
