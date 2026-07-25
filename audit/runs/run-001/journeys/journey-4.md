# Journey 4 — Provider switch mid-session (history/images/usage/abort)

**Audit run:** Run 001  
**Date:** 2026-07-24  
**Verdict:** Deferred — `normalizeMessages` silently drops image blocks across provider switch

---

## Hops

### Hop 1 — Client sends `switch_model`

| Field | Value |
|-------|-------|
| **Files** | `lib/emitters/handlers/wsHandler.js:397-423` |
| **What happens** | Client sends `{ type: "switch_model", model, provider }`. Handler validates model name, calls `agent.setProvider()`, conditionally normalizes messages, updates session, and sends `provider` event with full capability payload |
| **Contract** | Switch must only apply to chat agent, not background jobs. Payload must contain all provider capabilities |
| **Test coverage** | ✅ E2E: `real-app-ws.test.js:426-440` — switch_model emits new provider event; malformed message silently ignored |
| **Finding** | Clean — handler has type guard and malformed-message handling |

### Hop 2 — Agent state mutation

| Field | Value |
|-------|-------|
| **Files** | `lib/agent/index.js:737-755` — `setProvider()` |
| **What happens** | `resolveProvider()` → `Object.assign(provider, newProvider)` → reasoningAdapter reassigned → shellBox re-evaluated → `llamacppEverConnected` reset → `clearSelfMemCtx()` when switching to cloud |
| **Contract** | Agent state must be consistent after switch. Self-memory must be cleared on cloud switch. Shell availability must be re-evaluated |
| **Test coverage** | ✅ `tests/integration/agent.test.js:1409-1453` — local→cloud switch updates identity, drops self-memory tools, clears selfMemCtx. `tests/integration/agent.test.js:1455-1484` — shell tool re-evaluated |
| **Finding** | Clean |

### Hop 3 — Message normalization

| Field | Value |
|-------|-------|
| **Files** | `lib/emitters/handlers/ws/helpers.js:8-25` — `normalizeMessages()` |
| **What happens** | Filters only `type: "text"` blocks. Drops tool-only messages. **Silently discards image blocks** |
| **Contract** | Messages must be converted to the new provider's format. Tool history must survive. Images should be preserved where possible or dropped with notice |
| **Test coverage** | ✅ `tests/unit/handlers/ws/helpers.test.js:13-84` — plain strings, text collapse, pure-tool drop, mixed text+tool, empty inputs. ❌ **No image block test** |
| **Finding** | ⚠️ **`normalizeMessages` silently drops image blocks** — data-loss path with zero user notice. No image-preservation path exists. |

### Hop 4 — Provider routing resolution

| Field | Value |
|-------|-------|
| **Files** | `lib/providers/index.js:406-438` — `resolveProvider()` |
| **What happens** | Resolves name/model from env + overrides. Returns provider config with credentials, baseURL, contextWindow |
| **Contract** | Provider resolution must complete without error. Credentials must be available for the new provider |
| **Test coverage** | ✅ Provider resolution tests |
| **Finding** | Clean — no test that a turn actually reaches the new provider's API post-switch (fixture is mocked). Config/credential resolution bug would appear only in production |

### Hop 5 — Provider loop selection

| Field | Value |
|-------|-------|
| **Files** | `lib/agent/providers/anthropic.js`, `gemini.js`, `deepseek.js`, `llamacpp.js`, `claude-code.js`, `codex.js` |
| **What happens** | Each provider has its own format for tool_use, tool_result, images, abort, and usage. After switch, new provider's loop handles subsequent turns |
| **Contract** | Provider loop must handle all message types the client sends (text, images, tools, etc.) |
| **Test coverage** | ✅ Each provider has its own unit/integration tests |
| **Finding** | No cross-provider format-adapter contract test exists |

### Hop 6 — Session persistence after switch

| Field | Value |
|-------|-------|
| **Files** | `lib/helpers/sessions.js:366-369` — `updateSessionModel()`, `clearProviderSessionId()` |
| **What happens** | Provider+model persisted to session store. Old provider session ID cleared |
| **Contract** | Session must reflect the new provider. Old session state must not interfere |
| **Test coverage** | ❌ Not explicitly verified by any test |
| **Finding** | Session persistence after switch untested |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | Client switch_model | ✅ | None |
| 2 | Agent setProvider | ✅ | None |
| 3 | Message normalization | ⚠️ | **Silently drops images** — no test for image blocks |
| 4 | Provider resolution | ✅ | Mock fixture — no real API test |
| 5 | Provider loop | ✅ | No cross-provider contract test |
| 6 | Session persistence | ❌ | Not verified |

**Verdict:** Deferred — `normalizeMessages()` silently drops image blocks during cross-provider switch with zero user notice. Session persistence after switch untested. No E2E test proves a full turn reaches the new provider's API post-switch.
