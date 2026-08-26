// lib/server/backgroundWorkers.js — memory dedup/infer workers (gated to local
// providers for privacy unless explicitly overridden) plus the always-on
// session/log/run pruners. Returned instances feed straight into
// createGracefulShutdown().

import logger from "../helpers/logger.js";
import { resolve } from "path";

export async function createBackgroundWorkers({ providerName, callTool, store, runtimeRoot }) {
  const { isLocalProvider } = await import("../providers/index.js");
  const { deduplicateMemories } = await import("../workers/deduplicate.js");
  const { inferMemories } = await import("../workers/infer.js");
  const { createSessionPruner } = await import("../workers/session-prune.js");
  const { createAgentRunPruner } = await import("../workers/agent-run-prune.js");
  const { createLlamaLogPruner } = await import("../workers/llamacpp-log-prune.js");
  const { createArtifactStore } = await import("../context/artifactStore.js");

  const memoryWorkersEnabled =
    isLocalProvider(providerName) || process.env.APERIO_CLOUD_MEMORY_WORKERS === "1";
  if (!memoryWorkersEnabled) {
    logger.info(`[privacy] memory inference/dedup workers disabled on cloud provider "${providerName}" (set APERIO_CLOUD_MEMORY_WORKERS=1 to override)`);
  }
  const noopWorker = { stop() {} };
  const dedup     = memoryWorkersEnabled ? deduplicateMemories(callTool) : noopWorker;
  const infer     = memoryWorkersEnabled ? inferMemories(callTool)       : noopWorker;
  const pruner    = createSessionPruner();
  const logPruner = createLlamaLogPruner();
  const runPruner = createAgentRunPruner({
    store,
    artifactStore: createArtifactStore({ rootDir: resolve(runtimeRoot, "var", "agent-artifacts") }),
  });

  return { dedup, infer, pruner, logPruner, runPruner };
}
