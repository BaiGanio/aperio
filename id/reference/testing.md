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
npm run test:e2e               # e2e/*.test.js
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

Environment: `NODE_ENV=test` must be set for tests.
