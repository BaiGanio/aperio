# Integration Tests

Module wiring. Mock stores, Express Router, temp files, real crypto — but no server process.

## What belongs here

- Express Router tests with mock `req`/`res` (no port binding)
- Store/DB adapter tests with real temp files or in-memory backends
- MCP tool tests with mock store
- Skill loader tests with real filesystem reads
- Context assembly, agent orchestration with mock dependencies
- Any test that uses `mockDB.js` or `mockStore.js`

## What does NOT belong here

- Tests that bind a TCP port or spawn a server process → `tests/e2e/`
- Pure function tests with zero I/O → `tests/unit/`
- Tests that need a running database or external service → `tests/e2e/`

## Running

```bash
npm run test:integration
npm run test:ci:integration  # with c8 coverage
```

## Helpers

- `tests/mockDB.js` — lightweight in-memory database mock
- `tests/mockStore.js` — store mock for tools/handlers tests
