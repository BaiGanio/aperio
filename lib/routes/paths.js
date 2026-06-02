// root/lib/routes/paths.js
import { resolve, dirname, basename, join } from "path";
import { realpathSync } from "fs";
import { homedir } from "os";
import { AsyncLocalStorage } from "node:async_hooks";

// Resolves symlinks on the longest existing prefix of p, then re-appends the
// non-existent tail. Needed for write targets that don't exist yet.
function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return resolve(realpathSafe(parent), basename(p));
  }
}

/**
 * Manages path validation and normalization for the Aperio ecosystem.
 *
 * WHY: Moving this here prevents 'mcp/index.js' from becoming a dumping ground
 * for configuration logic and allows tools like 'files.js' to use
 * validation without needing it injected via 'ctx'.
 *
 * The live allowed-folders list is a single, app-wide, DB-persisted allowlist
 * (settings['allowed-paths']). The model may both read and write anywhere under
 * it. APERIO_ALLOWED_PATHS_TO_READ / _TO_WRITE only SEED this list on first run
 * (when the setting is absent); afterward the DB is authoritative and the list
 * is edited via the UI (set_paths → setAllowlist). A hard FLOOR (project cwd +
 * scratch root) is always merged in so the workspace can never be excluded.
 *
 * loadAllowlist() hydrates the in-memory list from the DB at startup; getAllowlist()
 * returns it synchronously for the hot-path checks below. The pathStorage
 * (AsyncLocalStorage) context still carries the per-session scratch dir and, if a
 * caller ever narrows paths for a sub-scope, an override — otherwise checks fall
 * back to the global allowlist.
 */

const BASE_DIR = process.cwd();

function normalizePaths(envValue) {
  return (envValue || BASE_DIR)
    .split(",")
    .map(p => realpathSafe(resolve(p.trim().replace(/^~/, homedir()))));
}

function normalizeSingle(p) {
  return realpathSafe(resolve(p.trim().replace(/^~/, homedir())));
}

// Env-configured seed values, used only to populate the DB allowlist on first run.
export const DEFAULT_READ_PATHS  = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_READ);
export const DEFAULT_WRITE_PATHS = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_WRITE);

// Hard floor: always allowed so the model can never be locked out of its own
// workspace, no matter what the persisted list says.
const FLOOR = [BASE_DIR, normalizeSingle(join(BASE_DIR, "var/scratch"))];

// Merge a candidate list with the floor and dedupe (preserving order: floor last).
function withFloor(paths) {
  return [...new Set([...paths, ...FLOOR])];
}

// Live, app-wide allowed-folders list. Seeded from env, then hydrated from the
// DB by loadAllowlist(). getAllowlist() reads this synchronously on the hot path.
let allowlist = withFloor([...DEFAULT_WRITE_PATHS]);
let settingsStore = null;

/** The current app-wide allowed-folders list (read == write). */
export function getAllowlist() {
  return allowlist;
}

/**
 * Hydrate the in-memory allowlist from the DB at startup. If the setting is
 * absent (first run), seed it from the env defaults and persist. Stashes the
 * store so setAllowlist() can persist later updates.
 */
export async function loadAllowlist(store) {
  settingsStore = store;
  const saved = await store.getSetting("allowed-paths");
  if (saved && Array.isArray(saved.paths)) {
    allowlist = withFloor(saved.paths.map(normalizeSingle));
  } else {
    allowlist = withFloor([...DEFAULT_WRITE_PATHS]);
    await store.setSetting("allowed-paths", { paths: allowlist });
  }
  return allowlist;
}

/**
 * Replace the allowed-folders list. Normalizes, merges the floor, dedupes,
 * updates the in-memory list, and persists to the DB.
 */
export async function setAllowlist(paths) {
  allowlist = withFloor((paths || []).map(normalizeSingle));
  if (settingsStore) await settingsStore.setSetting("allowed-paths", { paths: allowlist });
  return allowlist;
}

// Per-connection path context — set via runWithPaths() in wsHandler.js so that
// async tool calls (which flow through MCP) see the right per-connection state.
export const pathStorage = new AsyncLocalStorage();

/**
 * Run fn within a path context scoped to the current async call chain.
 * Any isReadPathAllowed / isWritePathAllowed calls made inside fn (including
 * those deep in MCP tool handlers) will use these paths instead of the defaults.
 */
export function runWithPaths(readPaths, writePaths, scratchDir, fn) {
  return pathStorage.run({ readPaths, writePaths, scratchDir }, fn);
}

/** Returns the paths active in the current async context, or the global allowlist. */
export function getActivePaths() {
  const store = pathStorage.getStore();
  return {
    readPaths:  store?.readPaths  ?? allowlist,
    writePaths: store?.writePaths ?? allowlist,
  };
}

/**
 * The per-session scratch workspace active in the current async context, if any.
 * Tools (e.g. generate_xlsx) write generated artifacts here so they are pruned
 * with the session. Returns null outside a session-scoped context (e.g. CLI).
 */
export function getActiveScratchDir() {
  return pathStorage.getStore()?.scratchDir ?? null;
}

function isUnder(filePath, allowedPaths) {
  const real = realpathSafe(resolve(filePath.replace(/^~/, homedir())));
  return allowedPaths.some(
    allowed => real === allowed || real.startsWith(allowed + "/")
  );
}

/** True if the path is within a permitted read directory. */
export function isReadPathAllowed(filePath) {
  const local = pathStorage.getStore();
  return isUnder(filePath, local?.readPaths ?? allowlist);
}

/** True if the path is within a permitted write directory. */
export function isWritePathAllowed(filePath) {
  const local = pathStorage.getStore();
  return isUnder(filePath, local?.writePaths ?? allowlist);
}