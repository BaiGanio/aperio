# Lite zip decoupling — tests

## Coverage map

| Plan step | Test group | Coverage |
|-----------|-----------|----------|
| Step 1 (redirect memory handlers) | T1: static import check | Confirms handlers no longer pull the Postgres barrel |
| Step 2 (lazy `PostgresStore` import) | T2: `db/index.js` import shape | Confirms no static top-level Postgres import remains |
| Step 3 (no other static importers) | T3: repo-wide importer sweep | Confirms the only remaining hit is tool-gated, not boot-path |
| Step 4 (`.github/zip-excludes.txt`) | T4: exclude-list content check | Confirms no stale/dead entries, all new dirs covered |
| Step 5 (wire CI to the file) | T5: workflow YAML check | Confirms `ZIP_EXCLUDES` env var removed, `-x@` wired |
| Step 6 (boot smoke test) | T6: end-to-end lite boot | The real proof — physically absent files, live boot, memory round-trip |
| Step 7 (Postgres regression) | T7: Postgres path unaffected | Confirms the refactor doesn't break the non-lite backend |

## Test cases

### T1 — memory handlers no longer import the Postgres barrel

**Input/setup:** repo checkout after Step 1's edit.

**Expected behavior:** `memoryHandlers.js` and `selfMemoryHandlers.js` import
`localeToPgConfig` from `db/postgres/mappers.js`, not `db/postgres.js`.

**Assertions:**
```
grep -rn "from ['\"].*db/postgres\.js['\"]" lib/handlers/memory/   # → no output
grep -rn "from ['\"].*db/postgres/mappers\.js['\"]" lib/handlers/memory/memoryHandlers.js lib/handlers/memory/selfMemoryHandlers.js   # → both files hit
```

**Edge cases:** confirm `db/postgres/mappers.js` itself still has zero `pg` import
(`grep -n "^import" db/postgres/mappers.js` shows only `../types.js`) — if this ever
changes, the whole decoupling premise breaks and the plan needs revisiting.

---

### T2 — `db/index.js` has no static Postgres import

**Input/setup:** repo checkout after Step 2's edit.

**Expected behavior:** `PostgresStore` is only referenced via `await import('./postgres.js')`
inside the `backend === 'postgres'` branch of `initBackend()`.

**Assertions:**
```
grep -n "^import.*PostgresStore" db/index.js   # → no output
grep -n "await import\(.\+postgres\.js.\+\)" db/index.js   # → one hit, inside initBackend
```
Run `node --check db/index.js` to confirm the file still parses as valid ESM after the
edit (dynamic import syntax errors are easy to introduce by hand).

**Edge cases:** `createVectorStore()` (line ~117) also calls `initBackend(resolveBackend())`
— confirm it still resolves correctly for both backends after the change, and note
whether it needs its own try/catch (see plan Risks table) even if out of scope to fix here.

---

### T3 — no other always-loaded module statically imports Postgres files

**Input/setup:** repo checkout after Steps 1–2.

**Expected behavior:** the only remaining static importer of `db/postgres.js` or
`db/postgres/*` outside `db/index.js` is `lib/db-connect/registry.js`, and that module is
reached only through an explicit `db_connect` tool invocation, never during server boot.

**Assertions:**
```
grep -rln "from ['\"].*db/postgres" lib/ mcp/ server.js bootstrap.js db/ | grep -v node_modules
# → expect exactly: db/index.js, lib/db-connect/registry.js (and its own drivers/*.js, which import registry.js's siblings, not db/postgres.js directly)
```
Trace `lib/db-connect/registry.js`'s importers (`lib/routes/api-database.js`,
`lib/handlers/database/databaseHandlers.js`) back to confirm they're only invoked on an
actual `db_connect` MCP tool call, not at module load / server startup.

**Edge cases:** if a new caller of `db/postgres.js` is added later without going through
this check, T6 (physical-absence boot test) is the real backstop — T3 is a fast sanity
pass, not the guarantee.

---

### T4 — `.github/zip-excludes.txt` content

**Input/setup:** file created in Step 4.

**Expected behavior:** one exclude pattern per line; covers every audited category; no
dead entries for paths that don't exist in the tracked tree.

**Assertions:**
- Contains: `.git/*`, `.github/*`, `node_modules/*`, `db/migrations/*`, `db/migrate.js`,
  `db/postgres.js`, `db/postgres/*`, `docker/*`, `docs/*`, `tests/*`, `audit/*`, `vms/*`,
  `k8s/*`, `scripts/*`, `integrations/*`, `trash/*`, `id/reference/*`, `id/audit/*`,
  `id/agent-rules/*`, `id/capability-tiers.md`, `.c8rc`, `.dockerignore`, `.gitignore`,
  `CONTRIBUTING.md`, `CHANGELOG.md`, `FEATURES.md`, `AGENTS.md`, `README.md`,
  `.env.example`, `how-to/*`.
