# Testing

Uses Node.js native test runner (`node --test`). Tests are organized into three tiers
under `tests/unit/`, `tests/integration/`, and `tests/e2e/`.

## Test Tiers

### Unit (`tests/unit/`)
- Pure functions — input in, output out, no side effects
- No `fs`, `path`, `os`, `child_process`, `http` imports
- No mock of external modules (mock of function arguments OK)
- Runs in <5ms per test
- ~103 files covering parsing, formatting, validation, config resolution

### Integration (`tests/integration/`)
- Module wiring — Express Router, mock stores, DB adapters, temp files, real crypto
- May import real modules, use mock stores, invoke Express Router directly
- Must NOT bind a TCP port or spawn a server process
- Runs in <500ms per test
- ~89 files covering routes, DB, store, MCP, skills, handlers, context, tools, agents, workers
- Uses `tests/mockDB.js` and `tests/mockStore.js` as shared helpers

### E2E (`tests/e2e/`)
- Spawned server process, real HTTP/WS connections, real ports
- May start real Express + WebSocket server as a child process
- Runs in <30s per test
- ~10 files covering WebSocket lifecycle, streaming, config provenance, real-app fixtures

## Commands

```bash
npm test                       # All tests (unit + integration + e2e)
npm run test:unit              # Unit tests only (tests/unit/)
npm run test:integration       # Integration tests only (tests/integration/)
npm run test:skills            # skills integration tests
npm run test:store             # store integration tests
npm run test:memory            # tools memory unit tests
npm run test:execution         # Skill execution integration tests
npm run test:backfill          # Embedding backfill integration tests
npm run test:e2e               # All E2E tests (protocol + real-app)
npm run test:e2e:real          # Real-app E2E tests only (no mock fixtures)
npm run test:e2e:ci            # Dashboard E2E tests (excludes real-app)
npm run test:ci                # CI mode with coverage (unit + integration)
npm run test:ci:unit           # Unit tests CI (no coverage, fast gate)
npm run test:ci:integration    # Integration tests CI with c8 coverage
npm run test:only -- --test-name-pattern="pattern"  # Filter by name
npm run coverage               # Generate lcov report from c8
npm run integration:dashboard  # Generate integration test dashboard data
npm run e2e:dashboard          # Generate E2E test dashboard data
```

The primary Codecov workflow runs `test:ci:unit` (fast gate, no coverage),
`test:ci:integration` (c8 coverage + dashboard data), and the non-real E2E
dashboard suite as separate jobs. Pushes and pull requests therefore refresh
coverage, integration dashboard, and E2E dashboard data without starting real
server fixtures. Run the
separate **Real-app E2E (manual)** GitHub Actions workflow when production-
process validation is needed. Its concurrency is capped at 2 and it does not
require a model service; Postgres parity remains opt-in through
`APERIO_E2E_POSTGRES_URL`.

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
- `tests/reporters/integration-json.js` — structured JSON reporter for integration dashboard.
  Usage: `node --test --test-reporter=./tests/reporters/integration-json.js
  --test-reporter-destination=integration-results.json`
- `scripts/generate-integration-dashboard.js` — converts reporter JSON to `docs/integration-data.js`.
  Run: `npm run integration:dashboard`
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
import { startRealApp, request } from "./helpers/real-app-helper.js";

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
| `fixtures/real-app-server.js` | Child-process entrypoint (imports `createApp`) |
| `helpers/real-app-helper.js` | `startRealApp()`, `request()` |
| `helpers/test-agent.js` | `createTestAgent(opts)` — stub agent |

### Test files

| File | Tests | Coverage |
|------|-------|----------|
| `real-app-char.test.js` | 6 | Architecture, port-0, path audit |
| `real-app-http.test.js` | 9 | HTTP middleware, headers, limits, Host guard |
| `real-app-persistence.test.js` | 6 | Memory import, settings, export, restart |
| `real-app-ws.test.js` | 8 | Handshake, chat streaming, stop, concurrency |
| `real-app-security.test.js` | 12 | Auth, WS auth, cookies, traversal, Origin |
| `real-app-lifecycle.test.js` | 9 | SIGTERM, restart, hermetic, CI scripts |

Key patterns: WebSocket tests correlate by `turnId` and wait for `turn_complete`,
not `stream_end`. Persistence tests use UUID-markers to identify test data.
Security tests use separate fixtures with/without `APERIO_AUTH_TOKEN`.

Environment: `NODE_ENV=test` must be set for all tests. Real-app tests require
no `.env`, API key, model binary, Docker, or network access when run with
`EMBEDDING_PROVIDER=none` and the injected test agent.
