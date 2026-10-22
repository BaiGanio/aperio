import { sweepExpiredRedactionMaps } from "../handlers/memory/memoryHandlers.js";
import logger from "../helpers/logger.js";

const SWEEP_INTERVAL_MS = 5 * 60_000;

// Garbage-collects var/redaction-maps/*.json — the on-disk Privacy Shield
// redact-mode side channel (memoryHandlers.js's writeRedactionMap/
// takeRedactionMap). Each entry's own writer schedules a best-effort
// unref'd setTimeout to delete it, but Codex runs recall inside its own
// short-lived MCP child process, which can exit long before that timer
// fires — orphaning the entry (and the real PII it holds) until something
// else touches the directory. This worker is that "something else": it runs
// in the main server process, which outlives every per-turn MCP child, so an
// abandoned entry is never more than one sweep interval away from cleanup
// regardless of which provider wrote it or whether anyone ever redeems it
// (review round 5, P1).
export function createRedactionMapPruner(_sweep = sweepExpiredRedactionMaps) {
  function run() {
    try {
      const n = _sweep();
      if (n > 0) logger.info(`[redaction-map-prune] removed ${n} expired redaction map(s)`);
    } catch (err) {
      logger.error("[redaction-map-prune] error:", err);
    }
  }

  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
