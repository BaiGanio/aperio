# Journey 10 — External MCP host and browser session acting concurrently on same memory/path/artifact/DB

**Audit run:** Run 001  
**Date:** 2026-07-24  
**Verdict:** MEDIUM-HIGH RISK — multiple concurrency protection gaps

---

## Hops

### Hop 1 — MCP + Browser share single store instance

| Field | Value |
|-------|-------|
| **Files** | `mcp/index.js:60-115`, `db/index.js` |
| **What happens** | Single `McpServer` with one store instance shared across all clients. Browser REST routes use the same `getStore()` singleton. No client-isolation layer |
| **Contract** | Concurrent reads/writes from MCP and browser must not corrupt shared state |
| **Test coverage** | ❌ No concurrent access tests |
| **Finding** | ⚠️ **No isolation between MCP host and browser.** Both access the same store instance with no client-boundary token |

### Hop 2 — SQLite in-memory cache race

| Field | Value |
|-------|-------|
| **Files** | `db/sqlite/store.js:65` |
| **What happens** | `this.cache = []` — shared mutable array. No locking. `refreshCache()` is async and runs outside the write transaction |
| **Contract** | Cache must be consistent after concurrent writes |
| **Test coverage** | ❌ No concurrent cache tests |
| **Finding** | ⚠️ **Unprotected in-memory cache.** TOCTOU window between transaction commit and async cache refresh |

### Hop 3 — SQLite WAL mode + concurrent writes

| Field | Value |
|-------|-------|
| **Files** | `db/sqlite/store.js:103-109` |
| **What happens** | WAL mode for plaintext DBs. DELETE journal mode for encrypted DBs. **No `busy_timeout` set** — write contention resolves by immediate `SQLITE_BUSY` error |
| **Contract** | Concurrent writes must not cause data loss. `busy_timeout` should retry on contention |
| **Test coverage** | ❌ No concurrent write isolation tests |
| **Finding** | ⚠️ **No `busy_timeout`.** Encrypted DBs use DELETE journal (WAL incompatible with temp-file encryption) — higher contention risk |

### Hop 4 — Atomic approvePending

| Field | Value |
|-------|-------|
| **Files** | `db/sqlite/store.js:551-573`, `db/postgres/store.js:200-238` |
| **What happens** | SQLite: `db.transaction()` with re-guarded `AND status = 'pending'` + `info.changes` check. Postgres: `SELECT ... FOR UPDATE` row lock with dedicated client + `BEGIN` / `COMMIT` |
| **Contract** | approvePending must be atomic. Double-promotion must be prevented |
| **Test coverage** | ✅ Cross-backend contract tests for approvePending |
| **Finding** | Clean — atomic design on both backends |

### Hop 5 — updateMemory read-then-write race

| Field | Value |
|-------|-------|
| **Files** | `lib/handlers/memory/memoryHandlers.js:120-148` — `updateMemoryHandler` |
| **What happens** | Reads `getById()` then writes `update()` with no locking between. Two concurrent updates to the same memory both read the same state — second overwrites first |
| **Contract** | Concurrent memory updates must not lose data |
| **Test coverage** | ❌ No race condition test |
| **Finding** | ⚠️ **Read-then-write race.** Add optimistic concurrency control (version number) or advisory row lock |

### Hop 6 — Path isolation

| Field | Value |
|-------|-------|
| **Files** | `lib/routes/paths.js:89-92`, `paths.js:140-160`, `paths.js:183-186` |
| **What happens** | `pathStorage` (AsyncLocalStorage) + `runWithPaths()` per-connection. Global mutable `allowlist` and `userPaths`. MCP has no per-session scratch context, falls back to global allowlist |
| **Contract** | Per-connection path isolation must not bleed. Concurrent `setAllowlist()` must not race with path checks |
| **Test coverage** | ✅ `tests/integration/mcp/tools/files.test.js:951-1023` — 4 per-connection path isolation tests |
| **Finding** | Clean for WS per-connection. ⚠️ Global allowlist mutation race — `setAllowlist()` mutates module-level vars without synchronization |

### Hop 7 — Postgres update without locking

| Field | Value |
|-------|-------|
| **Files** | `db/postgres/store.js:250-293` |
| **What happens** | `update()`: explicit transaction but **no `FOR UPDATE`**. Copy-on-write with `valid_until` tombstone |
| **Contract** | Concurrent updates must not lose the old row before new row is committed |
| **Test coverage** | ❌ No concurrent update tests |
| **Finding** | ⚠️ **Window where concurrent reader sees neither old nor new row** (tombstoned old, not-yet-committed new) |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | Shared store instance | ❌ | No client isolation |
| 2 | In-memory cache race | ❌ | Unprotected mutable array |
| 3 | SQLite WAL + busy_timeout | ❌ | No busy_timeout; DELETE journal for encrypted |
| 4 | Atomic approvePending | ✅ | None |
| 5 | updateMemory read-then-write | ❌ | Race: two concurrent updates overwrite |
| 6 | Path isolation | ⚠️ | Global allowlist mutation race |
| 7 | Postgres update locking | ❌ | FOR UPDATE missing |

**Verdict:** MEDIUM-HIGH RISK — MCP + Browser share everything. SQLite cache unprotected. updateMemory has read-then-write race. Postgres update lacks FOR UPDATE.
