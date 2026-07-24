// lib/server/hydrateRuntime.js — DB/config hydration, allowlist load + codegraph
// repo sync, and embeddings init. Runs first in bootApp(): later steps (graph
// watchers, apiRouter) depend on its store/watcherRegistry/folderIndexer.

import logger from "../helpers/logger.js";

export async function hydrateRuntime() {
  const { getStore }           = await import("../../db/index.js");
  const { applyLiteDefaults }  = await import("../config.js");
  applyLiteDefaults(0);
  const store = await getStore();
  const { flushWizardConfig }  = await import("../helpers/setupPending.js");
  await flushWizardConfig(store);
  const { applyConfigToEnv }   = await import("../config-resolver.js");
  await applyConfigToEnv(store);
  const liteApplied = applyLiteDefaults(1);
  if (liteApplied.length) logger.info(`[config] lite defaults applied: ${liteApplied.join(", ")}`);

  const { generateEmbedding, initEmbeddings, disposeEmbeddings, checkEmbeddingProvider } = await import("../helpers/embeddings.js");

  // Hydrate allowed-folders
  const { loadAllowlist, getAllowlist, setAllowlist } = await import("../routes/paths.js");
  await loadAllowlist(store);
  try {
    const { pickBackend } = await import("../codegraph/indexer.js");
    const backend = pickBackend(store);
    if (backend) {
      const { repos: listRepos } = backend.mod;
      const { repos: indexed } = await listRepos(store);
      const current = getAllowlist();
      const toAdd = (indexed || []).map(r => r.root_path).filter(p => !current.some(a => p === a || p.startsWith(a + "/")));
      if (toAdd.length) {
        await setAllowlist([...current, ...toAdd]);
        logger.info(`[allowlist] synced ${toAdd.length} indexed repo(s): ${toAdd.join(", ")}`);
      }
    }
  } catch (err) {
    logger.warn(`[allowlist] repo sync skipped: ${err.message}`);
  }

  await checkEmbeddingProvider(store);
  const { shutdown: shutdownEmbeddings } = await initEmbeddings(store, generateEmbedding);

  const { EventEmitter } = await import("events");
  const watcherEvents = new EventEmitter();
  const { createWatcherRegistry } = await import("../helpers/watcher-registry.js");
  const watcherRegistry = createWatcherRegistry();
  const { createFolderIndexingService } = await import("../services/folder-indexing.js");
  const folderIndexer = createFolderIndexingService({ store, watcherEvents, watcherRegistry });

  return {
    store, generateEmbedding, disposeEmbeddings, shutdownEmbeddings,
    getAllowlist, watcherEvents, watcherRegistry, folderIndexer,
  };
}
