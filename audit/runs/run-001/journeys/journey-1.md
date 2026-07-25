# Journey 1 — Fresh Lite install → bootstrap → SQLite → local model → first memory recall

**Audit run:** Run 001 (commit `45b5f7c`)  
**Date:** 2026-07-24  
**Verdict:** Deferred — handler logic tested, infrastructure hops have gaps

---

## Hops

### Hop 1 — Download & unzip

| Field | Value |
|-------|-------|
| **Files** | GitHub Release zip → filesystem |
| **What happens** | User downloads `aperio-lite.zip`, unzips, runs the bundled executable |
| **Contract** | Bundled binaries (`llama-server`, Node runtime) must have integrity verification. Lite distribution currently relies on GitHub Release SHA checksums but no runtime verification |
| **Test coverage** | ❌ None — `tests/unit/bootstrap.test.js` tests step structure and `getEphemeralPort()` but not distribution integrity |
| **Finding** | No runtime binary integrity check for the lite distribution |

### Hop 2 — `server.js` entrypoint

| Field | Value |
|-------|-------|
| **Files** | `server.js` |
| **What happens** | Loads `.env`, tightens to mode 600, installs crash breaker (5 fatals in 60s → exit), runs Ollama migration shim, delegates to `createApp()` |
| **Contract** | `.env` must be owner-only. Crash breaker must not mask single recoverable errors. Old Ollama config must be caught. |
| **Test coverage** | ⚠️ `tests/unit/server-entrypoint.test.js` — static source-text check only (asserts `createApp` reference exists). No runtime test |
| **Finding** | `.env` permission tightening (chmod 600), crash breaker threshold, and Ollama shim are untested |

### Hop 3 — `createApp()`: Express + security middleware

| Field | Value |
|-------|-------|
| **Files** | `lib/server.js` (lines 80–265) |
| **What happens** | Port clearance → Express + HTTP server → CSP/Helmet → NetGuard (DNS rebinding) → AuthGuard → signal handlers (registered before boot) → setup routes → listen |
| **Contract** | CSP must not break Safari on HTTP. NetGuard must gate even setup routes. Signal handlers must clean up in-flight llama-server downloads. Port clearance must not hang. |
| **Test coverage** | ⚠️ `tests/unit/lib/server.test.js` — tests `finishBootBeforeShutdown()` shutdown ordering only |
| **Finding** | NetGuard on setup routes, Safari CSP bypass, port clearance, and first-run-to-wizard flow are untested |

### Hop 4 — Bootstrap wizard

| Field | Value |
|-------|-------|
| **Files** | `bootstrap.js` |
| **What happens** | 5 steps: (1) Node check, (2) deps install, (3) llama-server download + SHA verify on 3 OSes, (4) model download via throwaway llama-server, (5) SQLite (deferred) |
| **Contract** | SHA256 verification must work on macOS/Linux/Windows. Priming server must be killed and not orphaned. Failed download must not leave half-written cache. |
| **Test coverage** | ⚠️ `tests/unit/bootstrap.test.js` — tests step structure, `getEphemeralPort()`, `isBootstrapped()`. ❌ SHA download/verify on 3 platforms, priming lifecycle, and cleanup on cancel are untested |
| **Finding** | Three platforms, three hash tools (shasum/sha256sum/PowerShell) — any bug is a security hole. No test coverage |

### Hop 5 — `bootApp()` / `hydrateRuntime()`: full app initialization

| Field | Value |
|-------|-------|
| **Files** | `lib/server/hydrateRuntime.js`, `db/sqlite/store.js`, `lib/server.js` (lines 268–449), `db/index.js` |
| **What happens** | Config hydration → `getStore()` → `SqliteStore.init()` (encryption, sqlite-vec load, migrations, seeds, cache) → embeddings init → allowlist → `ensureLlamaCpp()` → `createAgent()` → model preload → WebSocket/workers/scheduler/watchdog |
| **Contract** | Migrations succeed on fresh/existing DB. Vector dims match. Seeds match schema. Encryption key created, temp cleaned. llama-server health-check passes. Agent ready before WS accepts. |
| **Test coverage** | ✅ `tests/integration/server/hydrateRuntime.test.js` — real in-memory SQLite, validates all 8 return fields, store type, allowlist, watcher lifecycle, generateEmbedding passthrough ✅ `tests/unit/db/memory-seed.test.js` — validates seed shapes, APERIO_LITE gate, self-seed identity ❌ Encryption reconciliation, dim mismatch detection, llama-server startup, full bootApp() are untested |
| **Finding** | hydrateRuntime integration test exists and is solid. But llama-server startup, encryption reconciliation, and full bootApp orchestration are untested |

### Hop 6 — First memory recall

| Field | Value |
|-------|-------|
| **Files** | `mcp/tools/memory.js`, `lib/handlers/memory/memoryHandlers.js`, `db/sqlite/search.js` |
| **What happens** | User message → WS handler → agent → context assembly → `recall` tool → embedding → sqlite-vec (semantic) + FTS5 (fulltext) → RRF fusion → privacy gate (tier/local filter) → formatted → injected into prompt → llama.cpp responds → streamed back via WS |
| **Contract** | Embedding dims match. FTS5 works in correct locale. Privacy filter distinguishes local vs cloud. Formatted output readable by model. Response streamed in real time. |
| **Test coverage** | ✅ `tests/unit/tools/memory.test.js` — comprehensive unit tests for all 6 handlers (remember, recall, update, forget, backfill, dedup). Privacy gate tested (lines 189–219). ❌ No integration test against real DB/sqlite-vec/FTS5. No test for full context-assembly pipeline. |
| **Finding** | Handler logic is well-tested. But the actual vector search, FTS5 fusion, and end-to-end recall pipeline are integration-untested |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | Download zip | ❌ | Lite binary integrity |
| 2 | server.js entry | ⚠️ Static only | .env perms, crash breaker, Ollama shim |
| 3 | createApp security | ⚠️ Shutdown only | NetGuard, CSP/Safari, port clearance |
| 4 | Bootstrap wizard | ⚠️ Structure/ports | SHA verify (3 OS), priming lifecycle |
| 5 | bootApp / DB init | ✅ hydrateRuntime + seeds | llama-server startup, encryption, dim mismatch |
| 6 | Memory recall | ✅ Unit (handlers) | Integration with real DB/embeddings |

**Verdict:** Deferred — handler Hop 6 is well-tested, infrastructure Hops 2–5 have significant gaps. Full pass requires integration tests for the recall pipeline and bootstrap integrity verification.
