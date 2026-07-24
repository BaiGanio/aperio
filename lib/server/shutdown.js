// lib/server/shutdown.js — full graceful-shutdown sequence for a booted app
// instance: stop workers/watchers, drain WS clients, close HTTP, stop
// llama-server, flush embeddings, close the store, then force-exit as a backstop.

import logger from "../helpers/logger.js";

export function createGracefulShutdown({
  markShuttingDown,
  watchdog,
  dedup,
  infer,
  pruner,
  logPruner,
  runPruner,
  scheduler,
  apiRoutes,
  codegraphBoot,
  docgraphBoot,
  watcherRegistry,
  shutdownEmbeddings,
  wss,
  httpServer,
  stopLlamaCpp,
  disposeEmbeddings,
  store,
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
    runPruner.stop();
    scheduler.stop();
    apiRoutes?.dispose?.();   // metrics sampler and any other route-owned timers
    await Promise.race([
      Promise.allSettled([codegraphBoot, docgraphBoot].filter(Boolean)),
      new Promise(resolve => setTimeout(resolve, 500)),
    ]);
    await watcherRegistry.stopAll().catch(() => {});

    await shutdownEmbeddings(1500);

    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));

    httpServer.closeAllConnections?.();
    await new Promise(resolve => httpServer.close(resolve));

    await stopLlamaCpp().catch(() => {});

    await disposeEmbeddings();

    await store.close?.();

    await new Promise(resolve => logger.end(resolve));

    const forceExit = setTimeout(() => {
      process.exitCode = 0;
      process.exit(0);
    }, 750);
    forceExit.unref();
  };
}
