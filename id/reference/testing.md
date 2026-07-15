# Testing

Uses Node.js native test runner (`node --test`). Tests mirror the source structure under `tests/`.

## Commands

```bash
npm test                       # All tests
npm run test:skills            # skills/*.test.js
npm run test:store             # store/*.test.js
npm run test:memory            # tools/memory.test.js
npm run test:execution         # Skill execution tests only
npm run test:backfill          # Embedding backfill tests only
npm run test:e2e               # All E2E tests (protocol + real-app)
npm run test:e2e:real           # Real-app E2E tests only (no mock fixtures)
npm run test:ci                # CI mode with coverage
npm run test:only -- --test-name-pattern="pattern"  # Filter by name
npm run coverage               # Generate lcov report from c8
```

## Test Helpers

- `tests/mockDB.js` — in-memory SQLite store for tests
- `tests/mockStore.js` — mock store factory
- `tests/reporters/quiet.js` — CI reporter (used when `APERIO_AGENT_RUN` is set)
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
