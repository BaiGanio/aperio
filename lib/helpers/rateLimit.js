// lib/helpers/rateLimit.js
// NET-03 — throttle expensive / abuse-prone endpoints (setup, memory import,
// code/doc indexing). These either run system profiling, accept bulk uploads,
// or kick off heavy embedding work, so an unthrottled caller could DoS the box.
// Plain per-IP fixed window; good enough for the local/LAN threat model.

import rateLimit from "express-rate-limit";

export function makeRateLimiter({ windowMs = 15 * 60 * 1000, max = 20, name = "endpoint" } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limited", endpoint: name },
  });
}
