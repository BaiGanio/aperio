# Document Intelligence — WS0-R Evidence

This file records privacy-safe execution evidence for WS0-R. It contains no
household document text, oracle values, fixture paths, model output, or private
runtime logs.

The harness writes a fresh run file, overwriting—not appending to—the ignored
`document-intelligence-run-answers.json` artifact after each completed prompt and
during cleanup. That artifact intentionally stores the full prompt text, prompt labels,
timing, tool sequences, statuses, raw model answers, and the `expected` gate values so
the next run can be adjusted from observed behavior. It is diagnostic run output, not
ground truth, and must not be committed or used as a model-readable oracle.

## T-R0 red baseline — 2026-07-23

- Source snapshot: `b1edb7cf18ff28a0f4b807ebb8a8876922e9ba38`
- Oracle: withheld and not copied into the model-readable workspace.
- Runtime: no server, MCP process, model process, port, database, or temporary
  workdir was started by this routing reproduction.
- Reproduction method: pure routing classification of the three red prompts,
  with prompt text retained only as the plan-defined labels P1/P2/P3.

| Prompt | `docgraph` profile | `doc_repos` preflight intent | Red observation |
|---|---:|---:|---|
| P1 bare utilities | no | no | only memory/data/self profiles are selected |
| P2 explicit folder/monthly total | no | no | filesystem-project profile is selected; document graph is absent |
| P3 maximally steered | yes | yes | retrieval is reachable only after naming the tools |

Conclusion: the current classifier/preflight path does not make unknown-location
document retrieval available for ordinary money questions. This confirms the
routing failure before retrieval changes and establishes T-R0 red.

## T-R1 trace/design status

The current seam is the document graph read API: inventory is repo-level, search
is passage-level, and context is single-chunk/section-level. WS0-R added a
bounded manifest and batch read contract at that seam, with explicit limits,
per-file status, and abort propagation.

## T-R2–T-R4 implementation evidence — 2026-07-23

- Unit retrieval contract: pass — deterministic manifest, empty/multi-source
  behavior, deduplication, explicit limits, bounded batches, accounting, and
  abort between batches.
- SQLite docgraph integration: pass — manifest discovers/bounds candidates and
  batch reads return complete coverage on the fixture backend.
- Routing/preflight: pass — bare aggregation questions select `doc_manifest`
  and `doc_batch`, and preflight executes one manifest followed by one batch.
- Native vision contract: pass at automated seam level — inline task-shaped
  requests remove image-reading tools for native-vision models and add an
  explicit no-preprocess instruction; generic image bridge tests remain green.

## T-R5 honest-corpus gate — failed 2026-07-23

- Harness: direct production composition root, scratch SQLite, two copied
  fictional indexed folders, non-default HTTP/llama ports, oracle withheld.
- P1: completed in approximately 122 seconds; the harness did not persist the
  answer body, so no exact-total claim is made here.
- P2: timed out at the 180-second acceptance budget while the model was still
  processing the bounded retrieval result.
- P3: not started after the P2 timeout, as required by the stop rule.
- Teardown: graceful shutdown stopped llama.cpp; scratch workdir and DB were
  removed by the harness. No oracle or real household path was sent to the
  model.

Exact failure: the bounded retrieval contract prevents the previous 573k-byte
whole-corpus offload, but the full-month question still does not converge within
180 seconds. WS0-R is not green and WS1/extraction-template plumbing must not
start.

## Gate status

WS0-R is not green: T-R5 failed at P2. Do not begin WS1 or extraction-template
plumbing.

## WS1 — writable destination — implemented and tested 2026-08-01 (T-G1.1–T-G1.4)

