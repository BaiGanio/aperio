// root/lib/routes/paths.js
import { resolve, dirname, basename } from "path";
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
 * Read  paths: APERIO_ALLOWED_PATHS_TO_READ  (comma-separated, defaults to cwd)
 * Write paths: APERIO_ALLOWED_PATHS_TO_WRITE (comma-separated, defaults to cwd)
 *
 * ALLOWED_READ_PATHS / ALLOWED_WRITE_PATHS are process-level defaults used when
 * no per-connection context is active. Per-connection overrides are threaded via
 * pathStorage (AsyncLocalStorage) — see runWithPaths() and wsHandler.js.
 *
 * updatePaths() mutates the process-level defaults. Changes are NOT persisted.
 */

const BASE_DIR = process.cwd();

function normalizePaths(envValue) {
  return (envValue || BASE_DIR)
    .split(",")
    .map(p => realpathSafe(resolve(p.trim().replace(/^~/, homedir()))));
}

function normalizeSingle(p) {
  return realpathSafe(resolve(p.trim().replace(/^~/, BASE_DIR)));
}

export const ALLOWED_READ_PATHS  = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_READ);
export const ALLOWED_WRITE_PATHS = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_WRITE);

// Frozen snapshots of the env-configured defaults (for display in the UI).
export const DEFAULT_READ_PATHS  = [...ALLOWED_READ_PATHS];
export const DEFAULT_WRITE_PATHS = [...ALLOWED_WRITE_PATHS];

// Per-connection path context — set via runWithPaths() in wsHandler.js so that
// async tool calls (which flow through MCP) see the right per-connection state.
export const pathStorage = new AsyncLocalStorage();

/**
 * Run fn within a path context scoped to the current async call chain.
 * Any isReadPathAllowed / isWritePathAllowed calls made inside fn (including
 * those deep in MCP tool handlers) will use these paths instead of the globals.
 */
export function runWithPaths(readPaths, writePaths, fn) {
  return pathStorage.run({ readPaths, writePaths }, fn);
}

/**
 * Replace the process-level default path lists.
 * Mutates the exported arrays in-place so all importers see the new values.
 * This affects new connections and any call not wrapped in runWithPaths().
 */
export function updatePaths({ readPaths, writePaths }) {
  if (Array.isArray(readPaths)) {
    ALLOWED_READ_PATHS.length = 0;
    ALLOWED_READ_PATHS.push(...readPaths.map(normalizeSingle));
  }
  if (Array.isArray(writePaths)) {
    ALLOWED_WRITE_PATHS.length = 0;
    ALLOWED_WRITE_PATHS.push(...writePaths.map(normalizeSingle));
  }
}

function isUnder(filePath, allowedPaths) {
  const real = realpathSafe(resolve(filePath.replace(/^~/, BASE_DIR)));
  return allowedPaths.some(
    allowed => real === allowed || real.startsWith(allowed + "/")
  );
}

/**
 * Filters path lists to only those within the env-configured defaults.
 * Prevents a tampered session file from granting broader access than .env allows.
 */
export function clampToDefaults({ readPaths = [], writePaths = [] }) {
  return {
    readPaths:  readPaths.filter(p => isUnder(p, DEFAULT_READ_PATHS)),
    writePaths: writePaths.filter(p => isUnder(p, DEFAULT_WRITE_PATHS)),
  };
}

/** True if the path is within a permitted read directory. */
export function isReadPathAllowed(filePath) {
  const local = pathStorage.getStore();
  return isUnder(filePath, local?.readPaths ?? ALLOWED_READ_PATHS);
}

/** True if the path is within a permitted write directory. */
export function isWritePathAllowed(filePath) {
  const local = pathStorage.getStore();
  return isUnder(filePath, local?.writePaths ?? ALLOWED_WRITE_PATHS);
}