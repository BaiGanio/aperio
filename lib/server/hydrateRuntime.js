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

  const { generateEmbedding, initEmbeddings, disposeEmbeddings, checkEmbeddingProvider, isEmbeddingDisabled } = await import("../helpers/embeddings.js");

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

  // Any store marked stale by the check above (or left mid-reindex by a
  // previous run) is rebuilt in the background; until it finishes those stores
  // serve full-text results only. Issue #287.
  //
  // Skipped entirely when embeddings are disabled: generateEmbedding() would
  // return null for every row, so the driver would clear each stale store's
  // vectors, fail every row against the null provider, and strand every store
  // in `reindexing` — destroying vectors from a still-valid prior
  // configuration to serve a no-op.
  //
  // Skipped just as entirely when the platform has no sqlite-vec extension:
  // the vec_* sidecars are ordinary tables there, so a full pass would spend
  // one embedding call per row on blobs no query can MATCH and reconciliation
  // wipes on the next supported boot. runReindex enforces this too; checking
  // here keeps the driver from announcing a rebuild it will not do.
  const { vectorStorageSupported } = await import("../helpers/vecMeta.js");
  let shutdownReindex = async () => {};
  if (isEmbeddingDisabled()) {
    logger.info("[reindex] embeddings disabled by configuration — skipping background reindex.");
  } else if (!vectorStorageSupported(store)) {
    logger.info(
      "[reindex] vector search is unavailable on this platform — skipping background reindex; " +
      "stale stores serve full-text results and are rebuilt when the database is opened where sqlite-vec loads."
    );
  } else {
    const { startBackgroundReindex } = await import("../embeddings/reindex.js");
    const { getEmbeddingSignature } = await import("../helpers/embeddings.js");
    const { signatureString } = await import("../helpers/vecMeta.js");
    const embeddingSignature = getEmbeddingSignature();
    ({ shutdown: shutdownReindex } = startBackgroundReindex(store, {
      generateEmbedding,
      signature: signatureString(embeddingSignature),
      dims: embeddingSignature.dims,
    }));
  }

  const { EventEmitter } = await import("events");
  const watcherEvents = new EventEmitter();
  const { createWatcherRegistry } = await import("../helpers/watcher-registry.js");
  const watcherRegistry = createWatcherRegistry();
  const { createFolderIndexingService } = await import("../services/folder-indexing.js");
  const folderIndexer = createFolderIndexingService({ store, watcherEvents, watcherRegistry });

  return {
    store, generateEmbedding, disposeEmbeddings, shutdownEmbeddings, shutdownReindex,
    getAllowlist, watcherEvents, watcherRegistry, folderIndexer,
  };
}