WS0-R's T-R5 gate passed on the local hero model (Gemma 4 E4B) the same day (see
below), unblocking WS1. Destination decision: **preferred** option taken — Aperio
provisions a clearly named user extraction database on first use, behind the
already-existing `db_execute` confirm-before-write boundary, rather than the
Settings-UI fallback. Rationale: `db_execute`, `db_query`, `db_normalize_amount` and
the two-phase confirm flow already existed (issue #170, plus locale-normalization
landed early under a prior session's "ai leftovers" commit `01c545c`); the only real
gap was that a clean profile has no writable connection at all and WS1 explicitly
forbids hand-edited config. `extraction` is now a reserved connection name:
referencing it in `db_execute` on a profile where it is not yet configured is not
treated as an unknown-connection error — the propose step discloses that a new
personal SQLite database will be created, and provisioning happens exactly once,
at confirmed-commit time (never at propose or decline). Declining creates nothing;
re-confirming a second write against the name reuses the same connection
(already-provisioned is a no-op, not an error).

- `lib/db-connect/extraction.js` (new) — `provisionExtractionConnection()`,
  idempotent, modeled on the existing `sample-db.js` pattern (file placed next to
  the app's own SQLite store via `SQLITE_PATH`, registered through
  `saveConnections()`). Owns only the connection's existence — table/column
  names belong to whoever calls `db_execute`, so "schema is user-selected or
  provisioned, never path-derived" holds because nothing here ever reads a
  document path.
- `lib/handlers/database/databaseHandlers.js` — `validateExecutionArgs` special-cases
  the reserved, not-yet-configured `extraction` name; `proposeAction`'s summary
  discloses the pending creation; `executeTool` provisions immediately before the
  confirmed write runs. The built-in `aperio` connection's read-only resolution in
  `registry.js` is untouched and was re-verified under the new tests.
- `mcp/tools/database.js` — `db_execute`/`db_connections` tool descriptions updated
  so the model can discover and use `extraction` without any Settings UI step.
- T-G1.3 (locale normalization) and most of T-G1.2/T-G1.4's generic SQL round-trip
  were already covered by the prior session's `lib/handlers/database/amounts.js`
  (`normalizeAmount` / `db_normalize_amount`) and its existing tests; this pass adds
  the missing clean-profile provisioning piece and closes out the T-G1 edge cases
  end to end.

Tests (all new, all green):
- `tests/unit/db-connect/extraction.test.js` — 8 tests, zero real filesystem access
  (same mocking technique as `sample-db.test.js`): path derivation, idempotent
  provisioning, directory/file creation, preserves other connections.
- `tests/integration/handlers/database-confirm.test.js`, new describe block
  "WS1 writable destination — clean-profile provisioning" — 10 tests against the
  real confirm-flow/SQLite stack in an isolated tmp `SQLITE_PATH` per test:
  clean-profile connection listing, built-in `aperio` rejects writes by name,
  propose discloses creation without provisioning, decline provisions nothing,
  confirm provisions once and `aperio` stays read-only after, re-confirm reuses
  the same connection (already-exists), append-and-round-trip across two
  extractions, duplicate `source_hash` surfaced as a clear constraint error (not
  silently deduplicated or accepted), field drift on a later extraction surfaced
  as a clear error (not a silent partial write), and mixed BGN/EUR rows aggregated
  into separate per-currency `SUM()` totals with no blended figure — structurally
  guaranteed because no row/column in the schema ever carries an exchange rate.
- Full suites re-run clean: `npm run test:unit` 2404/2404, `npm run test:integration`
  2402/2402.

T-G1.4's "response states no conversion was applied" and "a model-volunteered FX
rate is a hard fail" are behavioral assertions against the model's own final
answer and belong to the S2/WS4 hero-model gate (T-G6), not a WS1 unit test; they
are structurally supported here by the extraction schema never carrying a rate
column and `normalizeAmount` never converting currencies — verified above.

No new `lib/config.js` key was needed: the extraction file path reuses the
already-registered `SQLITE_PATH`, exactly as `sample-db.js` already does.

WS2 (skill), WS3 (migrations/handlers/MCP templates) and WS4 were not started, per
scope.

### Review fixes — 2026-08-01 (same day)

Two P1/P2 findings from review, both fixed and tested:

- **P1 (data loss under the supported Postgres deployment).** `extractionDbPath()`
  derived its location from `SQLITE_PATH`'s directory, which is unset and
  irrelevant when `DB_BACKEND=postgres` — the supported production Compose file
  (`docker/docker-compose.prod.yml`) persists only `aperio_var:/app/var`, so the
  extraction file would live outside any persisted volume and vanish on container
  recreation while the connection row survived in Postgres, pointing at a file that
  no longer existed. Fixed: the path is now fixed under the app's own `var/`
  directory, computed from the module's own location exactly the way
  `lib/db-connect/secrets.js` already does for its machine-local key — no env
  dependency, no new `lib/config.js` key, matches the one durable volume the
  deployment actually mounts.
- **P2 (reserved name not actually reserved).** `findExtractionConnection` matched
  by name only, so a pre-existing or headlessly-seeded (`DB_CONNECTIONS` env)
  connection that happened to be named `extraction` would be silently treated as
  the managed destination: if writable, document rows would land in an unrelated
  user database; if read-only, self-provisioning would appear blocked behind a
  misleading "turn off its read-only flag" message. Fixed: the connection row now
  carries a `provisioned: true` marker written only by
  `provisionExtractionConnection()`, and both `findExtractionConnection` and
  `validateExecutionArgs` require it — a same-named row lacking it is a collision,
  rejected with an explicit "reserved name" error rather than reused, redirected
  into, or mistaken for a block. Also added `extraction` to the UI-level reserved-name
  guard in `lib/routes/api-database.js` (alongside `aperio`) so the collision can no
  longer be created through Settings going forward.

Tests updated/added for both fixes: `tests/unit/db-connect/extraction.test.js` (12
tests — path no longer varies with `SQLITE_PATH`, collision rejection on both
`findExtractionConnection` and `provisionExtractionConnection`, read-only and
writable collision variants) and two new cases in
`tests/integration/handlers/database-confirm.test.js`'s WS1 describe block (26
tests total in that file) exercising the collision end to end through
`db_execute`. Per-test isolation switched from a SQLITE_PATH swap to deleting the
real (now-fixed-path) `var/extraction.db` before/after each test, since the path
is no longer test-parameterizable by design (that was the point of the fix).
Full suites re-verified clean after the fix: `npm run test:unit` 2408/2408,
`npm run test:integration` 2404/2404. No stray files left in the repo tree.