- Does **not** contain: `.lancedb/*`, `lite/*`, `deno.json`, `deno.lock`, `dist/*`,
  `launchers/*`, `release_summary.txt`, `lite-progress.md` (all confirmed dead —
  `git ls-files | grep -c "^<path>"` returns 0 for each).
- Does **not** contain any path under `id/` other than `id/reference/*`, `id/audit/*`,
  `id/agent-rules/*`, `id/capability-tiers.md` — `id/whoami*.md`, `id/capabilities.md`,
  `id/self-nature.md`, `id/characters/*` must stay shippable (runtime-loaded).
- Does **not** contain any path under `db/` other than `db/migrations/*`, `db/migrate.js`,
  `db/postgres.js`, `db/postgres/*` — everything else in `db/` is runtime-required.

---

### T5 — CI workflow wired to the exclude file

**Input/setup:** `.github/workflows/cd.release.yml` after Step 5's edit.

**Expected behavior:** the dead `ZIP_EXCLUDES` env var is gone; the `Build ZIP` step
reads from `.github/zip-excludes.txt` instead of a hardcoded `-x` list.

**Assertions:**
```
grep -n "ZIP_EXCLUDES" .github/workflows/cd.release.yml   # → no output
grep -n "zip-excludes.txt" .github/workflows/cd.release.yml   # → hit in the Build ZIP step
```
Validate YAML syntax (`yamllint` or `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/cd.release.yml'))"`).

**Edge cases:** confirm the `how-to/*` re-add step (`zip -u "$ZIP_NAME" how-to/*`) still
runs after the exclude-based build, since `how-to/*` is staged post-checkout and must
land in the zip despite being excluded by pattern.

---

### T6 — end-to-end lite boot from the built zip (the real proof)

**Input/setup:** isolated scratch dir (per the no-stray-state rule — never inside the
repo tree). Build the zip from a clean tag checkout using the updated workflow logic
(can be run locally by replicating the `Build ZIP` step's `zip` command), extract it there.

**Expected behavior:**
1. `db/postgres.js` and `db/postgres/` are physically absent from the extracted tree.
2. `npm install` succeeds.
3. `npm run start:lite` boots without `ERR_MODULE_NOT_FOUND` or any Postgres-related
   stack trace.
4. A memory save + recall round-trip (via the API or terminal client) succeeds.

**Assertions:**
```
test ! -e db/postgres.js && test ! -d db/postgres   # inside the extracted dir
npm run start:lite &   # capture stdout/stderr, watch for boot success line
# then: save_memory / recall via HTTP or MCP call against the running instance
```

**Edge cases:** confirm the process is torn down (kill the started server, remove the
scratch dir and any DB files it created) before considering this test complete — no
artifacts left behind.

---

### T7 — Postgres backend regression check

**Input/setup:** full repo (not the trimmed zip), `DB_BACKEND=postgres` against a real or
`docker-compose`d Postgres instance.

**Expected behavior:** the dynamic import in `db/index.js` resolves `PostgresStore`
correctly and the store initializes exactly as before the refactor.

**Assertions:** existing Postgres integration/contract tests
(`tests/integration/**postgres**`, `audit/tests/database-contract.test.js` where
applicable) pass unchanged. No new failures introduced by the static→dynamic import
conversion.

**Edge cases:** explicitly test the failure path too — Postgres unreachable with
`DB_BACKEND=postgres` set — and confirm the existing fallback-to-SQLite behavior in
`getStore()` still triggers correctly (this is the behavior the dynamic import must not
disturb).

## Test execution order

T1 → T2 → T3 are independent of each other but must all pass before T4/T5 (the exclude
list shouldn't drop Postgres files until the code no longer needs them unconditionally).
T4 and T5 are independent of each other. T6 depends on T4 + T5 (needs the actual built
zip). T7 can run any time after T2 but is most meaningful run last, alongside T6, as the
paired positive/negative check (lite boots without Postgres files; full repo still boots
with Postgres when asked).

## Required setup

- Node.js + npm (matching the project's engines range) for T1–T3, T5–T7.
- A scratch directory outside the repo tree for T6 (per the standing no-side-effect-processes
  rule — see `AGENTS.md`).
- Docker (or a reachable Postgres instance) for T7.
- `zip`/`unzip` CLI matching (or close to) the `ubuntu-latest` GitHub Actions runner
  version, to catch any `-x@` syntax discrepancies before they hit CI.
