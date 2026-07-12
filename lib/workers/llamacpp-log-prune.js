import { pruneServerLogs } from "../helpers/startLlamaCpp.js";
import logger from "../helpers/logger.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Garbage-collect per-session llama-server logs (var/llamacpp/{session-id}.log),
// the log-file sibling of createSessionPruner. These are short-lived debugging
// aids, so they get their own retention (LLAMACPP_LOG_RETENTION_DAYS, default 1
// day) independent of SESSION_RETENTION_DAYS. Runs unconditionally — logs can
// linger from before a provider switch, so this isn't gated on AI_PROVIDER.
// `_prune` is injectable so tests never touch the real var/llamacpp dir.
export function createLlamaLogPruner(_prune = pruneServerLogs) {
  function run() {
    try {
      const days = Math.max(1, Number(process.env.LLAMACPP_LOG_RETENTION_DAYS) || 1);
      const n = _prune(days);
      if (n > 0) logger.info(`[llamacpp-log-prune] removed ${n} session log(s) older than ${days}d`);
    } catch (err) {
      logger.error("[llamacpp-log-prune] error:", err);
    }
  }

  run();
  const timer = setInterval(run, ONE_DAY_MS);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
