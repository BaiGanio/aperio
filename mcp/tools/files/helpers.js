// mcp/tools/files/helpers.js — shared constants, secret-file gate, and error/text
// formatting used by every file tool handler.

import { extname, basename } from "path";
import { getActivePaths } from "../../../lib/routes/paths.js";

export const ALLOWED_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".rs", ".java",
  ".json", ".yaml", ".yml", ".toml", ".md", ".txt", ".html",
  ".css", ".sql", ".sh",
]);

// Secret/dotfile deny-list, checked BEFORE the extension allowlist so env files
// and known credential files (which may carry an otherwise-allowed extension,
// e.g. .env.example) can't be read/edited through it (INPUT-01).
const DENIED_BASENAMES = new Set([
  ".npmrc", ".netrc", ".pgpass", ".htpasswd", ".dockercfg",
  ".git-credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);
const DENIED_EXTENSIONS = new Set([".pem", ".key", ".pfx", ".p12", ".keystore"]);
export function isSecretFile(filePath) {
  const base = basename(filePath).toLowerCase();
  if (base.startsWith(".env")) return true;   // .env, .env.local, .env.example, …
  if (DENIED_BASENAMES.has(base)) return true;
  return DENIED_EXTENSIONS.has(extname(base));
}
export const READ_FILE_CHUNK_SIZE = 500;
export const READ_FILE_MAX_OFFSET = 10_000;

export const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "__pycache__", ".venv", "venv"]);
export const KEY_FILES = new Set(["package.json", "README.md", "readme.md", "pyproject.toml", "Cargo.toml", "go.mod", "docker-compose.yml"]);
export const CODE_EXTS = new Set([".js", ".ts", ".py", ".go", ".rs", ".java", ".jsx", ".tsx"]);

export function formatPathError(action, filePath) {
  const active   = getActivePaths();
  const paths    = action === "Read" ? active.readPaths : active.writePaths;
  const primary  = paths[0] ?? process.cwd();
  const list     = paths.map(p => `  - ${p}`).join("\n");
  // Guess a corrected path: strip any leading prefix that looks like a wrong
  // root alias and re-anchor to the actual primary allowed path.
  // Handles: /aperio/…, /home/user/projects/aperio/…, /project/…, etc.
  const projectName = primary.split("/").pop();
  const projectRe  = new RegExp(`^.*?/${projectName}(?=/|$)`);
  const tail = filePath.replace(projectRe, "")    // strip up to and including /aperio
                        .replace(/^\/project\b/, ""); // /project/… → /…
  const suggested = tail ? `${primary}${tail}` : primary;
  return { content: [{ type: "text", text:
    `❌ ${action} not allowed: ${filePath}\n\n` +
    `CORRECT PATH TO USE: ${suggested}\n\n` +
    `Retry the tool call immediately with the corrected path above. Do NOT ask the user — ` +
    `you already have the information needed to proceed.\n\n` +
    `Allowed ${action.toLowerCase()} paths:\n${list}`
  }] };
}

export function textOut(text) {
  return { content: [{ type: "text", text }] };
}
