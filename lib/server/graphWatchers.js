// lib/server/graphWatchers.js — boots the codegraph/docgraph watcher for one
// graph kind: checks the env flag and backend availability, marks the graph
// enabled for its (deduped) roots, then starts the watcher in the background
// and registers every handle with the shared watcher registry so shutdown can
// stop it in one sweep.
//
// The full initial index (startAllWatchers) must NOT delay app readiness, so
// its promise is returned wrapped as { bootPromise } rather than directly:
// an async function auto-chains a directly-returned thenable, which would
// make `await bootGraphWatcher(...)` block on the entire index instead of
// just the cheap gate check (env flag / availability / markEnabled).

import logger from "../helpers/logger.js";
import { logError } from "../helpers/logger.js";

const AVAILABILITY_CHECK = {
  codegraph: "isCodegraphAvailable",
  docgraph: "isDocgraphAvailable",
};

export async function bootGraphWatcher({ kind, envFlag, store, roots, watcherEvents, watcherRegistry }) {
  if (process.env[envFlag] !== "on") return { bootPromise: null };

  const { [AVAILABILITY_CHECK[kind]]: isAvailable } = await import(`../${kind}/indexer.js`);
  if (!isAvailable(store)) {
    logger.warn(`[${kind}] APERIO_${kind.toUpperCase()}=on but backend has no graph store. Switch DB_BACKEND=sqlite or postgres.`);
    return { bootPromise: null };
  }

  const { markEnabled } = await import(`../${kind}/status.js`);
  const dedupedRoots = roots.filter(r =>
    !roots.some(other => other !== r && r.startsWith(other + "/"))
  );
  markEnabled(dedupedRoots);

  const bootPromise = (async () => {
    try {
      const { startAllWatchers } = await import(`../${kind}/watcher.js`);
      const { handles } = await startAllWatchers(store, roots, watcherEvents);
      for (const h of handles) await watcherRegistry.register(kind, h.root, h);
    } catch (err) {
      logError(`[${kind}] watcher boot failed`, err);
    }
  })();

  return { bootPromise };
}
