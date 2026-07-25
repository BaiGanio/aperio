# Journey 3 — External MCP host → ctx → memory/files tool → database/path guard

**Audit run:** Run 001  
**Date:** 2026-07-24  
**Verdict:** PASS — well-tested across all hops

---

## Hops

### Hop 1 — MCP server starts

| Field | Value |
|-------|-------|
| **Files** | `mcp/index.js:1-87` |
| **What happens** | `StdioServerTransport` created, `createContext()` assembles `{ store, generateEmbedding, vectorEnabled, embeddingQueue, providerIsLocal }`, all tools registered with this ctx |
| **Contract** | Context object must contain all dependencies each tool needs |
| **Test coverage** | ✅ `tests/integration/mcp/index.test.js:1-130` — tests startServer, vectorEnabled, ALLOWED_PATHS logic |
| **Finding** | Clean |

### Hop 2 — Memory tool via ctx → store

| Field | Value |
|-------|-------|
| **Files** | `mcp/tools/memory.js:1-79`, `lib/handlers/memory/memoryHandlers.js`, `db/sqlite/store.js` |
| **What happens** | `remember`/`recall`/`update`/`forget` tools destructure `{ store, generateEmbedding }` from ctx. Handlers call store methods, privacy gate applied based on `providerIsLocal` |
| **Contract** | All memory operations go through ctx. Privacy tier filtering works for both local and cloud |
| **Test coverage** | ✅ `tests/unit/tools/memory.test.js:1-396` — covers all 7 handlers including PRIVACY-01 local-only filtering |
| **Finding** | Clean — excellent handler test coverage |

### Hop 3 — Self-memory tools (local-only gate)

| Field | Value |
|-------|-------|
| **Files** | `mcp/tools/self-memory.js:1-72`, `lib/handlers/memory/selfMemoryHandlers.js` |
| **What happens** | Tools registered unconditionally but handlers return `localOnlyRefusal()` when `!providerIsLocal`. Three-layer gate: tool-profiles → handlers → context injection |
| **Contract** | Self-memory must never reach cloud providers |
| **Test coverage** | ✅ `tests/unit/tools/self-memory.test.js:1-181` — all 4 handlers tested, cloud gate verified (🔒 refusal, store never called) |
| **Finding** | Clean — triple-layer defense in depth |

### Hop 4 — Files tool → path guard

| Field | Value |
|-------|-------|
| **Files** | `mcp/tools/files.js:1-185`, `mcp/tools/files/read.js`, `mcp/tools/files/write.js`, `mcp/tools/files/delete.js`, `lib/routes/paths.js` |
| **What happens** | Files tools import `isReadPathAllowed`/`isWritePathAllowed` directly from paths.js (not ctx). Path validation gates every read/write/delete operation. `pathStorage` (AsyncLocalStorage) provides per-request isolation |
| **Contract** | Path validation must be consistent between MCP and REST contexts. Files tools must honor session-scoped path isolation |
| **Test coverage** | ✅ `tests/integration/mcp/tools/files.test.js:1-1111` — 1111 lines, extensive VFS-based tests for path guards, secret files, extensions, session-scoped `runWithPaths` |
| **Finding** | Files path guard bypasses ctx but is a deliberate architectural choice. Well-tested. |

### Hop 5 — Wiki tool → store

| Field | Value |
|-------|-------|
| **Files** | `mcp/tools/wiki.js`, `db/sqlite/wiki.js` |
| **What happens** | `wiki_get`/`wiki_write` tools use ctx store for article CRUD. Self-wiki variant has local-only gate |
| **Contract** | Wiki operations must follow same store pattern as memories |
| **Test coverage** | ✅ Unit + integration tests for wiki handlers |
| **Finding** | Clean |

### Hop 6 — DB store resolution

| Field | Value |
|-------|-------|
| **Files** | `db/index.js:1-97` |
| **What happens** | `getStore()` resolves Postgres or SQLite backend based on DB_BACKEND env, Docker availability, and container presence |
| **Contract** | Store resolution must be consistent for all callers (MCP, REST, WS) |
| **Test coverage** | ✅ Store factory test coverage |
| **Finding** | Clean |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | MCP server + ctx | ✅ | None |
| 2 | Memory tools | ✅ | None |
| 3 | Self-memory gate | ✅ | None |
| 4 | Files + path guard | ✅ | None |
| 5 | Wiki tools | ✅ | None |
| 6 | DB store resolution | ✅ | None |

**Verdict:** PASS — all hops well-tested. Files path validation has 1111-line integration test suite. Memory handlers comprehensively tested. Self-memory triple gate verified.
