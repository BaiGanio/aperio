# check-me

Things to look at later. Delete an entry when it is fixed or becomes an issue.

## Tests

- **2026-11-12 — flaky timing test.** `tests/store/memory-search.test.js`, "10 000 rows: hybrid top-5
  search max <= 50 ms over 120 runs". Failed once in `npm test` (during S2.10), passed on the next 2 runs.
  A max-latency bar on a shared machine. Check: is the 50 ms bar too tight, or is there a real slow outlier?

## Context / provider

- **2026-11-13 — the answer reserve is not enforced.** S2.13 keeps `CONTEXT_OUTPUT_RESERVE` (2048) tokens free
  for the answer, but `src/providers/chat-provider.js` never sends `max_tokens`. A long answer can still run past
  n_ctx; the budget only protects the prompt side. Fix idea: send `max_tokens = CONTEXT_OUTPUT_RESERVE` on every
  request (a body field, not prefix bytes, so KV reuse is untouched). Needs a small spec change (S2.5 / S2.13)
  and a test that the field is on the wire.
