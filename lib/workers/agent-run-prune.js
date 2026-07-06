import logger from "../helpers/logger.js";
import { createArtifactStore } from "../context/artifactStore.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Garbage-collect old agent_runs, the run-history sibling of createSessionPruner.
// Opt-in: only runs when AGENT_RUN_RETENTION_DAYS is set to a positive number
// (unset/0 = keep run history forever). Runs once at boot, then daily; the timer
// is unref()'d so it never holds the process open.
export function createAgentRunPruner({
  store,
  artifactStore = createArtifactStore(),
} = {}) {
  const days = Math.floor(Number(process.env.AGENT_RUN_RETENTION_DAYS) || 0);
  if (days <= 0 || typeof store?.pruneAgentRuns !== "function") {
    return { stop: () => {} };
  }

  async function run() {
    try {
      const n = await store.pruneAgentRuns(days);
      if (n > 0) logger.info(`[agent-run-prune] removed ${n} run(s) older than ${days}d`);
      const artifactOwners = artifactStore?.pruneOwners?.({
        scope: "run",
        olderThan: Date.now() - days * ONE_DAY_MS,
      }) ?? 0;
      if (artifactOwners > 0) {
        logger.info(`[agent-run-prune] removed artifacts for ${artifactOwners} expired run owner(s)`);
      }
    } catch (err) {
      logger.error("[agent-run-prune] error:", err);
    }
  }

  run();
  const timer = setInterval(run, ONE_DAY_MS);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
