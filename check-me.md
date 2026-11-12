# check-me

Things to look at later. Delete an entry when it is fixed or becomes an issue.

## Tests

- **2026-11-12 — flaky timing test.** `tests/store/memory-search.test.js`, "10 000 rows: hybrid top-5
  search max <= 50 ms over 120 runs". Failed once in `npm test` (during S2.10), passed on the next 2 runs.
  A max-latency bar on a shared machine. Check: is the 50 ms bar too tight, or is there a real slow outlier?
