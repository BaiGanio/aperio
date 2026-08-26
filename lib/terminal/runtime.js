// lib/terminal/runtime.js — MODE 2 (standalone) boot hydration.
//
// Extracted from runStandalone() so the terminal's config + allowed-folders
// hydration is exercisable by tests without booting an agent, a provider, or a
// readline loop — and so the import-order constraint below has one documented
// home instead of being re-derived every time someone adds an import to
// standalone.js.
//
// IMPORT-ORDER CONTRACT — this module must have NO static imports. Everything
// it needs is pulled in with `await import(...)` AFTER the environment has been
// hydrated. See hydrateTerminalRuntime() for why.

/**
 * Hydrate the standalone terminal's runtime: DB-stored config into process.env,
 * then the app-wide allowed-folders list.
 *
 * Both steps are non-fatal. On a broken or absent DB the terminal falls back to
 * the .env/default seed with a visible warning rather than refusing to start —
 * the terminal is the tool you reach for when the DB is broken, so locking it
 * out would remove the only thing that can fix it. The fallback is never wider
 * than the operator's own env seed, and the hard FLOOR in lib/routes/paths.js
 * (project cwd + var/scratch) still applies, so a failed hydrate can neither
 * lock the terminal out of its own workspace nor silently widen it.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.log] Called with a one-line human message per warning.
 * @returns {Promise<{store: object|null, runWithPaths: Function, getAllowlist: Function}>}
 */
export async function hydrateTerminalRuntime({ log } = {}) {
  const say = typeof log === "function" ? log : () => {};

  // Apply DB-stored config to process.env BEFORE picking a model or building
  // the agent, so standalone resolves config exactly like the server (issue
  // #182, Issue B). Without this the CLI used .env-only while the web UI used
  // DB values — same install, different effective config. Also populates the
  // provenance snapshot the /config command and ctx-clamp warning read.
  let store = null;
  try {
    const { getStore }         = await import("../../db/index.js");
    const { applyConfigToEnv } = await import("../config-resolver.js");
    const { applyLiteDefaults } = await import("../config.js");
    applyLiteDefaults(0);   // lite: pin DB_BACKEND before the store auto-detects
    store = await getStore();
    await applyConfigToEnv(store);
    applyLiteDefaults(1);   // lite last-resort defaults for vars still unset
  } catch (e) {
    say(`config: using .env/defaults — ${e.message}`);
  }

  // Dynamic, not a static import — the same trap as the lib/agent.js deferral
  // in standalone.js. lib/routes/paths.js builds DEFAULT_PATHS from
  // process.env.APERIO_ALLOWED_PATHS into a module-level constant AT IMPORT
  // TIME. Any static import of paths.js — direct, or transitively via a module
  // like lib/handlers/attachments — evaluates that constant before the
  // applyConfigToEnv() call above, so a DB-stored APERIO_ALLOWED_PATHS never
  // reaches the terminal's seed. Dropping DEFAULT_PATHS from an import list is
  // NOT enough: importing the module at all is what freezes it.
  const { runWithPaths, getAllowlist, loadAllowlist } =
    await import("../routes/paths.js");

  // Hydrate the one app-wide allowed-folders list from the DB, exactly as
  // lib/server/hydrateRuntime.js does for the server. Without this the terminal
  // ran on the env-derived seed alone: folders added in Settings → Allowed
  // folders (or authorized via index_folder) were invisible to it, and — the
  // security-relevant direction — folders REMOVED there were still writable in
  // it. Hydrating also hands paths.js the store, so a setAllowlist() from an
  // in-terminal index_folder confirm actually persists.
  try {
    if (!store) throw new Error("no database store");
    await loadAllowlist(store);
  } catch (e) {
    say(`allowed folders: using .env/defaults — ${e.message}`);
  }

  return { store, runWithPaths, getAllowlist };
}
