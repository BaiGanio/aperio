// lib/server/shutdown.js — full graceful-shutdown sequence for a booted app
// instance: stop workers/watchers, drain WS clients, close HTTP, stop
// llama-server, flush embeddings, close the store, then force-exit as a backstop.

import logger from "../helpers/logger.js";
import { stopExtractorPool as stopCodegraphExtractors } from "../codegraph/indexer.js";
import { stopExtractorPool as stopDocgraphExtractors } from "../docgraph/indexer.js";

export function createGracefulShutdown({
  markShuttingDown,
  watchdog,
  dedup,
  infer,
  pruner,
  logPruner,
  redactionMapPruner,
  runPruner,
  scheduler,
  apiRoutes,
  codegraphBoot,
  docgraphBoot,
  watcherRegistry,
  shutdownEmbeddings,
  shutdownReindex,
  wss,
  httpServer,
  stopLlamaCpp,
  disposeEmbeddings,
  store,
  closeAgents = async () => {},
}) {
  let shuttingDown = false;

  return async function gracefulShutdown() {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    markShuttingDown();

    watchdog.stop();
    dedup.stop();
    infer.stop();
    pruner.stop();
    logPruner.stop();
    redactionMapPruner.stop();
    runPruner.stop();
    scheduler.stop();
    apiRoutes?.dispose?.();   // metrics sampler and any other route-owned timers
    await Promise.race([
      Promise.allSettled([codegraphBoot, docgraphBoot].filter(Boolean)),
      new Promise(resolve => setTimeout(resolve, 500)),
    ]);
    await watcherRegistry.stopAll().catch(() => {});
    // The watchers are what drives indexing, so once they are stopped no
    // extraction can be requested. Both pools terminate themselves after an
    // idle period and are unref'd while idle, so this can never be what holds
    // shutdown up — it just means a thread is not left alive for 30 s after
    // the server has gone.
    stopCodegraphExtractors();
    stopDocgraphExtractors();

    await shutdownEmbeddings(1500);
    // Abandon any in-flight reindex; it resumes from `reindexing` next boot.
    await shutdownReindex?.(1500);

    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));

    httpServer.closeAllConnections?.();
    await new Promise(resolve => httpServer.close(resolve));

    await stopLlamaCpp().catch(() => {});

    await disposeEmbeddings();

    await closeAgents();

    await store.close?.();

    await new Promise(resolve => logger.end(resolve));

    const forceExit = setTimeout(() => {
      process.exitCode = 0;
      process.exit(0);
    }, 750);
    forceExit.unref();
  };
}
