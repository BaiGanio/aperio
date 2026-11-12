# check-me

Things to look at later. Delete an entry when it is fixed or becomes an issue.

## Tests

- **2026-11-12 — flaky timing test.** `tests/store/memory-search.test.js`, "10 000 rows: hybrid top-5
  search max <= 50 ms over 120 runs". Failed once in `npm test` (during S2.10), passed on the next 2 runs.
  Failed again 2026-11-13 in `npm run check` (S2.14): max 50.18 ms; green alone and on the re-run.
  Failed again 2026-11-13 in `npm run check` (S3.0): max 52.10 ms; green alone and on the re-run.
  A max-latency bar on a shared machine. Check: is the 50 ms bar too tight, or is there a real slow outlier?

## Context / provider

- **2026-11-13 — the answer reserve is not enforced.** S2.13 keeps `CONTEXT_OUTPUT_RESERVE` (2048) tokens free
  for the answer, but `src/providers/chat-provider.js` never sends `max_tokens`. A long answer can still run past
  n_ctx; the budget only protects the prompt side. Fix idea: send `max_tokens = CONTEXT_OUTPUT_RESERVE` on every
  request (a body field, not prefix bytes, so KV reuse is untouched). Needs a small spec change (S2.5 / S2.13)
  and a test that the field is on the wire.

## Dependencies / ledgers

- **2026-11-13 — `express` is a dependency but nothing in v2 imports it.** S2.14 serves files with plain
  `node:http` (spec §4.2: no helmet, one header). "Delete before you add": drop `express` from `package.json`?
  It is outside the S2.14 spec, so it was not removed.
- **2026-11-13 — stale "hash pending" in the feature ledger.** The Agent & Reasoning row says S2.13 turn budget
  "hash pending", but S2.13 is committed (`9c939b49`). The S2.14 cells also say "hash pending" until commit.

## UI (S3.0)

- **2026-11-13 — `http-guard.js` ledger row says "— (S3.0)", but the S3.0 spec does not cover it.** v1 used it
  to add `X-Aperio-Client` + a Bearer token to every `fetch`. v2 has no `fetch` and no `/api` yet; the socket has
  the Origin check. Move the row to the step that adds the first HTTP call, or mark it `never`?
- **2026-11-13 — `parseServerFrame` size cap is 16 MiB** (`DEFAULT_MAX_SERVER_FRAME_BYTES`), my pick; the spec
  names no number. A `memories` frame (1000 rows × 16 KiB content) can come close. Check when S3.4 lists memories.
- **2026-11-13 — TypeScript 7.0.2** (the native Go `tsc`) was the current version; it installs a per-platform
  binary package (~377 lockfile lines). Check CI on Linux runs `npm run typecheck` green.