### Review fixes, round 2 — 2026-08-01 (same day)

Two more P1 findings from a second review pass, both on the round-1 fix itself:

- **P1 (cross-profile data sharing).** The round-1 fix moved the extraction file
  under a fixed path in the app's own `var/` directory — durable, but a single
  fixed path for the whole installation. Two Aperio profiles sharing one code
  checkout (separate installs, or separate `SQLITE_PATH`/`DATABASE_URL` configs)
  would resolve to the exact same file and could read or overwrite each other's
  extracted documents. Fixed: the filename is now namespaced by a hash of the
  live store's OWN resolved identity — `store.db.name` (the real sqlite file
  path) for the sqlite backend, `store.pool.options.connectionString` for
  Postgres — the same `store.db`/`store.pool` duck-typing
  `lib/db-connect/drivers/aperio.js` already uses to answer "which real database
  is this profile talking to". Hashed (SHA-256, truncated), never embedded raw,
  since a Postgres connection string carries its password. Two profiles now
  reliably resolve to two different files under `var/extraction/`; one profile
  restarted (same identity) still resolves to the same file, so durability from
  the round-1 fix is unaffected. `extractionDbPath()` and
  `provisionExtractionConnection()` both now take `store` as a required
  parameter — the one production call site (`databaseHandlers.js`'s propose
  summary) was updated to pass `ctx.store`.
- **P1 (tests could delete real user data).** The round-1 integration tests'
  `beforeEach`/`afterEach` called `rmSync(extractionDbPath())` — a hardcoded,
  no-argument path — before and after every test, in a checkout that could
  contain a real developer's actual extraction data at that same path. Fixed
  structurally: `extractionDbPath()` now requires a `store` argument, so it is
  no longer possible to compute "the" path without deliberately supplying an
  identity. Every test now uses its own fresh, random, synthetic identity
  (`test-profile:<random-hex>`, a shape no real `SqliteStore`/`PostgresStore`
  could ever produce) and cleanup removes only the exact file that test's own
  identity resolved to — never a fixed or shared path. A dedicated sentinel
  test creates a file for a separate, unrelated synthetic profile before any
  test in the suite runs, and asserts it is byte-for-byte unchanged after every
  test has finished — proof, not just assertion, that the suite cannot reach a
  file it did not itself create. Verified the sentinel actually catches a
  regression (not a no-op check): temporarily reintroduced the identity
  collision by hand, reran, watched the sentinel test fail (the file was
  deleted out from under it, exactly the round-1 failure mode), then restored
  the real fix and reran clean.

