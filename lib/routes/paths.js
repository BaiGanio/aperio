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
 * DEFAULT_READ_PATHS / DEFAULT_WRITE_PATHS are immutable for the lifetime of
 * the process. Per-connection overrides are threaded via pathStorage
 * (AsyncLocalStorage) — see runWithPaths() and wsHandler.js. Every new
 * connection starts with copies of these defaults and may narrow them via
 * set_paths; no process-level mutable state exists so two tabs cannot
 * silently merge each other's path configs.
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

// Env-configured defaults — immutable for the lifetime of the process.
// Every new connection starts with these; per-connection overrides are
// threaded via pathStorage (AsyncLocalStorage).
export const DEFAULT_READ_PATHS  = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_READ);
export const DEFAULT_WRITE_PATHS = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_WRITE);

// Per-connection path context — set via runWithPaths() in wsHandler.js so that
// async tool calls (which flow through MCP) see the right per-connection state.
export const pathStorage = new AsyncLocalStorage();

/**
 * Run fn within a path context scoped to the current async call chain.
 * Any isReadPathAllowed / isWritePathAllowed calls made inside fn (including
 * those deep in MCP tool handlers) will use these paths instead of the defaults.
 */
export function runWithPaths(readPaths, writePaths, fn) {
  return pathStorage.run({ readPaths, writePaths }, fn);
}

/** Returns the paths active in the current async context, or the env defaults. */
export function getActivePaths() {
  const store = pathStorage.getStore();
  return {
    readPaths:  store?.readPaths  ?? DEFAULT_READ_PATHS,
    writePaths: store?.writePaths ?? DEFAULT_WRITE_PATHS,
  };
}

function isUnder(filePath, allowedPaths) {
  const real = realpathSafe(resolve(filePath.replace(/^~/, homedir())));
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
  return isUnder(filePath, local?.readPaths ?? DEFAULT_READ_PATHS);
}

/** True if the path is within a permitted write directory. */
export function isWritePathAllowed(filePath) {
  const local = pathStorage.getStore();
  return isUnder(filePath, local?.writePaths ?? DEFAULT_WRITE_PATHS);
}