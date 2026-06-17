// lib/helpers/authGuard.js
// AUTH-01 — opt-in shared-secret auth for the API + WebSocket. Off by default
// (local-only threat model); set APERIO_AUTH_TOKEN to require it before exposing
// Aperio on a LAN/host. When set, every /api/* request and every WS handshake
// must present the token via:
//   - Authorization: Bearer <token>
//   - X-Aperio-Token: <token>
//   - ?token=<token>           (for SSE/WebSocket, which can't set headers)
// Comparison is constant-time. The env var is read per-request so tests and a
// hot-reloaded .env take effect without a restart.

import { timingSafeEqual } from "crypto";

function configuredToken() {
  const t = process.env.APERIO_AUTH_TOKEN;
  return t && t.length > 0 ? t : null;
}

// Constant-time string compare that doesn't leak length via early return.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still run a compare against self so timing doesn't reveal the mismatch path.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// Pull a presented token out of an http.IncomingMessage (works for Express req
// and the raw req handed to ws verifyClient).
export function extractToken(req) {
  const auth = req.headers?.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const hdr = req.headers?.["x-aperio-token"];
  if (hdr) return String(hdr);
  try {
    const url = new URL(req.url, "http://localhost");
    const q = url.searchParams.get("token");
    if (q) return q;
  } catch { /* req.url may be undefined */ }
  return null;
}

// True when auth is disabled (no token configured) or the presented token matches.
export function isAuthorized(req) {
  const expected = configuredToken();
  if (!expected) return true; // opt-in: feature off
  const got = extractToken(req);
  return got != null && safeEqual(got, expected);
}

// Express middleware guarding /api/* only (static shell loads without auth; all
// data access goes through /api or the WS).
export function createAuthGuard() {
  return function authGuard(req, res, next) {
    if (!req.path.startsWith("/api/")) return next();
    if (isAuthorized(req)) return next();
    res.status(401).json({ error: "unauthorized" });
  };
}
