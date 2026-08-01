# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## Unreleased

### Fixed

- **Ordinary writes can no longer plant a foreign-signature vector** (#340).
  `vec_meta` gated the read path but not the write path, so any ordinary write —
  `remember`, `wiki_write`, `self_remember`, import backfills, the retry queues,
  the startup backfill, the code/doc graph indexers — persisted whatever the
  *writing* process's `EMBEDDING_PROVIDER` produced, with no reference to the
  target store's status. In Postgres's multi-agent mode a second process could
  land an off-signature vector on a row a reindex had just cleared; since
  vectors carry no per-row provenance, that row dropped out of the driver's
  missing-vector scan and the store finalized `current` holding two embedding
  spaces. Every ordinary write now gates on the store's `vec_meta` status,
  before and after the embedding call, and writes the row without a vector for
  the store's own reindex driver to fill.

### Removed

- **`code-minimalism` and its dedicated evaluator**: removed the on-demand
  pre-write skill, matcher cases, A/B runner, fixtures, and tests. The skill did
  not earn its context cost; `code-simplification` remains as the post-write
  sibling. Verdict recorded on issue #285.

- **Mascot across the web UI**: the robot now speaks in the app, not just on the
  landing page. Every AI chat bubble carries the mascot as its avatar (48px,
  round-table agents keep their identity through a coloured ring instead of a
  coloured fill); the empty memories list and a new offline banner show a quiet
  greyscale robot; the setup wizard and the help page lead with it. Derived
  assets are generated from the masters by `npm run gen:mascot`
  (`gen:mascot:check` guards drift) and the PNG favicon set now also loads on
  `docs/guides.html`, `public/index.html`, `setup.html`, `help.html` and
  `codegraph-atlas.html`. The README header carries the mascot too. No new
  translation keys — the offline banner reuses the existing status strings.

- **Mascot on the landing page and a real 404**: three `.mascot-bubble`
  moments — Why Aperio, Aperio-lite and Quick Start — where the robot delivers
  the line the section already led with (the existing `data-i18n` element moves
  inside the bubble, so no locale gains a string). The hero terminal's provider
  row now wears the mascot's head instead of the 🤖 emoji, the footer offers the
  four wallpapers as lazy-loaded thumbnails labelled by resolution, and
  `docs/404.html` finally exists: "This page isn't in my memory." All new bytes
  on the landing page total 41 KB; every animation honours
  `prefers-reduced-motion`.

- **Mascot in the terminal**: `help` now draws a four-line ASCII robot down the
  left margin of its header, with the version beside the title. Terminals
  narrower than 80 columns get the plain header as before.

- **Landing page: flip cards for the team and MCP-tools sections**: the six
  "Team Ready" cards and all 54 tool chips now flip on click. The front states
  the situation the feature addresses (team) or what the tool does (chips); the
  back carries the everyday prompt you would actually type to trigger it — 60
  new prompts in total. Cards are keyboard-operable (`role="button"`,
  Enter/Space, `aria-pressed`) and honour `prefers-reduced-motion`; both faces
  share one grid cell so flipping never reflows the grid. Tool-chip columns
  widened to 310px, which makes the tools section shorter than before despite
  the added copy. All new strings are localizable (`tool_*_prompt`, `team_*`,
  `flip_*`); non-English locales fall back to English until translated.

- **Aperio mascot**: the retro-radio robot joins the brand — aurora-palette
  (purple/indigo/pink) artwork with an Electrolize aurora-gradient "A" on the
  chest. New `docs/assets/mascot/` suite (transparent PNGs, icon set,
  wallpapers up to 4K), new favicon for both the landing page and the web UI,
  landing hero now features the mascot, and social-card images point at the
  512px icon.

- **Visual background-job step builder + "what should this job do?" wizard**
  (#326, #327): the background-agents job form's `steps` mode replaces the raw
  JSON textarea with a row-based builder — a tool dropdown sourced from the
  live MCP registry (`GET /api/agents/tools`), dynamic input fields driven by
  each tool's schema, add/reorder (drag or arrows)/delete per step, and a
  synchronized raw-JSON fallback for power users. New job steps are now
  validated against the live tool registry at create/update time
  (`lib/workers/background-job-tools.js`). A first-step wizard
  (`POST /api/agents/wizard`) turns a plain-English description ("every
  night, clean up duplicate memories and regenerate their embeddings") into a
  suggested job — trigger, plus either a steps pipeline or a freeform prompt —
  which prefills the form for review; suggestions default to `enabled: false`
  and any schema-validation warnings are surfaced inline rather than blocking
  the draft.

- **Visual background-job step builder + "what should this job do?" wizard**
  (#326, #327): the background-agents job form's `steps` mode replaces the raw
  JSON textarea with a row-based builder — a tool dropdown sourced from the
  live MCP registry (`GET /api/agents/tools`), dynamic input fields driven by
  each tool's schema, add/reorder (drag or arrows)/delete per step, and a
  synchronized raw-JSON fallback for power users. New job steps are now
  validated against the live tool registry at create/update time
  (`lib/workers/background-job-tools.js`). A first-step wizard
  (`POST /api/agents/wizard`) turns a plain-English description ("every
  night, clean up duplicate memories and regenerate their embeddings") into a
  suggested job — trigger, plus either a steps pipeline or a freeform prompt —
  which prefills the form for review; suggestions default to `enabled: false`
  and any schema-validation warnings are surfaced inline rather than blocking
  the draft.

- **Fix: truthful, durable local-AI setup.** The setup wizard now labels total
  RAM and free model-cache storage explicitly, measures the filesystem that
  will actually hold the model, and recommends Gemma 4 E2B
  (`unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL`) for the ≤8 GiB tier. Failed
  downloads no longer display invented 35% progress or “waiting” transfer text;
  active downloads report persisted bytes with an indeterminate progress bar,
  including after reconnecting to setup. Full step errors remain readable.
  The 8 GiB E2B profile now serves an 8K context (with last-resort prompt
  compaction) so Aperio's startup context cannot overflow the former 4K window.
  Docker now stores both the pinned
  llama.cpp engine, Hugging Face model cache, and Transformers cache in
  `/app/var`, so recreating a container with its named volume cannot retain
  `bootstrap.lock` while losing
  the runtime it describes.

- **Lite installer VM bootstrap:** Linux and macOS installer checks now run the
  real `START.sh` Node.js/dependency bootstrap in non-launching automation mode,
  catching missing-runtime failures on clean guests instead of assuming `npm`
  is already installed. The bootstrap now requires the same Node.js 22 baseline
  as the smoke contract on POSIX and Windows, and handles nvm under
  strict-shell mode.

- **Codegraph: per-repo graph cache** (issue #283 follow-up). `code_neighbors`,
  `code_path`, `code_insights`, and `GET /api/codegraph/graph` no longer refetch
  and rebuild the full repo graph from the DB on every request. `lib/codegraph/graphCache.js`
  caches the built `{nodes, edges, graph}` per `(store, repoId)`, keyed on the
  existing `graph_revision` counter so a warm read reuses the cache and any
  mutation (new symbols/edges) invalidates it on the next read; concurrent
  misses coalesce into a single load, entries are LRU-bounded per store, and
  `deleteRepo()` evicts explicitly. Covered by `tests/unit/codegraph/graphCache.test.js`
  (9 tests: warm reuse, revision-bump invalidation, per-store isolation,
  stampede coalescing, stale-in-flight rejection, failed-load non-caching,
  explicit eviction, LRU bounding).

- **Changing your embedding provider no longer wipes every vector — and search
  degrades honestly while it rebuilds** (issue #287). Each vector store
  (`memories`, `wiki`, `self_memories`, codegraph, docgraph) now records the
  embedding signature its vectors belong to in a new `vec_meta` table. When you
  change `EMBEDDING_PROVIDER`, `VOYAGE_MODEL` or `EMBEDDING_DIMS`, the affected
  stores are marked **stale** instead of having every embedding deleted, and
  they answer with full-text search only until they have been reindexed —
  previously they would keep scoring new queries against vectors from the old
  model, which returns confident nonsense rather than a visible error. An
  explicit `search_mode: "semantic"` request is downgraded to full-text in that
  window rather than falling through to an unranked listing, and `dedup` refuses
  to run (it merges rows, so acting on cross-space similarity destroys data).
  Rebuilding happens automatically in the background when the server starts, or
  on demand with the new **`npm run embeddings:reindex`** (`--status` to report
  without rebuilding, `--store a,b` to scope it). The rebuild is resumable: it
  costs exactly one embedding call per row however many times it is interrupted,
  and each store is leased so a background rebuild and a CLI run cannot process
  the same store at once. A dimension change still has to recreate storage —
  vec0 tables and pgvector columns are fixed-width — but that is now tracked
  per store rather than silently clearing everything.

- **Fix: switching embedding provider, model, or dimensions no longer leaves
  vector search silently broken** (issue #287). Changing `EMBEDDING_PROVIDER`,
  `VOYAGE_MODEL`, or `EMBEDDING_DIMS` used to clear embeddings and then fail to
  regenerate them in several real configurations. Fixed across the board:
  `VOYAGE_MODEL` is now actually sent to the Voyage API instead of a hardcoded
  `voyage-3` (previously a provider change wiped every store and re-embedded
  with the old model — a destructive no-op), and model/dimension pairs are
  validated *before* anything destructive runs, so an unsupported
  `EMBEDDING_DIMS` is rejected up front rather than after storage has been
  erased. Postgres's `clearAllEmbeddings()` now covers all five vector stores
  (it previously missed `self_memories`, `cg_symbols`, and `docgraph_chunks`),
  and all five can now self-heal: self-memories, codegraph symbols, and
  docgraph chunks gained backfill scans, so a provider change no longer
  permanently disables search over stores nothing ever re-embedded. A
  dimension change now resizes vector storage (recreating SQLite vec0 tables /
  re-typing and re-indexing pgvector columns) instead of crash-looping on
  every subsequent insert, with the widths validated against sqlite-vec's
  8192 and pgvector's 2000-dim HNSW ceilings before any DDL. Standalone
  `npm run mcp` deployments now run this check at all — previously they never
  detected a provider change.

- **Fix: MCP tool settings from the database are applied before tools load.**
  `mcp/index.js` imported its tool modules statically, so they froze
  `process.env` values at import time — before the DB Settings overlay was
  applied. Under the default `db` precedence this meant a standalone
  `npm run mcp` server read `APERIO_ENABLE_SHELL` (and the llama.cpp image
  settings) from raw `.env` only: disabling `run_shell` in Settings left host
  command execution enabled. Configuration is now hydrated at the top of
  `startServer()` and tool registration happens afterwards.

- **Fix: codegraph/docgraph startup backfill is scoped to the watched root.**
  With multiple watched roots, each watcher's startup scan queried the whole
  graph, so every root re-enqueued every other root's pending symbols and
  chunks — up to one redundant embedding API call per symbol/chunk per extra
  root.

- **Database-backed llama.cpp model facts.** Curated download size, context,
  KV-cache, architecture, and optional vision-projector metadata now live in a
  lockstep `model_facts` table for SQLite and Postgres instead of the
  hand-maintained `MODEL_FACTS` source dictionary. Store initialization hydrates
  an immutable synchronous snapshot before sizing consumers run. Resolution is
  now configured DB/.env override → cached GGUF inspection → database catalog →
  conservative generic facts; setup specs hydrate the catalog before reporting
  disk requirements, while the pre-database Ollama migration gate derives model
  IDs from the config registry.
- **Fix: inline code requests no longer create unsolicited files.** Bare requests
  such as "write a function" or "create a helper" now receive code inline instead
  of being treated as filesystem-mutation intent. Naming a file/path, asking to
  save the result, or requesting an edit still offers the file tools. The
  `code-minimalism` skill now states the same delivery boundary explicitly.
- **Plain-English background-job form** (#169): the background-agents job
  form (`public/scripts/agents-panel.js`) targeted non-coders with a raw JSON
  steps textarea, millisecond fields, and jargony labels. Quick wins: template
  dropdown labels rewritten in plain English plus 4 new templates (hourly
  dedup check, daily backup, daily priority summary, code-change → changelog
  entry — the write-capable ones seeded `enabled: false`); debounce now shown
  in seconds and timeout as a preset dropdown (30s/1m/2m/5m/10m) instead of
  raw ms; freeform's provider/model/timeout collapsed behind an "Advanced"
  section; invalid steps-JSON now reports `line N, column M` instead of the
  raw parser message; job-id, watcher-source, debounce, and common step-tool
  hints rewritten in plain English. The visual (no-JSON) steps builder and
  the natural-language job wizard — the issue's bigger bets — are split into
  their own issues: #326 and #327.
- **Docgraph → Memory Bridge** (#314): when `DOCGRAPH_AUTO_MEMORY=on` and a
  `doc_batch` read extracts high-confidence terminal facts (amount_due/grand_total
  + due_date/invoice_date/service_period_start with high confidence), a compact
  fact memory is auto-promoted into the store for trend-question recall. Privacy
  tier 2 (sensitive) by default — withheld from cloud providers. Opaque hashed
  dedup tags prevent PII leaks. Multi-record and ambiguous-fact guards. The
  spike validated 100% semantic recall@3 for 10 trend queries.
- `store.update()` now preserves the memory `tier` field (was silently resetting
  to tier 1). `store.delete()` now marks citing wiki articles stale (same
  staleness contract as `update()`'s tombstone path). Both backends.

- **Codex turn guardrails** (#302): the Codex provider now records aggregate
  processed/cached/output/reasoning usage together with distinct tool-call and internal
  step counts, elapsed time, and guardrail status. Configurable live tool, step, and
  timeout limits interrupt pathological turns with an actionable message. The current
  Codex CLI's post-turn processed-token ceiling is reported as observed telemetry and
  preserves the completed answer. Defaults are 64 tool calls, 128 work steps,
  1,200,000 ms, and 300,000 processed tokens.
- **T-R5 retrieval gate passes (deepseek-v4-pro)** (#250 WS0-R): the document
  intelligence harness runs the full retrieval pipeline (auto doc_batch preflight
  → fact extraction → categorized breakdown) against the rebuilt 9-period oracle.
  deepseek-v4-pro passes all 10 gate checks: 5 category totals exact (260.50 /
  215.60 / 140.75 / 50.00 / 29.99 BGN), grand total 696.84 BGN correct, EUR
  travel items separated, no double-counting, full coverage, no oracle/path leak.
  deepseek-v4-flash passes everything except EUR-travel exclusion. Unblocks WS1.
- **Fix: DeepSeek v4 provider multi-turn tool calls** — DeepSeek v4 models
  require `reasoning_content` on every assistant message with `tool_calls`,
  including synthetic ones from the auto-batch preflight. Without it the API
  returns "must be passed back" errors on the second model turn. Fixed in
  `toOpenAIMessages()` to emit `reasoning_content: ""` when missing. Also
  split the reasoning adapter into `deepseek-v4-flash` / `deepseek-v4-pro`
  variants — pro supports `thinking_mode` natively; flash is equivalent.
- **New skill: `code-minimalism`** — a pre-write decision ladder (#285 WS1). Aperio
  had a post-write cleanup skill (`code-simplification`) but nothing that fired
  *before* the code existed. The new skill asks, in order: does this need to exist →
  is it already in this codebase → can the language or stdlib do it → can the native
  platform (SQLite FTS5/`sqlite-vec`, `pgvector`, Express, the DOM) do it → can an
  already-installed dependency → can it be a few inline lines → and only then, the
  minimum viable module. Rung 2 is anamnesis applied to code: recall what the
  codebase already knows before writing it again. The two skills are phase siblings,
  not duplicates — `code-minimalism` fires before a line is written and produces
  *less code written*; `code-simplification` fires after the code works and produces
  *same behaviour, less code kept*. A "When NOT to Use" section pins the
  non-negotiables — validation, error handling, security checks, and tests are never
  what gets trimmed — and the skill is `load: "on-demand"`, so it costs no context
  on turns that do not match it. Keyword selection was the only real design problem:
  the skill index is one shared namespace, and broad verbs ("write", "create", "add")
  would have stolen slots from `pptx`, `frontend-design`, and
  `debugging-and-error-recovery`, two of which are pinned by exact-match house tests.
  Every entry is therefore a multi-word phrase or a genuinely discriminating term,
  tuned against `skills/autotune/score.mjs`: train accuracy rose 0.8049 → 0.8367 with
  holdout flat at 0.4286 (watched as the overfitting check) and no new failing case
  id. `skills/autotune/eval.json` gained four positives and three `expectNot` cases,
  and `tests/integration/skills/code-minimalism.test.js` (M1–M6, 24 assertions) covers
  frontmatter and index registration, ladder/non-negotiables/cross-links/attribution
  content, positive matching, negative matching plus the two pinned house prompts, eval
  coverage in both directions, and the regression floor. The ladder is adapted from
  [ponytail](https://github.com/DietrichGebert/ponytail) (MIT), attributed in the skill
  body. Remaining in #285: WS4 (codegraph-backed reuse rung).
- **`code-minimalism` before/after eval harness** (#285 WS2): the skill costs
  ~1.7k input tokens on every turn it matches, so WS1 shipped the skill on
  taste alone — WS2 builds the instrument to check whether it earns that cost
  in numbers. `scripts/minimalism-bench.js` runs the same task twice, once
  with the skill available (arm A) and once from a sandbox whose `skills/`
  copy omits it (arm B — zero production change), in-process against a real
  `createAgent()` + `runAgentLoop()` (MCP stubbed at the SDK layer, same
  pattern as the agent-loop harness), measuring lines of code, *net* tokens
  (input+output — output alone would flatter the skill by hiding its own
  prompt cost), correctness, and wall time. 7 held-out task fixtures live
  under `tests/fixtures/minimalism-tasks/` — 6 single-file "sanity tier"
  fixtures plus `cache-entry-ttl`, a multi-file "feature tier" fixture with
  room for over-engineering to actually manifest — three of which ship a
  corner-cutting `anti-solution/` that must fail its own reference tests, so
  a "minimal" answer that skips validation scores as incorrect rather than
  as a win. `--dry-run` replays a deterministic mock script built from each
  fixture's reference solution, exercising the whole pipeline in CI with no
  live model; a live run discards one warm-up repeat per fixture and
  alternates A/B/B/A across repeats so cold-cache and thermal drift can't
  land on one arm. Live evaluation is isolated behind an evaluator-owned
  llama-server on port 18080, with readiness/model guards, per-model ledgers
  outside `var/`, transactional writes, and teardown on completion or
  signal; a zero-usage cell invalidates the run. Isolation covers both
  halves: the evaluator's own server lifecycle (`scripts/minimalism-live-server.js`,
  kept alive with a real timer rather than an unresolved promise with nothing
  else pending — the latter made Node exit with code 13 and orphan the
  server child it had just spawned) and this process's own inference calls
  (`runMatrix()` now points `LLAMACPP_BASE_URL` at the isolated port for the
  duration of a live run — `resolveProvider()` has no override path through
  `providerConfig`, so without this every call silently fell back to the
  shared default port 8080, defeating the isolation). Every run also writes
  a `<ledger>.report.md` human-readable summary (per task/arm correctness and
  median tokens/wall-time, plus the verdict) and a `transcripts/<ledger-name>/`
  directory with one markdown file per cell — prompt, every tool call with
  its args/result, and the model's full turn text, opened directly in a
  terminal or browser — plus a one-line-per-cell progress indicator on
  stdout, since the sparse internal agent logs alone don't show whether a
  live run is progressing or stuck. Results from dry runs append to
  `var/autotune/minimalism.tsv`; `computeVerdict()`
  (`lib/helpers/minimalismBench.js`) applies a pre-registered KEEP / TRIM /
  DROP / INCONCLUSIVE rule to the medians, where a correctness regression
  (judged by per-task pass rate, not an all-or-nothing gate — a baseline that
  itself isn't flawless can still regress) disqualifies a verdict no matter
  how good the token numbers look. 52 tests across
  `tests/unit/helpers/minimalism-bench.test.js` and
  `tests/integration/skills/minimalism-bench.test.js` cover arm construction,
  fixture correctness, the dry-run pipeline, ledger integrity, verdict
  thresholds, transcript/report rendering, and sandbox teardown hygiene
  (forced failure and `SIGINT`). Model verdicts against live providers remain
  a separate, manually-gated exercise tracked on #285.
- **`code-minimalism` eval harness hardening** (issue #336, follow-up to #285
  WS2): the live WS2 evaluation exposed evidence-quality and lifecycle gaps in
  `scripts/minimalism-bench.js`/`lib/helpers/minimalismBench.js`. Fixed:
  cumulative token totals were the only signal a cell reported, hiding how
  much of the total was retry/recovery cost rather than prompt size —
  `collectCellMetrics()` now derives per-cell model request count, tool-call
  and tool-error count, duplicate-call count, context-trim count, and the max
  single-request input tokens from the same event stream, all new ledger/
  report/transcript columns. The warm-up discard was asymmetric (arm A only,
  since only arm A loads `code-minimalism`), biasing cache-sensitive results
  toward arm A — `buildFixtureCellPlan()` now discards one warm-up per arm.
  `runMatrix()` previously batched every ledger row and the report until the
  whole matrix finished, so an interrupted run kept transcripts but no
  ledger/report evidence — rows now append and the report re-renders after
  every completed cell; a new `isMatrixComplete()` gate makes `renderReport()`
  state "INCOMPLETE MATRIX" and withhold the verdict when any task/arm hasn't
  hit its planned repeat count. A model that repeats an identical failing
  tool call can rack up ~200s and >130k cumulative tokens before finally
  succeeding once — the real agent's `tool-safety-middleware.js` loop-break
  already caps this at 3 identical failures, but only *per turn*, so a model
  that's told to stop, retries differently, and repeats the same failure in
  a later turn was never bounded. `createBenchHostTools()` now tracks
  identical tool failures across the WHOLE cell and, past
  `DUPLICATE_FAILURE_BUDGET` (3), aborts the cell via the same
  `getAbort`/`setAbort` `AbortController` handshake every provider loop
  already honors — no changes to the real agent/tool-safety layer. The
  ledger's new `outcome` column records `completed` vs.
  `duplicate_failure_budget_exceeded(name,3x)` instead of collapsing the
  recovery story into the final `correct` boolean alone. Finally, the
  benchmark runs substantial real Aperio machinery (identity, skills,
  preflight, middleware) even with its four-tool allowlist — a valid
  "real Aperio agent" measurement, but not a clean isolated measurement of
  the skill alone. A `skill-isolation` mode (minimal identity/middleware)
  remains undecided/unbuilt; every row/report/transcript now carries an
  explicit `mode` field (`EVAL_MODE`, currently always `"real-agent"`) so the
  report states which mode produced a result rather than leaving it implicit.
  18 new unit tests plus updates to the existing warm-up/report tests; all 60
  unit + 14 integration tests green.
- **Audit Run 1 — all 22 component slices complete** (A01–A22): every slice now
  has a content-hashed `manifest.json` and a `contract-result.json` with
  deterministic invariant checks. Completed slices span WebSocket/session lifecycle
  (A04), agent factory (A05), provider contract matrix (A06), context assembly (A07),
  artifact lifecycle (A08), privacy and egress (A09), skills and prompt injection (A10),
  tool discovery (A11), MCP boundary (A12), filesystem/shell (A15), network egress (A16),
  interrupt semantics (A17), permissions (A18), budgets (A19), background agents (A20),
  codegraph/docgraph ingestion (A21), and UI/i18n/packaging (A22). Pre-existing:
  bootstrap (A01), config/secrets (A02), HTTP routes (A03), memory/wiki/embeddings (A13),
  database parity (A14). All contract gates passed. Remaining: Wave 5 — 12 end-to-end
  boundary journeys and cross-domain matrix.
- **Codegraph backend parity coverage** (tests only, no production change).
  Closing out #283 surfaced that the graph-intelligence API shipped with a test
  on the SQLite side only, and that the migration guard compared *filenames*
  rather than schemas — so a column present in one backend and missing in the
  other would have passed CI silently, which is precisely the drift the
  lockstep rule exists to prevent. Two guards close that:
  `tests/unit/db/migration-lockstep.test.js` now parses both
  `010_codegraph_intelligence.sql` files and asserts column-level parity —
  same columns in the same order, equivalent type families (SQLite `REAL` ↔
  Postgres `DOUBLE PRECISION`, `TEXT` ↔ `TIMESTAMPTZ`), identical nullability,
  defaults, `CHECK`s, cascade rules, indexes, and an identical v10 backfill
  `UPDATE`; unrecognized statement forms fail loudly instead of being skipped.
  New `tests/integration/codegraph/backends/postgres.test.js` covers the
  previously untested Postgres backend: export-surface and arity parity against
  the SQLite backend, matching `userFacing` errors for absent/ambiguous repos,
  `loadGraph` excluding unresolved (`dst NULL`) edges and deriving the same repo
  basename, and the full `persistAnalysis` lifecycle — commit on a matching
  revision, `ROLLBACK` without writing when a newer revision won the race or the
  repo vanished, rethrow-and-release on a write error, with the pooled client
  released on every path. The SQLite half runs against a real migrated
  in-memory store; the Postgres half uses a recording mock pool, per the
  docgraph backend convention. Both guards were teeth-checked (dropping a column
  from one migration, and unexporting one backend function, each turn exactly
  the intended tests red). Remaining #283 gaps filed as #322.
- **Agent-loop harness: confirm-before-act and mid-chain abort coverage**
  (tests only, no production change). Two guardrails that were only verifiable
  by hand now have deterministic scenarios. `confirm-pending-delete` and
  `confirm-pending-index-folder` cover the emit half of the confirm protocol
  (`lib/agent/tool-hooks.js`): a `CONFIRM_TOOLS` result carrying a `Token:` line
  must become an `action_confirm_pending` event with the right label, summary
  and `destructive` flag **and** end the turn, since nothing has happened yet —
  the delete scenario keeps a second tool call and a final answer queued behind
  it specifically to prove neither runs. Both fixtures mirror the real
  producers' output (`mcp/tools/files/delete.js`,
  `lib/agent/host-tools/index-folder.js`) byte-for-byte, because that text is
  what the hook parses. `abort-mid-chain` covers a user pressing stop: a new
  `abortAfterTools: N` scenario field trips a real `AbortController` wired as
  `ws/turnLock.js` wires it, and the scenario asserts no further tool starts, no
  files from the steps that never ran, a closing `stream_end`, no
  `tool_failure`/`tool_budget_exhausted` (an abort is not a model failure), and
  `turn_complete{status: "interrupted"}`. Both new checks were verified by the
  teeth drill — breaking `emitter._confirmPending` and the provider's abort
  check each turns exactly the intended test red. Harness now 28 tests / 12
  scenarios, still well under 1s. `tests/harness/README.md` was rewritten as the
  harness's developer entry point (what is real vs faked, when to run it, how to
  add a scenario, failure-to-layer lookup, and the coverage it deliberately does
  not provide) and is now pointed at from `AGENTS.md` and
  `id/reference/testing.md`. Remaining gaps filed as #319 (sub-agent spawn has
  no production caller), #320 (`plan_*` events have no consumer) and #321
  (harness is single-turn: no trim / prefix-stability / cross-turn coverage).
- **Tool-result envelope unification** (agent-harness-epic WS3, closes #288):
  `summarizeResult()` (`lib/agent/toolActivity.js`) and the offload boundary
  (`lib/agent/tool-hooks.js`, `lib/agent/model-context-middleware.js`) now
  produce one documented envelope — `{ok, summary, detail?, artifact?: {id,
  tokenCount, byteCount}}` — for the `tool_result` event, instead of the UI
  activity card only learning about an offloaded result via a separate
  `tool_result_offloaded` event or by scraping the pointer out of the
  model-facing preview text. Fixes an incidental data-exposure bug found while
  wiring this up: the card's `detail` field was shipping up to 2000 raw,
  un-redacted characters of an oversized result over the socket, because the
  summary was always built *before* the offload/redaction step ran — the
  card's "full text" was never actually the redacted copy the model saw.
  `ok`/`summary`/`detail`/`details`/`memories` are still computed from the
  untouched raw result exactly as before (byte-identical for every ordinary
  call), but `detail`/`details`/`memories` are now dropped from the emitted
  event whenever this call produced an artifact — the raw content stays out of
  the socket entirely once it's been offloaded, and the card gets the
  artifact pointer + summary instead. Offloading itself is unchanged: it still
  only ever runs after provenance fencing, so the fence guarding untrusted
  content still applies to whatever ends up stored. Verified by a new harness
  test (`tests/harness/harness.test.js`, G3-1) asserting both the envelope
  shape and the absence of `detail` on the existing `oversized-offload`
  scenario; the `tool-hooks.js` integration suite's "offloads after provenance
  fencing" test (already in place) confirms the ordering didn't regress. This
  was the last open workstream of the agent-harness-epic (WS0–WS3 all
  shipped).
- **Sub-agent spawn/delegation** (agent-harness-epic WS2): `lib/agent/spawn.js`
  adds `spawnChild()`/`spawnParallel()`, letting an agent delegate work to
  child agents built from its own `AgentSpec` (`lib/agent/spec.js`) instead of
  a hand-rolled multi-agent mode. Every spawn narrows — never widens — the
  parent's permissions: `recursionDepth` decrements by exactly one per hop and
  a spec with none left refuses to spawn further (a graceful, parent-visible
  refusal, not a thrown error), while a narrower `toolAllowlist` is enforced
  by reusing `lib/agent/bundle.js`'s existing administrator-narrowing checks
  (extracted into a new `narrowAgentSpec()` export — the "future delegated
  agents" hook already referenced in that file's comments). Each child runs
  the same `createAgent()`/`runAgentLoop()` path as any other agent, through
  an emitter that tags every event with a distinct `agent_id` and forwards it
  into the parent's own event stream; a child that fails or trips its
  tool-failure budget resolves as `{ ok: false }` rather than rejecting, so
  `spawnParallel()` always returns every sibling's result. Verified by 5 new
  harness tests (`tests/harness/spawn.test.js`, G2 group) covering 3 parallel
  children merging into the parent stream, failure isolation, the
  recursion-depth refusal, and the tool-allowlist narrowing invariant.
  `lib/workers/roundtable.js` (the prior, hard-coded two-agent mode) is
  intentionally left unrefactored — noted in `A2D.md` as follow-up work.
- **Agent planning loop** (agent-harness-epic WS1, experimental — off by
  default via `APERIO_AGENT_PLANNING`): the model may lead a multi-step turn
  with a machine-readable `APERIO_PLAN:` JSON plan before calling tools.
  `lib/agent/planning-middleware.js` validates each planned step's tool name
  against the turn's real tool set, tracks execution against the plan one
  step at a time, and — on a mismatch — surfaces a reflection prompt to the
  model on the *next* turn instead of blocking the call that drifted. Wired
  through the existing `beforeModel`/`afterTool`/`afterModel` lifecycle hooks
  (`lib/agent/index.js`, `lib/agent/tool-hooks.js`), so no provider loop file
  needed to change. Fail-safe by construction: no plan, or an invalid one,
  and the loop is byte-identical to the gate being off — verified by 11 new
  harness tests (`tests/harness/planning.test.js`) that also confirm every
  WS0 scenario stays green with the gate on and off, and that tool-safety
  middleware always runs before planning's drift tracking. Emits
  `plan_created`/`plan_step`/`plan_drift` events.
- **Deterministic assistant-behavior test harness** (agent-harness-epic WS0):
  a scripted, fake-model conversation now drives the real agent loop,
  middleware stack, and tool hooks in `tests/harness/` — no network, no live
  AI model, no real MCP subprocess — so every future change to `lib/agent/**`,
  `lib/tools/**`, `lib/context/**`, or `lib/providers/**` is checked against
  six concrete behaviors in under a second: a normal multi-step task
  completing correctly, a false "I saved your file" claim self-correcting,
  three broken tool calls in a row stopping the assistant, a huge tool result
  being stored separately and read back in pieces, untrusted web content
  blocking a following file write, and a repeated identical failure breaking
  the loop. Run with `npm run test:harness` (included in `npm test`); gated
  in CI by the new path-filtered `ci.agent-harness.yml` workflow. A matching
  "Behavior" dashboard (`docs/benchmarks/harness/harness.html`) joins the
  existing coverage/unit/integration/e2e dashboards, generated by
  `npm run harness:dashboard` and published to the same GitHub Pages site.
- **Audit Run 1 — all 22 component slices complete** (A01–A22): every slice now
  has a content-hashed `manifest.json` and a `contract-result.json` with
  deterministic invariant checks. Completed slices span WebSocket/session lifecycle
  (A04), agent factory (A05), provider contract matrix (A06), context assembly (A07),
  artifact lifecycle (A08), privacy and egress (A09), skills and prompt injection (A10),
  tool discovery (A11), MCP boundary (A12), filesystem/shell (A15), network egress (A16),
  interrupt semantics (A17), permissions (A18), budgets (A19), background agents (A20),
  codegraph/docgraph ingestion (A21), and UI/i18n/packaging (A22). Pre-existing:
  bootstrap (A01), config/secrets (A02), HTTP routes (A03), memory/wiki/embeddings (A13),
   database parity (A14). All contract gates passed.
- **Wave 5 — 12 cross-domain journeys and boundary matrix complete**:
  all 12 end-to-end journeys traced, each with named hops, contracts,
  test-coverage evidence, findings, and a verdict. Boundary matrix (7 callers × 5
  invariants) fully populated. Summary: 4 journeys PASS, 3 PASS with notes,
  3 DEFERRED, 1 MEDIUM-HIGH RISK (concurrent store access — see
  [#318](https://github.com/BaiGanio/aperio/issues/318)). Reports in
  `audit/runs/run-001/journeys/`.
- **Codex/Claude Code native image + skill support**: closes the two gaps
  `provider-ux-parity` (issue #290's sibling epic) documented as "known"
  instead of wiring in. Codex passes attached images through via the CLI's
  real `-i/--image <FILE>...` flag (temp files under the session scratch dir,
  cleaned up after the turn); Claude Code passes images through by switching
  `query({prompt})` from a plain string to the Agent SDK's
  `AsyncIterable<SDKUserMessage>` form. Both providers now run Aperio's own
  skill matcher every turn via a new `ctx.getSkillsBlock` export (skill
  content only, not the full base identity prompt — avoids duplicating
  identity content the SDK/CLI already provide on their own) and correctly
  emit the `skills_matched` chip. Also fixes `runClaudeCodeLoop` silently
  ignoring its entire `opts` parameter, so `extraSystem` (memory pointers, RAG
  context, workspace directives) now reaches Claude Code turns for the first
  time. `providerDropsImages()`/`IMAGE_DROPPING_PROVIDERS` machinery is kept
  (now empty) rather than deleted, for a future text-only provider. Codex's
  live-smoke verification (real image → real description) is tracked
  separately in issue #316 pending an authenticated local `codex` session;
  Claude Code's live smokes (image, skill-directed response, extraSystem
  fact-injection) were run against a real subscription session.
- **Codegraph graph intelligence** (issue #283, backend steps 1–4): the persistent
  code graph gains confidence-aware relationships, working file-level import edges,
  arbitrary traversal, and deterministic native community analysis. Migration `010`
  (mirrored SQLite/Postgres) adds edge `confidence`/`confidence_score`/`provenance`/
  `relation_context`, per-repo graph revisioning (`index_schema_version`,
  `graph_revision`, `analyzed_revision`), and `cg_communities` + `cg_symbol_metrics`
  snapshot tables. Every indexed file now gets a synthetic `kind=file` symbol, which
  fixes a latent bug where `__file__` import edges were silently dropped — imports and
  file-level import cycles now persist. Confidence policy: direct syntax facts are
  `EXTRACTED`/1.0, unique-name and relative-import resolutions are `INFERRED`/0.8, and
  no destination is ever fabricated. New read-only surfaces: MCP tools `code_neighbors`
  (relation-agnostic neighborhood, direction/depth/kind filters, honest truncation),
  `code_path` (bounded directed/undirected shortest path with a distinct `found:false`),
  and `code_insights` (`summary|communities|hotspots|bridges|cycles`); HTTP endpoints
  `GET /api/codegraph/{neighbors,path,insights,graph}`. Community detection uses
  Graphology's Louvain over an undirected projection with a seeded RNG (deterministic,
  repeatable); hotspots exclude file/built-in-noise nodes; bridges rank by
  cross-community ratio·degree·confidence with no quadratic betweenness; import cycles
  return one representative cycle per strongly-connected component via iterative Tarjan.
  Analysis is computed lazily on the first read after a graph revision changes and
  persisted with compare-before-commit so stale watcher results can't overwrite newer
  data. Adds `graphology` + `graphology-communities-louvain` (no Python/NetworkX). The
  interactive D3 visualization (steps 5–6) is tracked separately.
- **Live Postgres in CI** (issue #310): `ci.codecov.yml`'s `coverage-tests` and
  `e2e-dashboard` jobs now provision a `pgvector/pgvector:pg16` service
  container and set `APERIO_E2E_POSTGRES_URL`, so the SQLite/Postgres store
  contract suite (`tests/integration/db/contract/`, issue #307 Phase 3) runs
  its Postgres backend automatically on every push instead of only when a
  developer opts in locally. `real-app-lifecycle.test.js`'s T64 check now
  exercises the real URL-shape assertion instead of always skipping.
- **Memory compaction investigated and closed as a negative result** (issue #286, closed): built
  an eval-gated pipeline to compress stored memory content for recurring input-token savings
  (a deterministic filler-phrase rewriter, borrowed from the `/caveman-compress` idea, with
  protected-span masking and a per-item inflation guard) and measured it against real data before
  shipping. The eval gate — run against the 28-entry capability-exam corpus and, separately,
  every real row in the dev database — found **0.00% token savings**: 0 of the memories tested
  contained any of the target filler phrases. Confirmed independently via gzip compressibility
  (real memory content compresses markedly worse than filler-laden control text of the same
  length), ruling out a fixture artifact. Root cause: Aperio's stored memories are terse,
  third-person, LLM-extracted fact/decision prose with no removable conversational filler — a
  fundamentally different shape than the chat-log/verbose-note text the borrowed technique
  targets. The rewriter, its rule pack, and the before/after eval harness were removed; the
  token-counting convention and the recall token-cost/hit-rate@k measurement harness were kept
  as standalone tooling (`lib/memory/tokenCount.js`, `lib/memory/compactionBaseline.js`,
  `npm run memory:baseline`) since they're useful independent of compaction. See the closing
  comment on issue #286 for the full writeup.
- Reorganized benchmark inputs under `docs/benchmarks/tools/`, grouped test dashboards under `docs/benchmarks/`, and added a private-safe metrics export for the model-tier viewer.
- Renamed the model-tier viewer integration test to `benchmarking.test.js` and made qualification-case cards collapsed by default.
- Extracted the WebSocket chat/init turn-interruption mutex out of `lib/emitters/handlers/wsHandler.js` into `lib/emitters/handlers/ws/turnLock.js` (`createTurnLock()`), isolating the concurrency-safety logic from `handleChat`'s business logic (issue #307 Phase 5b). No behavior change; added characterization coverage for a previously-untested socket-close-during-active-turn scenario and a deeper interruption race.
- **Confirm tool list drift fixed**: `CONFIRM_TOOLS` (emit side) now imports the canonical `CONFIRMABLE_TOOLS` Set from `lib/helpers/confirmableTools.js` instead of maintaining a duplicate literal. Added identity-assertion test preventing future silent drift when adding confirmable tools.
- **llama.cpp state isolation**: the managed-server state file is now port-keyed (`state-${LLAMACPP_PORT}.json`) so two concurrent Aperio processes with different ports never share (and inadvertently reap) each other's llama-server.
- **`APERIO_MODEL_FACTS_OVERRIDES` env var**: JSON object keyed by HF repo path, slotted between GGUF inspection and the curated `MODEL_FACTS` dict in `resolveModelFacts`. Registered in config.js (tier 1, llama.cpp section).
- **Codegraph repo-resolution ORDER BY**: both SQLite and Postgres backends now order ambiguous-repo candidates by `root_path`, making the "Ambiguous repo …" error message deterministic and assertable.
- **Codegraph SQLite test fixture migrated from hand-copied schema**: `tests/integration/codegraph/backends/sqlite.test.js` now applies real migrations via `runSqliteMigrations()` instead of a hand-copied schema literal that could silently drift from the migration files.
- **Panel toggle first-click bug fixed**: 7 side-panel toggle functions (`codegraph`, `docgraph`, `wiki`, `db`, `settings`, `agents`, `skills`) now read the rendered display value via `getComputedStyle()` instead of the inline `style` attribute, which starts as `""` (not `"none"`) on CSS-hidden elements — fixing the "first click does nothing" UX bug on page load.

### Fixed

- **Document-aggregation intent missed "spending"** (issue #250 follow-up,
  T-R5.2): running the WS0-R red harness with a realistic full-month prompt
  ("What's my total spending this month, broken down by category?") failed
  before any retrieval happened — the model called `recall`, found nothing,
  and told the user it had no access to their financial data.
  `lib/agent/tool-profiles.js`'s `isDocumentAggregationIntent()` gates the
  preflight auto `doc_manifest`→`doc_batch` shortcut behind a money+aggregate+
  personal regex test; its money alternatives included `spend`/`spent` but
  not the gerund `spending`, so this common phrasing never matched and
  `doc_manifest`/`doc_batch` were never even offered as tools. Extended the
  pattern to `spend(?:ing|s)?`. Regression test added to
  `tests/unit/agent/tool-profiles.test.js`.
- **Preflight auto-batch context flooding, and missing Bulgarian date-role
  labels** (issue #313 follow-up): running the WS0-R red harness with a
  genuinely bare prompt ("How much did I pay for utilities last month?") on
  the 2B target model, instead of the heavily-steered prompts that had been
  propping up earlier green runs, exposed two real bugs the steered prompts
  never triggered. First, `lib/agent/preflight.js`'s pre-turn shortcut
  auto-executes `doc_manifest` then `doc_batch` before the model's turn
  starts, forwarding `buildCandidateManifest()`'s entire candidate list with
  no bound; once #313 removed the manifest's own hard `score >= 5` floor,
  nothing capped this shortcut, so a bare prompt handed a small model the
  whole indexed corpus in one turn — travel receipts, trade documents, tax
  notices included — and it never converged (300s timeout, zero output).
  Added `AUTO_BATCH_CANDIDATE_CAP` (16) in `preflight.js`, slicing the
  already-score-sorted candidate list before this specific auto-forward step
  only; `buildCandidateManifest()`'s own output, and any interactive
  `doc_manifest`/`doc_batch` call the model makes itself, are untouched, so
  #312/#313's fix is unaffected. A truncation note is appended to the
  synthesized tool result so the model knows to call `doc_manifest`/
  `doc_batch` itself if coverage still looks incomplete. Second, once the
  model could actually finish a turn, it reported the wrong billing month:
  `extract-facts.js`'s date-role `LABELS` table had zero non-English
  patterns, unlike its sibling `AMOUNT_LABELS` (already BG/DE/FR-aware since
  #312) — every date on a Bulgarian invoice fell through to
  `unlabeled_date`, giving the model no signal to prefer the June
  invoice/due date over the May consumption period ("Период на отчитане")
  printed in the same bill. Added Bulgarian `invoice_date`/`due_date`/
  `service_period`/`document_date` patterns mirroring the amount side's
  existing scope disclaimer (evidenced against the household fixture corpus,
  not a general translation table). Confirmed via the harness: gate now
  passes end-to-end (260.50 BGN, all four utility bills counted, correct
  month) where it previously either hung or under-counted.
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
- **Roundtable Discuss now supports `llamacpp` agents** (`lib/server/roundtable.js`,
  `lib/helpers/roundtableBudget.js`): `parseRoundtableAgents` validates against a
  hardcoded `SUPPORTED` set that was missing `"llamacpp"` — added it so the Discuss
  toggle can boot roundtable agents on a local llama.cpp provider. The RAM-budget gate
  (`shouldEnableRoundtable`) was double-counting the main provider's already-loaded model
  in the footprint estimate and using curated `MODEL_FACTS` defaults (8 GB weights,
  144 KB/token KV) instead of real GGUF metadata for unknown models; both fixed.
  `estimateLlamaCppFootprintGB` now calls `resolveModelFacts` which reads actual file
  headers from cached GGUFs. Confirmed: all 29 roundtable + budget tests pass with 3
  different local models (gemma-4-E2B main, Qwen3.5-4B + Phi-4-mini roundtable).
