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
 */

const BASE_DIR = process.cwd();

function normalizePaths(envValue) {
  return (envValue || BASE_DIR)
    .split(",")
    .map(p => resolve(p.trim().replace(/^~/, BASE_DIR)));
}

export const ALLOWED_READ_PATHS  = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_READ);
export const ALLOWED_WRITE_PATHS = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_WRITE);

function isUnder(filePath, allowedPaths) {
  const resolved = resolve(filePath.replace(/^~/, BASE_DIR));
  return allowedPaths.some(
    allowed => resolved === allowed || resolved.startsWith(allowed + "/")
  );
}

/** True if the path is within a permitted read directory. */
export function isReadPathAllowed(filePath) {
  return isUnder(filePath, ALLOWED_READ_PATHS);
}

/** True if the path is within a permitted write directory. */
export function isWritePathAllowed(filePath) {
  return isUnder(filePath, ALLOWED_WRITE_PATHS);
}