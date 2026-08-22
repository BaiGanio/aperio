# Unit Tests

Pure logic. No filesystem, no network, no databases, no child processes.

## What belongs here

- Pure functions — input in, output out, no side effects
- Parsing / formatting (string manipulation, date formatting, etc.)
- Validation logic, config resolution, combinator functions
- Tests that run in <5ms and never flake

## What does NOT belong here

- Any `import` of a module with side effects (Express Router, DB adapters, store)
- Any `fs`, `path`, `os`, `child_process`, or `http` import
- Any test that needs `mockDB.js`, `mockStore.js`, or temp directories

## Running

```bash
npm run test:unit
```
