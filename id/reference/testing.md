# Testing

Uses Node.js native test runner (`node --test`). Tests are organized into three tiers
under `tests/unit/`, `tests/integration/`, and `tests/e2e/`.

## Test Tiers

### Unit (`tests/unit/`)
- Pure functions — input in, output out, no side effects
- No `fs`, `path`, `os`, `child_process`, `http` imports
- No mock of external modules (mock of function arguments OK)
- Runs in <5ms per test
- 130 files covering parsing, formatting, validation, config resolution

### Integration (`tests/integration/`)
- Module wiring — Express Router, mock stores, DB adapters, temp files, real crypto
- May import real modules, use mock stores, invoke Express Router directly
- Must NOT bind a TCP port or spawn a server process
- Runs in <500ms per test
- 126 files covering routes, DB, store, MCP, skills, handlers, context, tools, agents, workers
- Uses `tests/mockDB.js` and `tests/mockStore.js` as shared helpers
- **Backend parity**: anything that touches both DB backends needs a test on
  each side (`tests/integration/{codegraph,docgraph}/backends/`). Convention:
  the SQLite half runs against a real migrated in-memory store, the Postgres
  half against a recording mock pool, and a parity block asserts the two export
  the same surface and behave identically where a caller could tell. Schema
  parity is guarded separately by `tests/unit/db/migration-lockstep.test.js`,
  which compares migration pairs column by column — filenames alone would let a
  missing column through

### E2E (`tests/e2e/`)
- Spawned server process, real HTTP/WS connections, real ports
- May start real Express + WebSocket server as a child process
- Runs in <30s per test
- ~10 files grouped under `bootstrap/`, `real-app/`, `websocket/`, and `ui/`; shared
  `fixtures/` and `helpers/` remain alongside those groups

### Harness (`tests/harness/`)
- Deterministic assistant-behavior regression net for the agent loop
  (agent-harness-epic WS0): a scripted `mock` AI provider drives the REAL
  `runAgentLoop`, lifecycle middleware, and tool hooks — no network, no live
  AI model, no real MCP subprocess (the MCP client is stubbed at the SDK
  layer, tool execution is faked via `createAgent({ hostTools })`)
- The `mock` provider only resolves when `NODE_ENV=test`
  (`lib/providers/index.js`); resolving it otherwise throws
- 12 scenario JSON files under `tests/harness/scenarios/`, one real-fs-backed
  ("does a file actually land in the workspace"), five guardrail checks
  (hallucination correction, failure budget, oversized-result offload +
  retrieval, taint write-gate, repeated-call break), two confirm-before-act
  checks (destructive and non-destructive: the event fires and the turn stops),
  one mid-chain abort ("the user pressed stop") and three planning-loop checks
  (valid plan, unknown tool in a plan, plan drift)
- Runs in well under 1s total
- **Read `tests/harness/README.md` before changing anything under
  `lib/agent/`, `lib/tools/`, `lib/context/`, or `lib/providers/`** — it
  documents the harness contract, what each scenario pins, how to add one,
  what the harness deliberately does *not* cover, and the manual G0-4 drill
  (temporarily break an event name, confirm the suite goes red, revert) that
  proves the net has real teeth