Tests: `tests/unit/db-connect/extraction.test.js` grew to 17 (added multi-profile
isolation cases — two sqlite profiles, two postgres profiles, stability across
repeated calls, no raw connection string ever embedded in the path).
`tests/integration/handlers/database-confirm.test.js`'s WS1 block stayed at 12
tests with all identity plumbing reworked, plus the sentinel `before`/`after`
pair. Full suites re-verified clean: `npm run test:unit` 2413/2413,
`npm run test:integration` 2404/2404. No stray files or directories left in the
repo tree (`var/extraction/` is removed by the sentinel's `after()` once empty;
confirmed via `git status` and a directory listing after the run).

### Review fixes, round 3 — 2026-08-01 (same day)

Three more findings from a third review pass:

- **P1 (bypassed at-rest encryption).** `provisionExtractionConnection` opened a
  plain `better-sqlite3` file directly, so `APERIO_DB_ENCRYPT=1` had no effect on
  extracted bills/receipts/statements even though it fully protects the app's own
  store. Fixed with a new `lib/db-connect/drivers/managed-sqlite.js`:
  `createManagedSqliteFile`/`openManagedSqlite` reuse `db/encrypt.js`'s existing
  AES-256-GCM lifecycle (`prepareDatabase`/`finalizeDatabase`/`encryptFile`) —
  decrypt-to-scratch-temp on open, re-encrypt-and-remove-temp on close — scoped
  only to connections carrying the `provisioned` marker (`registry.js`'s
  `openDriver` routes on that flag, never touching a user's own external sqlite
  file). The resolved key is cached at module scope (`managedEncryptionKey()`) so
  a keychain shell-out happens at most once per process, not once per
  db_execute/db_query call. Found and fixed a real bug while wiring this up: a
  brand-new `better-sqlite3` database that is opened and closed without ever
  writing to it is a genuine 0-byte file on disk (SQLite defers its header page
  until the first write transaction) — encrypting that 0-byte scratch file made
  `prepareDatabase`'s own magic-header verification fail on every subsequent
  open with "Decrypted file is not a valid SQLite database". Fixed by forcing a
  real header write (`db.pragma("user_version = 0")`) before the scratch file is
  read and encrypted.
- **P2 (in-memory profiles share data).** `SQLITE_PATH=:memory:` is a supported
  configuration (`db/sqlite/store.js`), and every such store's `store.db.name` is
  the literal string `":memory:"` — the profile-identity hash from the prior
  round's fix would therefore collapse every separate in-memory profile onto the
  same persisted extraction file. Fixed: `:memory:` is special-cased to a random,
  module-load-scoped identity (`IN_MEMORY_PROCESS_TAG`) — stable for the lifetime
  of one running profile (so writes/reads still round-trip normally within that
  run), but never shared with another run, verified via cache-busted dynamic
  re-imports simulating separate processes.
- **P2 (unusable Edit/Test controls).** Once provisioned, `listConnections()`
  already returns the extraction row's `provisioned: true` field (unchanged), but
  the Settings panel rendered ordinary Edit/Delete buttons for it — Edit (and Test,
  reachable only from inside the Edit form) always 400 because `validate()`
  rejects the reserved name. Fixed in `public/scripts/db-connections-panel.js`:
  a `provisioned` row now renders a "managed" badge instead of an Edit button
  (mirroring the existing built-in-`aperio` badge pattern) while keeping Delete —
  unlike the true built-in connection, this one holds the user's own data and
  they may reasonably want to remove it. `startEdit()` also gained a defense-in-
  depth guard. No backend response shape change was needed; `provisioned` was
  already there. Also added `extraction` to `api-database.js`'s reserved-name
  guard (alongside `aperio`) so the collision this whole chain of fixes exists
  for can no longer be created through Settings going forward.

Tests: `lib/db-connect/drivers/managed-sqlite.js` covered end-to-end by a new
`tests/integration/db-connect/extraction-encryption.test.js` (3 tests) — mocks
`execSync`/`execFileSync` before import exactly like the existing
`tests/integration/db/encrypt.test.js` does (never touches the real OS
keychain; verified afterward with a direct `security find-generic-password`
check — no stray entry). Confirms: the file is never plaintext immediately
after provisioning; a confirmed `db_execute` write leaves the on-disk file
non-plaintext and the content round-trips correctly through `db_query`; a
second write appends without corruption. `tests/unit/db-connect/extraction.test.js`
grew to 21 (added a 4-test in-memory-profile-isolation group, P2). Full suites
re-verified clean: `npm run test:unit` 2417/2417, `npm run test:integration`
2407/2407. No stray files, directories, or keychain entries left behind.

