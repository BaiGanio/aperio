# Journey 5 — Cloud egress of conversation containing secrets, self-memory, attachments, and tool results

**Audit run:** Run 001  
**Date:** 2026-07-24  
**Verdict:** PASS with notes — defense-in-depth privacy architecture; images bypass text redaction (accepted)

---

## Hops

### Hop 1 — Secret redaction at send boundary

| Field | Value |
|-------|-------|
| **Files** | `lib/helpers/redactSecrets.js:1-70`, `lib/agent/providers/anthropic.js:84`, `deepseek.js:128`, `gemini.js:109-110`, `claude-code.js:59,62`, `codex.js:83-84,100` |
| **What happens** | Every cloud provider's send function calls `redactMessages()` or `redactSecrets()` on messages before dispatching to the API. 9 secret patterns detected (API keys, tokens, passwords, etc.) |
| **Contract** | Secrets must be redacted before any data leaves the machine to a cloud provider |
| **Test coverage** | ✅ `tests/unit/helpers/redactSecrets.test.js` — 9 patterns, immutability, non-text preservation. Integration tested in provider tests |
| **Finding** | **Images bypass text-based secret redaction** — base64 image content in `image_url` blocks is never scanned. Accepted design limitation per source docs |

### Hop 2 — Memory-tier PII filtering

| Field | Value |
|-------|-------|
| **Files** | `lib/handlers/memory/memoryHandlers.js:71-90`, `lib/privacy/redact.js:1-60` |
| **What happens** | `recallHandler` privacy gate: tier 3 (private) never leaves machine. Tier 2 (sensitive): `APERIO_CLOUD_SENSITIVE_MODE` — `"withhold"` filters out, `"redact"` PII-scrubs via `redact()`. Tier 1 (normal): always passes |
| **Contract** | Tier filtering must distinguish local vs cloud. PII redaction must not corrupt non-PII content |
| **Test coverage** | ✅ `tests/unit/privacy/redact.test.js` — 4 PII patterns (EMAIL, IBAN, CARD, PHONE), round-trip, non-PII safety. ✅ `tests/unit/tools/memory.test.js:189-221` — cloud/local/absent providerIsLocal tier filtering |
| **Finding** | PII placeholders not persisted (accepted constraint) |

### Hop 3 — Self-memory local-only gate

| Field | Value |
|-------|-------|
| **Files** | `lib/handlers/memory/selfMemoryHandlers.js:1-171`, `lib/agent/tool-profiles.js:178-187`, `lib/agent/memory-context.js:1-85` |
| **What happens** | Three-layer gate: (1) `filterSelfMemoryTools()` drops all self_* tools on cloud, (2) handlers return `localOnlyRefusal()`, (3) `refreshSelfMemCtx()` no-ops on cloud. `clearSelfMemCtx()` called on cloud switch |
| **Contract** | Self-memory must never reach a cloud provider, via any path |
| **Test coverage** | ✅ `tests/unit/tools/self-memory.test.js:141-171` — all 4 handlers refuse on cloud, store never called. ✅ `tests/unit/agent/tool-profiles.test.js:541-553` — local preserves, cloud drops |
| **Finding** | Clean — triple-layer defense. No combined integration test for all three layers together |

### Hop 4 — Memory pointer injection

| Field | Value |
|-------|-------|
| **Files** | `lib/agent/index.js:312`, `lib/agent/memory-context.js`, `lib/emitters/handlers/wsHandler.js:101-227` (init/greeting) |
| **What happens** | Memory context assembled from recall results, filtered by tier, injected into system prompt. Greeting includes self-memory preload (local only) |
| **Contract** | Cloud providers must not receive tier-2/3 or self-memory data in context. Tier-1 memories must be available to all providers |
| **Test coverage** | ⚠️ Integration-level — `buildGreeting` has no dedicated unit test |
| **Finding** | Memory pointer injection is architecturally sound; `buildGreeting` untested in isolation |

### Hop 5 — Attachment/image egress

| Field | Value |
|-------|-------|
| **Files** | Provider loops — image block handling in each |
| **What happens** | Attachments and images are included in the message array sent to the provider. No dedicated content scan for secrets in image data |
| **Contract** | Images sent to cloud providers must not leak secrets embedded in screenshots/photos |
| **Test coverage** | ❌ No dedicated test |
| **Finding** | **Images bypass all text-based redaction.** VLM bridge mitigates for non-vision DeepSeek models (images stay local). Anthropic Claude and Gemini receive raw base64 image data. Accepted design limitation. |

### Hop 6 — Tool result offloading

| Field | Value |
|-------|-------|
| **Files** | `lib/context/toolResultOffload.js` |
| **What happens** | Tool results too large for context are offloaded to artifact store. `const safeText = redact(text)` before persistence. Preview with artifact ID sent to model |
| **Contract** | Tool results redacted before persistence. Preview must not leak secrets |
| **Test coverage** | ⚠️ Indirect only — no unit test for `createToolResultOffloader` |
| **Finding** | Redaction before persistence confirmed in source but untested |

### Hop 7 — Provider locality classification

| Field | Value |
|-------|-------|
| **Files** | `lib/providers/index.js:467-478`, `lib/agent/index.js:312` |
| **What happens** | `isLocalProvider()` returns true only for `"llamacpp"`. Single authoritative source for all privacy gates |
| **Contract** | Local provider set must be small and intentional |
| **Test coverage** | ✅ `tests/integration/providers.test.js:184-196` — all providers classified, case-insensitivity, edge cases |
| **Finding** | Clean — single source of truth, well-tested |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | Secret redaction | ✅ | Images bypass (accepted) |
| 2 | Memory-tier PII filtering | ✅ | PII placeholders not persisted |
| 3 | Self-memory gate | ✅ | No combined integration test |
| 4 | Memory pointer injection | ⚠️ | buildGreeting no unit test |
| 5 | Attachment/image egress | ❌ | Images bypass text redaction |
| 6 | Tool result offloading | ⚠️ | Indirect only |
| 7 | Provider locality | ✅ | None |

**Verdict:** PASS with notes — well-designed defense-in-depth privacy architecture. Images bypassing text-based secret redaction is an accepted design limitation. Self-memory triple gate is architecturally sound.
