# Journey 2 — Browser chat → WebSocket → agent → tool → confirmation → UI result

**Audit run:** Run 001  
**Date:** 2026-07-24  
**Verdict:** Deferred — confirmation/two-phase-commit path has critical test gaps

---

## Hops

### Hop 1 — Browser WebSocket connect

| Field | Value |
|-------|-------|
| **Files** | `public/scripts/chat.js:39-82`, `lib/server/ws.js:12-31` |
| **What happens** | Browser creates WebSocket with auth token query param. Server `verifyClient` checks origin against `allowedHosts` and calls `isAuthorized()`. |
| **Contract** | Origin and auth validated before any message processed |
| **Test coverage** | ✅ `tests/integration/server/ws.test.js:61-143` — origin/auth verifyClient tests |
| **Finding** | Clean |

### Hop 2 — Init message + greeting

| Field | Value |
|-------|-------|
| **Files** | `lib/emitters/handlers/wsHandler.js:101-227` |
| **What happens** | Client sends `init`. Server responds with greeting, provider info, session_created, startup_breakdown, and warmCache result |
| **Contract** | Init must be the first message; provider and session details must be complete |
| **Test coverage** | ⚠️ Exercised in E2E tests, no focused unit test for init handler |
| **Finding** | Init handler untested in isolation |

### Hop 3 — Chat message dispatch

| Field | Value |
|-------|-------|
| **Files** | `lib/emitters/handlers/wsHandler.js:252-315`, `wsHandler.js:438-618` |
| **What happens** | Client sends `chat` → `handleChat()` → skills parsing → attachments → RAG → `runAgentLoop()` → provider dispatch |
| **Contract** | Messages ordered, turn-locked, attachment/content blocks parsed correctly |
| **Test coverage** | ✅ E2E tests (109 pass, 100%) cover chat lifecycle |
| **Finding** | Clean |

### Hop 4 — Agent orchestrator + tool dispatch

| Field | Value |
|-------|-------|
| **Files** | `lib/agent/index.js:570-647`, `lib/agent/tool-hooks.js`, `lib/agent/tool-safety-middleware.js`, `mcp/tools/*.js` |
| **What happens** | `runAgentLoop()` → tool selection → callToolHooked → lifecycle middleware (failure budget, taint, dedup) → tool result streamed back |
| **Contract** | Tool selection correct; safety gates enforce taint/failure-budget; results rendered |
| **Test coverage** | ✅ Various provider loop tests exercise tool call/result cycles |
| **Finding** | Clean |

### Hop 5 — Tool result streaming back

| Field | Value |
|-------|-------|
| **Files** | `lib/emitters/wsEmitter.js`, `public/scripts/streaming/events/tools.js` |
| **What happens** | `tool_start`, `tool_result`, stream events → browser-side event handlers render tool cards |
| **Contract** | Events delivered in order; each tool result paired with its `tool_use`; no duplicate rendering |
| **Test coverage** | ⚠️ Exercised by E2E only; no unit tests for browser-side tool card rendering |
| **Finding** | Client-side event handlers lack unit tests |

### Hop 6 — Confirmation / two-phase commit

| Field | Value |
|-------|-------|
| **Files** | `lib/emitters/handlers/ws/interrupts.js:17-96`, `lib/routes/api-interrupts.js:38-95`, `mcp/tools/files/interrupt.js:39-46`, `public/scripts/streaming/interrupts.js` |
| **What happens** | Mutating tool call triggers `action_confirm_pending` → browser shows confirm button → user clicks → `confirm_action` or `interrupt_decision` → `decideAndMaybeExecute()` → tool executes or is rejected |
| **Contract** | CONFIRMABLE_TOOLS list consistent across files. Confirmation re-validates arguments. Reject does not execute. |
| **Test coverage** | ❌ **Critical gap**: `confirm_action` and `interrupt_decision` WS handlers have zero test coverage |
| **Finding** | ⚠️ **CONFIRMABLE_TOOLS set duplicated** in `ws/interrupts.js:17` and `api-interrupts.js:38`. Lists could drift. Entire confirmation path untested. |

### Hop 7 — Response rendered in browser

| Field | Value |
|-------|-------|
| **Files** | `public/scripts/streaming/events/turn.js`, `public/scripts/streaming/handler.js` |
| **What happens** | `stream_start` → token-by-token rendering → `stream_end` → final answer displayed |
| **Contract** | Streaming events rendered in real time; no gaps or duplicate tokens |
| **Test coverage** | ⚠️ E2E only |
| **Finding** | Token coalescing and rendering logic untested in isolation |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | WS connect | ✅ | None |
| 2 | Init + greeting | ⚠️ | No unit test for init handler |
| 3 | Chat dispatch | ✅ | None |
| 4 | Agent + tool dispatch | ✅ | None |
| 5 | Tool result streaming | ⚠️ | No client-side unit tests |
| 6 | Confirmation | ❌ | **Untested**; CONFIRMABLE_TOOLS duplicated |
| 7 | Response rendering | ⚠️ | E2E only |

**Verdict:** Deferred — the entire confirmation/two-phase-commit path (Hop 6) has zero test coverage and a duplicated tool set that can drift. This is a correctness + security gap.
