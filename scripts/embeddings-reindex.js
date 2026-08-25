// scripts/embeddings-reindex.js
//
// Operator-triggered reindex of any vector store left stale by an embedding
// provider/model/dimension change (issue #287, WS1.5).
//
//   npm run embeddings:reindex             → reindex every stale store
//   npm run embeddings:reindex -- --status  → report status, reindex nothing
//   npm run embeddings:reindex -- --store memories,wiki
//
// The server and MCP process both reindex in the background on boot, so this
// exists for the cases that background work does not cover: a headless
// deployment nobody restarts, a run that failed because the embedding provider
// was unreachable, or an operator who wants the rebuild to finish before
// putting the instance back into service.
//
// Safe to run against a live instance and safe to interrupt: work is tracked in
// vec_meta, so an interrupted run resumes rather than restarting, and a store
// only leaves `reindexing` once every one of its rows is embedded.

import { fileURLToPath } from "url";

function parseArgs(argv) {
  const args = { status: false, stores: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--status") args.status = true;
    else if (a === "--store") args.stores = String(argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    else if (a.startsWith("--store=")) args.stores = a.slice(8).split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const USAGE = `Usage: npm run embeddings:reindex [-- options]

  --status            Report per-store status and exit without reindexing
                      (still runs the configuration check, so a store whose
                      signature has changed is reported as needing a reindex)
  --store a,b         Only consider these stores (default: all)
  -h, --help          Show this message
`;

// `store` is injectable so callers (and tests) can drive the CLI against a
// store they already own; only a store this function opened itself is closed.
export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error, store: injectedStore = null } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    error(err.message);
    error(USAGE);
    return 2;
  }
  if (args.help) { log(USAGE); return 0; }

  const { config } = await import("dotenv");
  config();

  let store = injectedStore;
  if (!store) {
    const { getStore } = await import("../db/index.js");
    store = await getStore();
  }

  try {
    const { applyConfigToEnv } = await import("../lib/config-resolver.js");
    // Same reason mcp/index.js hydrates before touching embeddings: under the
    // default `db` precedence the authoritative provider setting lives in the
    // database, and reindexing against the wrong one would rebuild every
    // vector in a space nothing else uses.
    await applyConfigToEnv(store);

    const { getEmbeddingSignature, generateEmbedding, checkEmbeddingProvider, isEmbeddingDisabled } =
      await import("../lib/helpers/embeddings.js");
    const { signatureString, supportsVecMeta, vectorStorageSupported, VEC_STATUS } = await import("../lib/helpers/vecMeta.js");
    const { runReindex, listPendingStores } = await import("../lib/embeddings/reindex.js");

    if (!supportsVecMeta(store)) {
      error("This database predates vec_meta — start the server once to apply migrations, then re-run.");
      return 1;
    }

    // Establish the truth before reporting it: this seeds vec_meta on a
    // database that has never booted, and marks stores stale when the
    // configuration has moved on. Without it the CLI would report "nothing to
    // do" on exactly the databases that most need reindexing.
    await checkEmbeddingProvider(store);

    const current = getEmbeddingSignature();
    const signature = signatureString(current);
    log(`Embedding configuration: ${signature}`);

    const rows = await store.listVecMeta();
    const selected = args.stores ? rows.filter(r => args.stores.includes(r.store_name)) : rows;

    if (args.stores) {
      const unknown = args.stores.filter(n => !rows.some(r => r.store_name === n));
      if (unknown.length) {
        error(`Unknown store(s): ${unknown.join(", ")}. Known: ${rows.map(r => r.store_name).join(", ")}`);
        return 2;
      }
    }

    log("");
    for (const r of selected) {
      const mark = r.status === VEC_STATUS.CURRENT ? "ok" : "needs reindex";
      log(`  ${r.store_name.padEnd(15)} ${String(r.status).padEnd(11)} ${String(r.dims).padStart(5)}d  ${mark}`);
    }
    log("");

    if (args.status) return 0;

    // A disabled provider means generateEmbedding always returns null.
    // runReindex would still claim and clear each selected store first (the
    // one destructive step it always takes before re-embedding), then fail
    // every row and leave the store stuck in `reindexing` — destroying
    // existing vectors to produce nothing. The server guards the same
    // scenario in hydrateRuntime.js; the CLI needs the same guard since
    // nothing else stands between it and runReindex.
    if (isEmbeddingDisabled()) {
      error("EMBEDDING_PROVIDER is disabled — refusing to reindex. Reindexing would clear each selected store's vectors and then be unable to rebuild them; enable embeddings first.");
      return 1;
    }

    // No sqlite-vec on this machine: the vec_* sidecars are ordinary tables,
    // so a reindex would pay for one embedding per row and write blobs that no
    // query can MATCH — and that reconciliation destroys as soon as the
    // database is opened where the extension loads. runReindex refuses too;
    // this is here so the operator gets the reason instead of a silent no-op.
    // `--status` above still reports, so the stale stores stay visible.
    if (!vectorStorageSupported(store)) {
      error("Vector search is unavailable on this platform (sqlite-vec has no prebuilt extension) — refusing to reindex. The embeddings would be unsearchable here and discarded on the next machine that can load the extension; the stores stay marked stale and will be rebuilt there.");
      return 1;
    }

    const pending = (await listPendingStores(store))
      .filter(r => !args.stores || args.stores.includes(r.store_name));

    if (!pending.length) {
      log("Nothing to do — every selected store is already current.");
      return 0;
    }

    let lastLine = "";
    const { results } = await runReindex(store, {
      generateEmbedding,
      signature,
      dims: current.dims,
      stores: pending.map(r => r.store_name),
      onProgress: ({ store: name, done, failed }) => {
        // A running count, not a fraction: rows are read in pages as the run
        // goes, so there is no up-front corpus size to divide by.
        const line = `  ${name}: ${done} embedded${failed ? `, ${failed} failed` : ""}`;
        if (process.stdout.isTTY) {
          process.stdout.write(`\r${line.padEnd(Math.max(lastLine.length, line.length))}`);
          lastLine = line;
        }
      },
    });
    if (process.stdout.isTTY && lastLine) process.stdout.write("\n");

    log("");
    let failedStores = 0;
    for (const r of results) {
      log(`  ${r.store.padEnd(15)} ${r.done}/${r.total} embedded${r.failed ? `, ${r.failed} failed` : ""} — ${r.completed ? "current" : "still reindexing"}`);
      if (!r.completed) failedStores++;
    }

    if (failedStores) {
      error(`\n${failedStores} store(s) did not complete — they stay marked for reindex and will resume on the next run or restart.`);
      return 1;
    }
    log("\nAll selected stores are current — vector search re-enabled.");
    return 0;
  } finally {
    if (!injectedStore) {
      try { await store?.close?.(); } catch { /* closing is best-effort */ }
      try { await store?.pool?.end?.(); } catch { /* closing is best-effort */ }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
