// lib/helpers/crashBreaker.js
// PROC-01 — circuit breaker for fatal process errors.
//
// The global uncaughtException/unhandledRejection handlers keep the server
// alive after a single per-connection blowup, but a process that throws
// repeatedly is wedged (corrupt state, a hot loop). Limping along then serves
// errors indefinitely and never gets a clean restart. This breaker counts
// fatal errors in a sliding window and trips once they exceed a threshold, so
// the caller can exit and let the supervisor (systemd/docker/pm2) restart fresh.

// createCrashBreaker({ threshold, windowMs, now }) → { record(): boolean }
// record() registers one fatal error and returns true when the breaker has
// tripped (threshold reached within the window).
export function createCrashBreaker({ threshold = 5, windowMs = 60_000, now = Date.now } = {}) {
  let hits = [];
  return {
    record() {
      const t = now();
      hits.push(t);
      // Drop anything outside the sliding window.
      hits = hits.filter(ts => t - ts < windowMs);
      return hits.length >= threshold;
    },
  };
}