## T-R5 rerun — E2B Q4_K_XL, 300-second budget — failed 2026-07-23

- Harness: same isolated direct-composition-root run; scratch SQLite, 21 copied
  fictional documents across two folders, non-default ports, oracle withheld.
- Model: `unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL`.
- P1: completed in approximately 89 seconds; exact Utilities gate failed.
- P2: completed in approximately 201 seconds; exact full-month gate failed.
- P3: completed in approximately 111 seconds; exact full-month gate failed.
- Oracle exposure: pass. Corpus-fence check: pass.
- Teardown: graceful llama.cpp shutdown completed; scratch workdir/DB removed.

Exact failure: increasing the timeout and switching to E2B produced three
completed responses, but none contained the required exact totals/complete
category coverage. WS0-R remains not green; stop before WS1.

## T-R5 clarified-prompt rerun — failed 2026-07-23

- Prompts now specify 2026-05-01 through 2026-05-31 inclusive, date precedence,
  included categories, exclusions, deduplication, source-level reporting, and
  no-write behavior.
- P1: completed in ~59s; tools `doc_repos`, `doc_search`, `doc_search`; answer
  reported no matching utility data, so the Utilities exact-total gate failed.
- P2: completed in ~47s; tool `doc_repos` only; answer declined the analysis, so
  the full-month exact-total gate failed.
- P3: completed in ~207s; used `doc_repos`, `doc_manifest`, `doc_search`, and
  `doc_context`; answer reported only partial evidence and omitted required
  Groceries/Internet totals, so the full-month exact-total gate failed.
- Oracle exposure, corpus fence, teardown, and diff check passed.
- Raw answers were preserved in the ignored run artifact
  `document-intelligence-run-answers.json`; no handshake transport metadata is
  included.

## T-R5 June-prompt rerun — failed 2026-07-23

- P1, P2, and P3 all completed within the then-active 300-second timeout, in
  approximately 292s, 276s, and 259s respectively.
- All three turns invoked the bounded retrieval path: `doc_manifest` followed by
  `doc_batch`.
- The new P2 invocation check therefore passed; this run did not exhibit the generic
  refusal-without-retrieval failure mode.
- Exact Utilities, category, grand-total, coverage, and exclusion gates failed.
- Oracle exposure, corpus fence, and graceful teardown passed.
- The run was started before the artifact-schema update, so its JSON has the old
  300-second metadata and lacks the full `prompt`/`expected` fields. The harness is now
  configured for a fresh 180-second run file with those fields.

## T-R5 Gemma 4 E2B rerun — failed 2026-07-27

- Model: `unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL`; isolated scratch SQLite
  harness with dedicated HTTP/llama ports.
- The first attempt was infrastructure-only: llama-server could not bind its
  dedicated localhost port. The retry with local process/socket permission
  started successfully and is the measured result below.
- Corpus indexing: 18/18 primary documents and 1/1 secondary document.
- Retrieval: one `doc_batch`, full 47.3 KB coverage.
- P1: completed in 230.3s; category gate passed for Internet and Transport,
  but failed Fuel, Groceries, Utilities, and the grand total.
- EUR-travel exclusion, excluded-document leak, oracle exposure, and corpus
  fence checks passed.
- No timeout occurred; the run completed within the prior explicit 300-second
  budget. The harness default is now 600 seconds for future runs.
- Graceful teardown completed; scratch runtime data and model process were
  cleaned up.

## T-R5 Ornith 1.0 9B rerun — failed 2026-07-27

- Model: `protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M`; isolated scratch SQLite
  harness with the 600-second default timeout.
- llama-server loaded successfully; corpus indexing was 18/18 primary and 1/1
  secondary documents.
- Retrieval: one `doc_batch`, full 47.3 KB coverage.
- P1: completed in 292.5s; category gate passed Internet and Transport, but
  failed Fuel, Groceries, Utilities, and the grand total.
- The answer used the bank statement's 260.75 BGN total instead of the expected
  696.84 BGN; the statement-shortcut failure signature was detected.
- EUR-travel exclusion, excluded-document leak, oracle exposure, and corpus
  fence checks passed.
- Graceful teardown completed; scratch runtime data and model process were
  cleaned up.

