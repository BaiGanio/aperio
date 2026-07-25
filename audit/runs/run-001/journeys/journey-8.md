# Journey 8 — Non-loopback deployment → TLS/auth/origin/rate-limit → WebSocket and REST parity

**Audit run:** Run 001  
**Date:** 2026-07-24  
**Verdict:** PASS — all four security layers present; two minor unit test gaps (tlsServer, authGuard)

---

## Hops

### Hop 1 — TLS/HTTPS

| Field | Value |
|-------|-------|
| **Files** | `lib/helpers/tlsServer.js:1-35`, `lib/server.js:130` |
| **What happens** | `createAppServer(app)` returns `{server, secure}`. Opt-in HTTPS via `APERIO_TLS_CERT`+`APERIO_TLS_KEY`. Fail-loud if only one env var set. `secure` flag controls helmet `strictTransportSecurity` and CSP `upgradeInsecureRequests` |
| **Contract** | TLS opt-in only. Single env var must fail loud. `secure` flag must propagate correctly |
| **Test coverage** | ❌ No dedicated unit test for `tlsServer.js` |
| **Finding** | Simple logic (one if/else), but no regression guard |

### Hop 2 — DNS rebinding / CSRF (NetGuard)

| Field | Value |
|-------|-------|
| **Files** | `lib/helpers/netGuard.js:1-105`, `lib/server.js:192-196` |
| **What happens** | Host allowlist + Origin check + X-Aperio-Client header. Runs before any route including setup. Middleware order: helmet → netGuard → authGuard → body parser → routes |
| **Contract** | NetGuard must block unknown Host headers on ALL routes, including setup |
| **Test coverage** | ✅ `tests/unit/helpers/netGuard.test.js:1-XX` — 12 tests covering allowlist, origin, headers |
| **Finding** | Clean — well-tested |

### Hop 3 — Auth token

| Field | Value |
|-------|-------|
| **Files** | `lib/helpers/authGuard.js:1-80` |
| **What happens** | Opt-in shared-secret via `APERIO_AUTH_TOKEN`. `extractToken` supports Authorization Bearer, X-Aperio-Token, and `?token` query param. Constant-time `safeEqual` for comparison. Webhook exemption at `/api/github/webhook` |
| **Contract** | Token must be constant-time compared. All three token sources must work. Webhook must bypass auth |
| **Test coverage** | ❌ No dedicated unit test for `authGuard.js` |
| **Finding** | `extractToken` (3 sources), `safeEqual`, and webhook exemption are indirectly exercised by WS tests only |

### Hop 4 — Rate limiting

| Field | Value |
|-------|-------|
| **Files** | `lib/helpers/rateLimit.js:1-15`, `lib/routes/api-data.js:42`, `api-codegraph.js:73`, `api-docgraph.js:59`, `api-memories.js:24`, `lib/server/setupRoutes.js:113` |
| **What happens** | Per-IP fixed-window via `express-rate-limit`. Default 20 requests/15min. Applied per-endpoint: import routes get 20/15min, setup routes get 30/15min |
| **Contract** | Rate limits must apply correctly per route. Different limits for setup vs data routes |
| **Test coverage** | ⚠️ `tests/integration/helpers/rateLimit.test.js` — one happy-path+throttle test. Per-endpoint limits not tested individually |
| **Finding** | Per-endpoint limits (import vs index vs setup) not tested for correct configuration |

### Hop 5 — WebSocket verifyClient

| Field | Value |
|-------|-------|
| **Files** | `lib/server/ws.js:1-49` |
| **What happens** | verifyClient checks origin vs `allowedHosts` + `isAuthorized()`. Auth + origin checked before any WS message processed |
| **Contract** | WS origin/auth must match REST auth. Same allowlist used |
| **Test coverage** | ✅ `tests/integration/server/ws.test.js:61-143` — 12 tests for origin/auth verifyClient |

---

## Summary

| Hop | Name | Test coverage | Critical gaps |
|-----|------|-------------|--------------|
| 1 | TLS/HTTPS | ❌ | No unit tests |
| 2 | NetGuard | ✅ | None |
| 3 | Auth token | ❌ | No unit tests |
| 4 | Rate limiting | ⚠️ | Per-endpoint limits untested |
| 5 | WS verifyClient | ✅ | None |

**Verdict:** PASS — all four security layers present, consistent across REST and WebSocket. NetGuard and WS verifyClient have excellent coverage. TLS and authGuard lack unit tests (low severity due to opt-in defaults).
