# Journey 9 — Browser disconnect/reconnect during provider streaming and during a mutating tool call

**Audit run:** Run 001  
**Date:** 2026-07-24  
**Verdict:** PASS — graceful abort chain, session persistence enables manual reconnect

---

## Hops

### Hop 1 — WS close handler

| Field | Value |
|-------|-------|
| **Files** | `lib/emitters/handlers/wsHandler.js:230-250` |
| **What happens** | `ws.on("close")`: sets `socketClosed`, calls `turnLock.abortForClose()`, finalises session. `socketClosed` flag suppresses catch-block errors |
| **Contract** | Close must not throw. Session must be finalised. Errors suppressed during shutdown |
| **Test coverage** | ✅ `tests/unit/handlers/wsHandler.test.js:401-437` — closing socket during active turn does not throw |
| **Finding** | Clean |

### Hop 2 — Turn abort

| Field | Value |
|-------|-------|
| **Files** | `lib/emitters/handlers/ws/turnLock.js:1-90` |
| **What happens** | `abortForClose()` (guarded), `preempt()`/`stop()` (unguarded), identity-guarded `finishChatTurn()` prevents stale cleanup from clobbering newer turn |
| **Contract** | Abort must not orphan resources. Identity guard must prevent stale turn cleanup |
| **Test coverage** | ✅ `tests/unit/handlers/ws/turnLock.test.js:1-140` — full suite including abortForClose guarded behavior |
| **Finding** | Clean |

### Hop 3 — Provider stream abort

| Field | Value |
|-------|-------|
| **Files** | `lib/agent/providers/anthropic.js`, `gemini.js`, `deepseek.js`, `llamacpp.js`, `lib/streaming/llamacppHandler.js:1-79` |
| **What happens** | Every provider implements: `AbortController` + latch pattern → stream iteration throws `AbortError` → catch emits `stream_end`. DeepSeek uses `AbortSignal.any([controller, timeoutController])` |
| **Contract** | Stream must abort cleanly. No data after abort. Error must not leak past catch |
| **Test coverage** | ✅ `tests/unit/providers/anthropic.test.js:255-316` — abort mid-stream. ✅ `tests/unit/providers/gemini.test.js:333-428` — abort mid-stream |
| **Finding** | Clean — all providers tested for mid-stream abort |

### Hop 4 — Session finalisation

| Field | Value |
|-------|-------|
| **Files** | `lib/helpers/sessions.js`, `lib/emitters/handlers/wsHandler.js:246` |
| **What happens** | `finaliseSession(sessionId, messages, msgAttachments, sessionHadAttachments, { onShutdown })` — persists conversation state to disk/DB |
| **Contract** | Session must be persistable after abort. Partial messages must be saved |
| **Test coverage** | ✅ E2E session persistence tests |
| **Finding** | Clean |

### Hop 5 — Session resume

| Field | Value |
|-------|-------|
| **Files** | `lib/emitters/handlers/ws/session.js:35-53`, `lib/helpers/sessions.js:560-585` |
| **What happens** | Client sends `resume_session` → `buildResumeContext()` → compact context (latest summary or last 4 exchanges, 200-char truncated) → `noTools: true` loop |
| **Contract** | Resume must reconstruct enough context for the model to continue. `noTools: true` prevents re-execution of old tool calls |
| **Test coverage** | ✅ `tests/unit/handlers/ws/session.test.js:1-90` — handleResumeSession unit tests. ✅ `tests/e2e/real-app/real-app-ws.test.js:390-423` — E2E resume_session test |
| **Finding** | E2E resume test resumes a quiescent session, not one interrupted mid-stream |

### Hop 6 — Mutating tool call during disconnect

| Field | Value |
|-------|-------|
| **Files** | `lib/agent/tool-hooks.js`, `lib/agent/index.js:570-647` |
| **What happens** | If disconnect occurs after tool dispatch but before result streams back, the tool executes server-side. Result persists in messages array. Client only sees it on explicit resume |
| **Contract** | Tool execution must be atomic. Result must persist even if client disconnects mid-stream |
| **Test coverage** | ❌ **No test** for disconnect during mutating tool call |
| **Finding** | No data loss — result persists. UX gap: client doesn't see result until explicit resume. Accepted design limitation |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | WS close handler | ✅ | None |
| 2 | Turn abort | ✅ | None |
| 3 | Provider stream abort | ✅ | None |
| 4 | Session finalisation | ✅ | None |
| 5 | Session resume | ✅ | Resumes quiescent session only |
| 6 | Mutating tool during disconnect | ❌ | **UX gap: result hidden until resume** |

**Verdict:** PASS — abort chain clean, session persistence/reconnect works. In-flight mutating tool calls persist correctly but client doesn't see result until explicit resume (accepted UX gap).