### Minimalism Eval (`scripts/minimalism-bench.js`)
- Before/after A-B evaluator for the `code-minimalism` skill (ponytail-borrow
  epic #285, WS2): same task, same model, skill present (arm A) vs. skill
  absent (arm B — a sandbox whose `skills/` copy omits `code-minimalism/`,
  zero production change), measuring lines of code, *net* tokens
  (input+output, not output alone), correctness, and wall time
- Same in-process pattern as the harness (`createAgent` + `makeSinkEmitter` +
  `runWithPaths`, MCP stubbed at the SDK layer) but drives a live provider
  instead of a scripted one — the harness answers "did my refactor break the
  loop?"; this answers "does this skill earn the tokens it costs?"
- 7 held-out task fixtures under `tests/fixtures/minimalism-tasks/` (prompts
  absent from `skills/autotune/eval.json`/`eval.holdout.json`): 6 single-file
  "sanity tier" fixtures plus `cache-entry-ttl`, a multi-file "feature tier"
  fixture with room for over-engineering to actually manifest (see
  `trash/plans/ponytail-borrow/ponytail-borrow-ws2-feature-tier.md`). Three
  fixtures carry `anti-solution/` — a corner-cutting answer that must fail its
  own reference tests, so a "minimal" answer that skips validation scores as
  incorrect, not as a win
- `--dry-run` replays a deterministic mock script built from each fixture's
  `reference/` solution, exercising the whole pipeline (sandbox, metrics,
  ledger) in CI with no live model and no network
- Live runs discard one warm-up repeat PER ARM (`buildFixtureCellPlan()`) — a
  cold model/cache would otherwise always land on arm A, which runs first, but
  arm A and arm B also load a different `skills/` tree (arm B's omits
  `code-minimalism/`), so warming only one arm biases the other's cache/
  latency numbers (issue #336) — and alternate A/B/B/A across repeats to
  spread thermal/cache drift evenly
- Live-run isolation is mandatory: use a dedicated llama-server port (default
  recommendation: `18080`, with `LLAMACPP_BASE_URL=http://127.0.0.1:18080`),
  a dedicated temporary runtime/log root outside the repository, and a
  dedicated ledger outside `var/autotune/`. Do not attach the evaluator to the
  app's normal server, database, logs, or current ledger. Two things both
  have to point at the isolated port, not just one: the evaluator-owned
  llama-server's own lifecycle (`scripts/minimalism-live-server.js`, given
  `LLAMACPP_PORT`/`LLAMACPP_BASE_URL` via its spawn env), *and* this
  process's own `createAgent()` calls, since `resolveProvider()`
  (`lib/providers/index.js`) reads `process.env.LLAMACPP_BASE_URL` directly
  with no override path through `providerConfig` — `runMatrix()` sets that
  env var itself for the duration of a live run and restores it after.
- Start and own llama-server for the evaluator, wait for `/health` and the
  requested model before the first cell, and tear down that process in a
  `finally`/signal handler. `scripts/minimalism-live-server.js` keeps itself
  alive with a real timer (`setInterval`), not a bare `await new Promise(()
  => {})` — the server child it owns is spawned `detached` + `.unref()`'d
  (correct for the main app, which has its own listeners keeping it alive
  regardless), so an unresolved promise with nothing else pending makes Node
  exit with code 13 ("Unfinished Top-Level Await") as soon as that child is
  up, orphaning it. A live run is invalid and must stop before writing
  comparison results when any cell has zero model usage (`input_tokens=0` and
  `output_tokens=0`) or when the readiness check fails.
- The repository ledger path `var/autotune/minimalism.tsv` is reserved for
  dry-run/legacy compatibility only; live runs use one private ledger per
  model, one row per task×arm×repeat. Each row/`appendLedgerRow()` call is
  written IMMEDIATELY after its cell completes (not batched until the whole
  matrix finishes), and `renderReport()` re-renders after every row, so an
  interrupted run keeps every cell it already paid for instead of discarding
  it (issue #336). Beyond the token totals, each row also carries
  `collectCellMetrics()`'s per-cell counts — model request count, tool-call
  and tool-error count, duplicate-call count, context-trim count, and max
  single-request input tokens — so a cell that spiraled through retries reads
  differently from one that didn't, even at the same cumulative token total.
  `isMatrixComplete(rows, fixtures, repeats)` gates the verdict: a partial
  matrix (fewer rows than planned) reports "INCOMPLETE MATRIX" instead of
  computing a verdict from an unfinished A/B comparison.
  `computeVerdict()` (`lib/helpers/minimalismBench.js`) applies the
  pre-registered KEEP/TRIM/DROP/INCONCLUSIVE rule to the medians — a
  correctness regression (by per-task *pass rate*, not an all-or-nothing
  gate) disqualifies a verdict no matter how good the token numbers look
- A model that repeats an identical failing tool call can spiral for minutes
  and >100k tokens before recovering — the real agent's own loop-break
  (`tool-safety-middleware.js`) caps this at 3 identical failures, but only
  *per turn*, so a model told to stop that retries differently and repeats
  the same failure later was never bounded (issue #336). `createBenchHostTools()`
  tracks identical tool failures across the WHOLE cell and, past
  `DUPLICATE_FAILURE_BUDGET` (3), aborts the cell through the same
  `getAbort`/`setAbort` `AbortController` handshake every provider loop
  already honors — the real agent/tool-safety layer is untouched. The
  ledger's `outcome` column records `completed` vs.
  `duplicate_failure_budget_exceeded(name,Nx)` rather than only a final
  `correct` boolean
- Every row/report/transcript also carries a `mode` field (`EVAL_MODE` in
  `lib/helpers/minimalismBench.js`, currently always `"real-agent"`) — the
  benchmark runs substantial real Aperio machinery (identity, skills,
  preflight, middleware) even behind its four-tool allowlist, which is a
  valid "real agent" measurement but not a clean isolated measurement of the
  skill alone. A `skill-isolation` mode remains an undecided, unbuilt design
  question (issue #336); `mode` exists so a report states which measurement
  produced a result instead of leaving it implicit
- Run dry: `node scripts/minimalism-bench.js --dry-run [--tasks=id1,id2] [--repeats=N]`.
  Live runs name the model explicitly, for example:
  `node scripts/minimalism-bench.js --model=org/model:Q4_K_M --tasks=id1,id2 --repeats=3`.
  The live runner starts `scripts/minimalism-live-server.js` in its temporary
  runtime root; do not start or attach a normal Aperio server for this eval.
  Live evaluation remains manual and is not part of CI.
- Every run (dry or live) writes two more artifacts next to its ledger, both
  meant to be opened directly — a terminal (`cat`/`less`) or a browser, no
  server involved: `<ledger-name>.report.md` (a human-readable summary table —
  per task/arm correctness and median input/output/net tokens and wall time —
  plus the verdict), and `transcripts/<ledger-name>/` (one markdown file per
  cell: the fixture prompt, every tool call in order with its args and
  result, and the model's full turn text — not just tool names, the actual
  conversation). The runner also prints one progress line per cell to the
  terminal as it runs (`▶ [n/total] task/arm/repeatN`, then a result line),
  since the sparse internal agent logs alone don't say whether a live run is
  progressing or stuck.

## Mocking Policy

All tests must mock external dependencies instead of using real
implementations. "External" includes:

- **Filesystem**: never read/write real files. Use `installMemfs` from
  `tests/helpers/memfs.js` (patches the CJS `fs` module, which ESM
  `import from "fs"` reads from) when the module under test touches the
  filesystem through session data, log files, or config files. Import
  modules that transitively use `"fs"` via dynamic `await import(...)`
  inside `before()`, never via static `import`, so the memfs patch is
  installed before ESM bindings snapshot.
- **Network**: mock `fetch` / `WebSocket` / `child_process.spawn` /
  HTTP requests. Never connect to a real service.
- **AI providers**: mock `complete()` or inject a stub via DI
  (`deps.complete` / `deps.logger` overrides).
- **Global timers**: mock `setTimeout` / `setInterval` /
  `clearTimeout` / `clearInterval` with `mock.method(globalThis, …)`
  so no real waits or intervals fire.
- **process.exit**: mock with a throwing implementation to prevent
  accidental test termination.
- **stdout / stdin**: mock `process.stdout.write` and
  `process.stdin.pause` when the module writes to the terminal.

These mocks keep tests hermetic, fast (<500ms per integration test),
and safe to run in CI without external services.

## Commands

```bash
npm test                       # All tests (unit + integration + e2e + harness)
npm run test:unit              # Unit tests only (tests/unit/)
npm run test:integration       # Integration tests only (tests/integration/)
npm run test:harness           # Deterministic assistant-behavior harness (tests/harness/)
npm run test:skills            # skills integration tests
npm run test:store             # store integration tests
npm run test:memory            # tools memory unit tests
npm run test:execution         # Skill execution integration tests
npm run test:backfill          # Embedding backfill integration tests
npm run test:e2e               # All E2E tests (protocol + real-app)
npm run test:e2e:real          # Real-app E2E tests only (no mock fixtures)
npm run test:e2e:ci            # All E2E tests with dashboard JSON reporter
npm run test:browser           # Playwright specs (tests/browser/) against a real app boot
npm run test:browser:headed    # Same, with a visible browser
npm run test:ci                # Unit + integration coverage and combined dashboard JSON
npm run test:ci:unit           # Unit tests with unit JSON reporter
npm run test:ci:integration    # Integration tests with integration JSON reporter
npm run test:ci:dashboard      # Refresh all five dashboard data artifacts
npm run test:unit:ci:dashboard # Unit tests plus unit dashboard data
npm run test:integration:ci:dashboard # Integration tests plus dashboard data
npm run test:harness:ci:dashboard # Harness tests plus behavior-checks dashboard data
npm run test:only -- --test-name-pattern="pattern"  # Filter by name
npm run coverage               # Generate lcov report from c8
npm run unit:dashboard         # Generate unit test dashboard data
npm run integration:dashboard  # Generate integration test dashboard data
npm run e2e:dashboard          # Generate E2E test dashboard data
npm run harness:dashboard      # Generate behavior-checks (harness) dashboard data
```

The primary Codecov workflow runs `test:ci` once for unit and integration
coverage. The console reporter and `tests/reporters/ci-json.js` share that run;
the latter writes `tests/results/test-results.json` with separate `unit` and `integration`
sections, avoiding a third `node:test` reporter pipeline and its
`TestsStream` max-listener warning. The workflow generates coverage, unit, and
integration dashboard data from that run, while a parallel E2E job runs every
file under `tests/e2e/`, including real-app fixtures. The same job also runs
the harness unconditionally (not path-filtered) so the behavior-checks
dashboard always has fresh data, even on a push that doesn't touch
`lib/agent/**` — the separate, path-filtered `ci.agent-harness.yml` workflow
is the fast PR gate for agent-loop changes specifically. Dashboard artifacts
are published for master pushes. The separate **Real-app E2E (manual)**
workflow remains available for focused production-process validation. E2E
concurrency is capped at 2, no model service is required, and Postgres parity
remains opt-in through `APERIO_E2E_POSTGRES_URL`.

## Installation smoke tests

The shared VM contract lives in `vms/smoke.sh` and `vms/smoke.ps1`. It validates
Node.js, native modules (`better-sqlite3`, `sqlite-vec`, and `sharp`), SQLite
migrations, HTTP bootstrap, setup-page delivery, and runtime hygiene.

On an Apple Silicon Mac with Parallels Pro/Business and the
`vagrant-parallels` plugin:

```bash
npm run vmtest:linux
npm run vmtest:linux:debian
npm run vmtest:windows
```

The Linux executors use disposable native ARM64 Vagrant guests. The Windows
executor resets a pre-created Windows 11 ARM VM to its `clean` Parallels
snapshot. All executors exclude host `node_modules`, write logs to `vms/out/`,
and clean up their guest state on failure as well as success. See
[`vms/README.md`](../../vms/README.md) for setup and environment overrides.

## Test Helpers

- `tests/mockDB.js` — in-memory SQLite store for tests
- `tests/mockStore.js` — mock store factory
- `tests/reporters/quiet.js` — CI reporter (used when `APERIO_AGENT_RUN` is set)
- `tests/reporters/ci-json.js` — combined unit/integration coverage reporter. It emits
  one `tests/results/test-results.json` payload with independent `unit` and
  `integration` sections,
  so CI needs only one structured reporter pipeline.
- `tests/reporters/unit-json.js` — structured JSON reporter for the unit dashboard.
  Usage: `node --test --test-reporter=./tests/reporters/unit-json.js
  --test-reporter-destination=tests/results/unit-results.json`
- `tests/reporters/integration-json.js` — structured JSON reporter for integration dashboard.
  Usage: `node --test --test-reporter=./tests/reporters/integration-json.js
  --test-reporter-destination=tests/results/integration-results.json`
- `scripts/generate-integration-dashboard.js` — converts reporter JSON to `docs/benchmarks/integration/integration-data.js`.
  Run: `npm run integration:dashboard`
- `tests/reporters/harness-json.js` — structured JSON reporter for the behavior-checks
  dashboard; groups by `describe()` block ("Safety checks" vs. "Behavior checks")
  rather than subdirectory, since `tests/harness/` is a flat directory.
  Usage: `node --test --test-reporter=./tests/reporters/harness-json.js
  --test-reporter-destination=tests/results/harness-results.json`
- `scripts/generate-harness-dashboard.js` — converts reporter JSON to `docs/benchmarks/harness/harness-data.js`.
  Run: `npm run harness:dashboard`
- `tests/harness/host-tools.js` / `run-scenario.js` — shared fixtures for the
  deterministic harness: fake in-process tool handlers and the scenario driver
  (stubs the MCP client at the SDK layer, wraps `createAgent()` + `runAgentLoop()`
  in an isolated `mkdtemp` scratch dir).
- `tests/helpers/streamingScripts.js` — the ordered list of `public/scripts/streaming/*`
  classic scripts, shared by every suite that loads the browser streaming client into a
  `vm` context. It is the single source of truth for load order: `state.js` → `handler.js`
  (which owns the event router) → renderers → `events/*.js` (which register into it).
  `tests/integration/public/streaming-router.test.js` asserts `public/index.html` loads
  exactly this list, so adding a module to the page without adding it here fails.
- `tests/e2e/helpers/ws-helper.js` — shared buffered-connect helpers for WebSocket E2E tests.
  `connectBuffered()` attaches the message listener before `open` resolves, eliminating the
  handshake race. `collectUntil(endType)` replaces fixed-sleep collection with event-driven
  termination. Always use this helper for new E2E tests.

## Real-App E2E Harness

Spins up the actual production Express + WebSocket server as a child process.
Uses scratch runtime roots so no repository state is touched.

### Fixture modes

| Env var | Effect |
|---------|--------|
| `APERIO_E2E_SKIP_BOOT=0` | bootApp() runs: DB opens, API mounts (default: skip) |
| `APERIO_E2E_INJECT_AGENT=1` | Inject contract-faithful test agent stub (no real model) |
| `APERIO_E2E_ROOT` | Override scratch runtime root (default: `var/e2e-scratch`) |

### Port isolation

`startRealApp()` sets `PORT=0` by default. Port zero is an operating-system
sentinel, not a concrete port to probe or clear: `ensurePort()` skips collision
handling and the fixture reads the assigned port from `httpServer.address()`.
This keeps concurrent fixtures isolated and avoids colliding with real Aperio
instances. Do not assign the production local/cloud ports (`31337` and `1701`)
to E2E fixtures.

Suites that run `bootApp()` for HTTP persistence or WebSocket coverage must set
`APERIO_E2E_INJECT_AGENT=1`. Their readiness must not depend on starting a real
MCP server or model process. Early fixture exits include the final captured
stdout and stderr lines in the test error.

### Helper API

```js
import { startRealApp, request } from "../helpers/real-app-helper.js";

test("my test", async (t) => {
  const app = await startRealApp(t, {
    env: { APERIO_E2E_SKIP_BOOT: "0", APERIO_E2E_INJECT_AGENT: "1", ... }
  });
  const res = await request(app, "/api/locale");
  assert.equal(res.status, 200);
  await app.stop();
});
```

- `startRealApp(t, opts)` — spawns the fixture, waits for READY, returns `{ port, stop, request }`.
  Auto-cleanup registered on `t.after()` when `t` is provided.
- `request(app, path, opts)` — HTTP request to the fixture. Supports `method`, `headers`, `body`.
  Returns `{ status, headers, body, json }`.
- Test agent at `tests/e2e/helpers/test-agent.js` — contract-faithful stub that echoes user
  text as streamed tokens via `emitter.send()`. Supports configurable delay and abort.

### Fixture files

| File | Purpose |
|------|---------|
| `tests/e2e/fixtures/real-app-server.js` | Child-process entrypoint (imports `createApp`) |
| `tests/e2e/helpers/real-app-helper.js` | `startRealApp()`, `request()` |
| `tests/e2e/helpers/test-agent.js` | `createTestAgent(opts)` — stub agent |

### Test files

| File | Tests | Coverage |
|------|-------|----------|
| `tests/e2e/real-app/real-app-http.test.js` | 9 | HTTP middleware, headers, limits, Host guard |
| `tests/e2e/real-app/real-app-persistence.test.js` | 6 | Memory import, settings, export, restart |
| `tests/e2e/real-app/real-app-ws.test.js` | 8 | Handshake, chat streaming, stop, concurrency |
| `tests/e2e/real-app/real-app-security.test.js` | 12 | Auth, WS auth, cookies, traversal, Origin |
| `tests/e2e/real-app/real-app-lifecycle.test.js` | 9 | SIGTERM, restart, hermetic, CI scripts |

Key patterns: WebSocket tests correlate by `turnId` and wait for `turn_complete`,
not `stream_end`. Persistence tests use UUID-markers to identify test data.
Security tests use separate fixtures with/without `APERIO_AUTH_TOKEN`.

Environment: `NODE_ENV=test` must be set for all tests. Real-app tests require
no `.env`, API key, model binary, Docker, or network access when run with
`EMBEDDING_PROVIDER=none` and the injected test agent.
