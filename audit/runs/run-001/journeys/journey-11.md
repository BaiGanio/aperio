# Journey 11 — Tool result too large → offload → artifact retrieval → provider switch → session resume → retention cleanup

**Audit run:** Run 001  
**Date:** 2026-07-24  
**Verdict:** PASS — well-tested contiguous pipeline; one minor gap (no combined offload→switch→retrieval test)

---

## Hops

### Hop 1 — Tool result offload

| Field | Value |
|-------|-------|
| **Files** | `lib/context/toolResultOffload.js:1-206`, `lib/agent/model-context-middleware.js:1-206` |
| **What happens** | Token-limit (dynamic: min(configured, contextWindow * 0.25)). Byte-limit (80KB default). `redact(text)` before persistence. Head/tail preview with retrieval guidance. Middleware `createToolResultOffloadMiddleware` installed as `afterTool` hook. Fail-open on error |
| **Contract** | Offload must be atomic and lossless. Redacted before persistence. Fail-open must not break the agent loop |
| **Test coverage** | ✅ `tests/integration/context/toolResultOffload.test.js:1-140` — 7 tests covering all offload behaviors. ✅ `tests/unit/agent/model-context-middleware.test.js:131-180` — offload middleware + fail-open test |
| **Finding** | Clean |

### Hop 2 — Artifact store

| Field | Value |
|-------|-------|
| **Files** | `lib/context/artifactStore.js:1-259` |
| **What happens** | Immutable artifact store. Atomic writes (temp + rename). SHA-256 integrity. `pruneOwners({scope, olderThan})` deletes owner dir only when all artifacts are expired |
| **Contract** | Artifacts must be immutable. Atomic writes must not produce partial files |
| **Test coverage** | ✅ Integration tests for artifact store |
| **Finding** | `pruneOwners` is O(n) per owner — reads every artifact's metadata file. Acceptable for typical scale |

### Hop 3 — Artifact retrieval

| Field | Value |
|-------|-------|
| **Files** | `lib/context/artifactRetrieval.js:1-126` |
| **What happens** | Chunked reader (24KB chunks, 32KB response cap). 4 provider-schema adapters (MCP/Anthropic/OpenAI/Gemini). Owner-oblivious error messages |
| **Contract** | Retrieval must be paginated. Must work across all provider schemas |
| **Test coverage** | ✅ `tests/integration/context/artifactRetrieval.test.js:1-96` — 4 tests for paginated retrieval, owner-gating, validation |
| **Finding** | Clean |

### Hop 4 — Provider switch + retrieval

| Field | Value |
|-------|-------|
| **Files** | `lib/agent/index.js:737-755`, `lib/emitters/handlers/wsHandler.js:400-423` |
| **What happens** | After provider switch, `read_artifact` tool must still work with the new provider's schema adapter. Artifact IDs from provider A's session usable under provider B |
| **Contract** | Provider switch must not break artifact ID references. Schema adapters must handle both old and new formats |
| **Test coverage** | ❌ **No combined lifecycle test** for offload → switch → retrieval |
| **Finding** | ⚠️ Offload → switch → retrieval path untested end-to-end |

### Hop 5 — Session resume + artifact context

| Field | Value |
|-------|-------|
| **Files** | `lib/emitters/handlers/ws/session.js:62-85`, `lib/helpers/sessions.js:560-585`, `lib/emitters/handlers/ws/summarize.js:1-108` |
| **What happens** | `handleResumeSession`: compact resume via `buildResumeContext`, `noTools: true`. Summarize at 80% context: RAG indexing before compression, checkpoint to session file, memory persist |
| **Contract** | Session resume must not lose artifact references. Summarize must preserve context quality |
| **Test coverage** | ✅ Session resume tests. ✅ Summarize tests |
| **Finding** | Artifact IDs not propagated in resume context — model would need to re-discover large results |

### Hop 6 — Retention cleanup

| Field | Value |
|-------|-------|
| **Files** | `lib/server/backgroundWorkers.js:1-38`, `lib/workers/agent-run-prune.js:1-46`, `lib/workers/session-prune.js:1-18`, `lib/helpers/artifactWorkspace.js:1-60` |
| **What happens** | Pruner orchestration: session-prune (SESSION_RETENTION_DAYS, default 90), agent-run-prune (AGENT_RUN_RETENTION_DAYS, opt-in), llamacpp-log-prune. Daily unref'd timers. Artifact workspace pruner (90-day retention) |
| **Contract** | Pruners must not delete active session data. Retention periods must be configurable |
| **Test coverage** | ✅ `tests/unit/workers/agent-run-prune.test.js:1-52` — retention cutoff, zero-retention preserve |
| **Finding** | Clean — scope-aware pruners with configurable retention |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | Tool result offload | ✅ | None |
| 2 | Artifact store | ✅ | O(n) pruneOwners |
| 3 | Artifact retrieval | ✅ | None |
| 4 | Provider switch + retrieval | ❌ | **No combined lifecycle test** |
| 5 | Session resume | ✅ | Artifact IDs not propagated |
| 6 | Retention cleanup | ✅ | None |

**Verdict:** PASS — contiguous pipeline end-to-end. Offload is atomic and lossless. Retrieval is paginated and owner-gated. Retention cleanup is scope-aware. One minor gap: no combined test for offload → switch → retrieval.
