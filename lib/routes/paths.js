// root/lib/routes/paths.js
import { resolve } from "path";

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
 * updatePaths() mutates these arrays in-place so all existing imports reflect
 * the change without re-importing. Changes are session-only (not persisted).
 */

const BASE_DIR = process.cwd();

function normalizePaths(envValue) {
  return (envValue || BASE_DIR)
    .split(",")
    .map(p => resolve(p.trim().replace(/^~/, BASE_DIR)));
}

function normalizeSingle(p) {
  return resolve(p.trim().replace(/^~/, BASE_DIR));
}

export const ALLOWED_READ_PATHS  = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_READ);
export const ALLOWED_WRITE_PATHS = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_WRITE);

// Frozen snapshots of the env-configured defaults (for display in the UI).
export const DEFAULT_READ_PATHS  = [...ALLOWED_READ_PATHS];
export const DEFAULT_WRITE_PATHS = [...ALLOWED_WRITE_PATHS];

/**
 * Replace the active path lists for this session.
 * Mutates the exported arrays in-place so all importers see the new values.
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
  const resolved = resolve(filePath.replace(/^~/, BASE_DIR));
  return allowedPaths.some(
    allowed => resolved === allowed || resolved.startsWith(allowed + "/")
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
  return isUnder(filePath, ALLOWED_READ_PATHS);
}

/** True if the path is within a permitted write directory. */
export function isWritePathAllowed(filePath) {
  return isUnder(filePath, ALLOWED_WRITE_PATHS);
}