## T-R5 Gemma 4 E4B rerun — PASSED 2026-08-01 (deterministic pipeline)

- Model: `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`; isolated scratch SQLite
  harness with dedicated HTTP/llama ports; oracle withheld; fixture set T-R5
  (2026-06). This is the first T-R5 live pass on a local model.
- Corpus indexing: 18/18 primary and 1/1 secondary documents; retrieval: one
  `doc_batch`, full 55.8 KB coverage; the turn invoked retrieval directly
  (`toolSequence: [doc_batch]`) and answered from the deterministic
  `aggregate` rather than free-form arithmetic.
- P1 (full-month question) completed in 372.6s, within the 600s budget.
- Gate: all checks pass — Utilities 260.50, Fuel 215.60, Groceries 140.75,
  Transport 50.00, Internet 29.99; grand total 696.84 BGN; EUR 196.40 reported
  separately; no failure signatures (no statement shortcut, no receipt↔statement
  double-count); no excluded leak; full per-event coverage; retrieval invoked;
  no oracle exposure; clean corpus fence.
- Teardown: graceful llama-server shutdown; scratch workdir/DB removed. The
  harness's fresh run record overwrote the tracked
  `document-intelligence-run-answers.json`; that file was restored to its
  committed state and is flagged in A2D as tracked against the plan's rule.

## T-R5 Gemma 4 E4B rerun — PASSED 2026-08-02 (second confirmation)

- Model: `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`; isolated scratch SQLite
  harness with dedicated HTTP/llama ports; oracle withheld; fixture set T-R5
  (2026-06). Second consecutive clean pass on the local hero model, run
  independently the day after the 2026-08-01 pass, before starting WS2.
- Corpus indexing: 18/18 primary and 1/1 secondary documents; retrieval: one
  `doc_batch`, full 55.8 KB coverage; single-turn retrieval
  (`toolSequence: [doc_batch]`).
- P1 completed in 278.1s, within the 600s budget.
- Gate: all checks pass — Utilities 260.50, Fuel 215.60, Groceries 140.75,
  Transport 50.00, Internet 29.99; grand total 696.84 BGN; EUR 196.40 (hotel,
  train, airport) reported separately and excluded from BGN spending; no
  failure signatures; no excluded leak; full coverage; no oracle exposure;
  clean corpus fence.
- Teardown: llama-server stopped gracefully, scratch workdir/DB removed. The
  harness again overwrote the tracked `document-intelligence-run-answers.json`;
  restored to its committed state via `git checkout --` (same friction already
  flagged in A2D.md 2026-08-01 — recommend untracking it).

## T-R5 Gemma 4 E4B rerun — failed 2026-07-27

- Model: `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL`; isolated scratch SQLite
  harness with the 600-second default timeout.
- llama-server loaded successfully; corpus indexing was 18/18 primary and 1/1
  secondary documents.
- Retrieval: one `doc_batch`, full 47.3 KB coverage.
- P1: completed in 278.1s; category gate passed Groceries, Internet, and
  Transport, but failed Fuel, Utilities, and the grand total.
- Fuel was attributed as 335.60 instead of 215.60; Utilities as 250.50
  instead of 260.50; the BGN total was 806.84 instead of 696.84. The separate
  196.40 EUR travel total was excluded correctly.
- EUR-travel exclusion, excluded-document leak, oracle exposure, and corpus
  fence checks passed.
- Graceful teardown completed; scratch runtime data and model process were
  cleaned up.

## T-R5 Gemma 4 26B A4B rerun — failed 2026-07-27

- Model: `unsloth/gemma-4-26B-A4B-it-qat-GGUF:Q4_K_XL`; isolated scratch SQLite
  harness with the 600-second default timeout.
- llama-server loaded successfully; corpus indexing was 18/18 primary and 1/1
  secondary documents.
- Retrieval: one `doc_batch`, full 47.3 KB coverage.
- P1: completed in 472.5s; category gate passed Groceries, Internet, Transport,
  and Utilities, but failed Fuel and the grand total.
- Fuel was attributed as 335.60 instead of 215.60; the BGN total was 816.84
  instead of 696.84. The separate 196.40 EUR travel total was excluded
  correctly.
- EUR-travel exclusion, excluded-document leak, oracle exposure, and corpus
  fence checks passed.
- Graceful teardown completed; scratch runtime data and model process were
  cleaned up.
