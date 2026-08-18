# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## Unreleased

### Added

- **Document-intelligence: a deterministic guard against blending currencies
  in a final answer.** Rewording `SKILL.md`'s "never blend, never convert"
  rule twice was measured, live, to not be enough — a model that got every
  per-currency line right still added a "Grand total" summing BGN and EUR
  into one number. `verifyCurrencyClaims()` now checks the model's own
  final answer after the fact: when a parenthetical breakdown's amounts,
  tagged with two or more different currency codes, arithmetically sum to
  the number in front of it, it appends a correction telling the model (and
  the user) to disregard that total — the same non-blocking pattern already
  used for hallucinated file-deliverable claims.

- **Landing page: the 75 flip-card prompt keys are now translated in all 25
  non-English locales.** `tool_*_prompt`, `team_*`, and `flip_*` keys
  (`docs/locales/*.json`) previously existed only in English and silently fell
  back for every other language; a Bulgarian or German visitor flipping a card
  saw an English prompt regardless of their selected locale. All 25 locale
  files now carry translated values for these keys, verified against
  `en.json`'s key set (0 missing, 376 keys per locale) and the existing
  `locale-drift-sync` test suite.

- **Document-intelligence: a rule against counting one payment twice.** The
  skill told the model how to read, aggregate and persist documents, but never
  that one economic event is often documented more than once — the same receipt
  saved as both a text file and a scan, or a receipt and the bank-statement row
  for that same purchase. `doc_batch`'s `aggregate` merges those, but the moment
  the model hand-builds rows for an `INSERT` it re-derives from the raw documents
  and the merge is gone. The new guidance names both shapes, states the harder
  half — equal amounts never establish duplication, and neither does the same
  merchant on the same card, so two fills at one petrol station on different
  dates stay two purchases — and ends with a check that costs nothing:
  reconcile per-category totals against `aggregate` before proposing the write.

### Security

- **Rewrote git history to remove a stale `audit/` tree and old build renders.**
  `master`'s history on GitHub no longer contains `audit/` (superseded findings,
  including one naming an unpatched issue by exact file:line), `manual/preview-output`,
  or `output/pdf` — cutting a fresh clone from ~650 MB to ~62 MB. This is a
  history rewrite: **anyone with an existing clone must re-clone** (`git pull`
  will not work against the new history). Forks and clones made before this
  change still hold the old files — the rewrite only stops new clones from
  receiving them going forward. See `SECURITY.md`.

### Fixed

- **Foreign-currency travel documents (a train ticket, a hotel bill, an
  airport receipt) had no category at all.** `CATEGORY_RULES`
  (`lib/docgraph/facts/contract.js`) covered Bulgarian and English household
  spending only, so a German train ticket, a German hotel bill and a French
  airport receipt all fell into `Uncategorized` — one of them even mis-scored
  as `Dining` on the word "café" alone. A new `Travel` category with English/
  German/French patterns (ticket, flight, hotel/hôtel, Reise, Fahrkarte,
  Flughafen, Unterkunft, voyage, aéroport) now resolves all three correctly,
  without competing with the existing local-transit-card pattern under
  `Transport`.

