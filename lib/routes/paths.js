import { resolve } from "path";

/**
 * Manages path validation and normalization for the Aperio ecosystem.
 * 
 * WHY: Moving this here prevents 'mcp/index.js' from becoming a dumping ground 
 * for configuration logic and allows tools like 'files.js' to use 
 * validation without needing it injected via 'ctx'.
 */

const BASE_DIR = process.cwd();

// Load and normalize the allowed paths from environment variables
const ALLOWED_PATHS = (process.env.APERIO_ALLOWED_PATHS || BASE_DIR)
  .split(",")
  .map(p => p.trim().replace(/^~/, BASE_DIR));

/**
 * Validates if a given file path falls within the permitted directory boundaries.
 * @param {string} filePath - The path to check.
 * @returns {boolean} - True if the path is safe and allowed.
 */
export function isPathAllowed(filePath) {
  // Normalize '~' to the current working directory
  const resolved = filePath.startsWith("~") 
    ? filePath.replace("~", BASE_DIR) 
    : filePath;

  return ALLOWED_PATHS.some(allowed => 
    resolved.startsWith(allowed + "/") || resolved === allowed
  );
}

export { ALLOWED_PATHS };