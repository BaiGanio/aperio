import { pruneOldSessions } from "../helpers/sessions.js";
import logger from "../helpers/logger.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function createSessionPruner() {
  function run() {
    try {
      const n = pruneOldSessions();
      if (n > 0) logger.info(`[session-prune] removed ${n} expired session(s)`);
    } catch (err) {
      logger.error("[session-prune] error:", err);
    }
  }

  run();
  const timer = setInterval(run, ONE_DAY_MS);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