- **A failed Node.js, dependency-install, or llama.cpp-engine setup step left
  its own status tile stuck on "running" forever.** Only the model-download
  and SQLite-bindings steps ever marked themselves `error` on failure; the
  other three caught nothing locally, so a failure there was still reported
  (the wizard's overall error event still fired), but the specific tile the
  user was watching never showed which step actually broke. Each of the
  three now follows the same catch → mark-error → rethrow pattern the other
  two already used. Caught by this session's own bootstrap-contract audit
  gate (`audit/scripts/bootstrap-contract.js`), which now reconciles clean.

- **A document naming "café" was never categorized as Dining.** The Dining
  rule's `/\bcafé\b/i` pattern could never match the word "café" itself —
  `\b` treats accented letters as non-word characters, so the trailing
  boundary demanded a word character right after the "é", matching only the
  plural "cafés" instead. Fixed with a Unicode-aware lookahead so "café",
  "Café du Terminal", and "CAFÉ" all resolve to Dining, same as the
  unaccented spelling always did.

- **`docker/docker-compose.prod.yml` broke first boot against a fresh
  database.** It mounted `../db/migrations` into Postgres' own
  `/docker-entrypoint-initdb.d`, so a brand-new volume applied the schema
  as raw, unbookkept SQL; the `aperio` service's own migration runner then
  tried to reapply `001_core.sql` on its first request and failed with
  "already exists". The mount is removed — the app already runs migrations
  itself on startup (`db/postgres/store.js`'s `PostgresStore.init()`), the
  same single source of truth the dev Compose file already relied on.
  Verified live against a fresh, isolated volume: all 14 migrations apply
  cleanly on first boot, and a container restart correctly reports nothing
  pending.

- **Windows CI reported the whole test suite green while running zero tests.**
  `package.json`'s `test`/`test:ci` family built its file list with
  `$(find ... -print)` and set `NODE_ENV` via a `VAR=value cmd` prefix — both
  bash syntax that npm's default Windows script-shell (`cmd.exe`) cannot parse.
  On Windows the glob resolved to nothing, `node --test` matched zero files,
  and the step exited in ~1s reporting success instead of running the ~2-3 min,
  5000+ test suite every other platform ran. A new `scripts/run-tests.js`
  resolves the file list and sets `NODE_ENV` in plain JS instead, so the
  scripts behave identically on every platform, and it now refuses to report
  success when it finds zero test files.

- **A malformed tool call told the model what failed but never why.** When a
  model's arguments arrive from a parse that lost sync, the argument *values*
  end up folded into a key name — so the real parameter is simply absent and the
  tool reports it missing. Two things made that unrecoverable. The schema check
  reported the debris as a hallucinated parameter, which is both wrong and
  expensive: a single call wrote kilobytes of half-parsed payload into the
  repair ledger and back into the model's context. And the pointed correction
  was suppressed for destructive tools, conflating two different guards —
  refusing to *repair* malformed arguments for those tools is a corruption guard
  and is unchanged, but declining to *explain* a failure protects nothing.
  Debris is now classified as its own kind, carrying only a length rather than
  the payload, and the correction names the tool's real parameters once for the
  whole group. Observed against a recorded run where the same malformed
  statement was retried three times under a bare "`sql` is required".

- **The reasoning toggle was labeled "Enable/Disable reasoning" but only ever
  hid or showed the reasoning bubble in the browser** — it was never passed
  into the agent or provider request, so switching it off did not stop a
  model from thinking or save any latency/tokens. Relabeled to "Show/Hide
  reasoning" (English and all 24 locales) to match what it actually does.
  Real per-provider reasoning-effort control is tracked separately as
  [#476](https://github.com/BaiGanio/aperio/issues/476).

- **A stuck llama.cpp/Ollama connection could hang a turn forever.** The
  streaming response reader had no deadline at all past the initial HTTP
  headers — `LLAMACPP_FETCH_TIMEOUT_MS` only bounded time-to-first-byte, so a
  server that stopped responding mid-stream (crashed slot, dead connection)
  left the turn waiting indefinitely with no error and no retry. Verified live
  against llama-server that a long prefill is not actually silent — it sends a
  3-byte SSE keep-alive ping roughly every 30s until the first token — so a
  per-read idle timeout (`LLAMACPP_STREAM_IDLE_TIMEOUT_MS`, default 120s) can
  safely catch a genuinely dead connection without ever tripping during a
  legitimate multi-minute prefill.

- **`db_execute` told models a connection was "named undefined" when they had
  named none.** A proposal missing the `connection` argument fell through to the
  connection lookup, whose error interpolated the raw argument — so the model was
  told `no connection named "undefined"`, asserting it had named a connection it
  had not. Two local models each burned a whole turn re-emitting the identical
  malformed call against that message. The propose path now requires
  `connection` explicitly and says what to pass (`extraction` for data extracted
  from documents, `db_connections` to list what exists), and the lookup error
  reports the name actually looked up rather than the raw argument.
