// root/lib/routes/paths.js
import { resolve, dirname, basename, join, isAbsolute, sep } from "path";
import { realpathSync, existsSync } from "fs";
import { homedir } from "os";
import { AsyncLocalStorage } from "node:async_hooks";

// Resolves symlinks on the longest existing prefix of p, then re-appends the
// non-existent tail. Needed for write targets that don't exist yet.
// Exported as the shared primitive: every module doing path containment must
// reuse this rather than hand-rolling realpath handling that can drift.
export function realpathSafe(p) {
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

// Expand a leading `~` to the user's home dir. The lookahead means only a bare
// `~` or `~/...` expands — `~user/...` is left untouched rather than mangled
// into `<home>user/...`.
export function expandTilde(p) {
  return p.replace(/^~(?=\/|$)/, homedir());
}

function normalizePaths(envValue) {
  return (envValue || BASE_DIR)
    .split(",")
    .map(p => realpathSafe(resolve(expandTilde(p.trim()))));
}

function normalizeSingle(p) {
  return realpathSafe(resolve(expandTilde(p.trim())));
}

// Env-configured seed values, used only to populate the DB allowlist on first run.
export const DEFAULT_READ_PATHS  = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_READ);
export const DEFAULT_WRITE_PATHS = normalizePaths(process.env.APERIO_ALLOWED_PATHS_TO_WRITE);

// Unified seed from both env vars — dedupe and remove children so the read
// ceiling always covers paths from APERIO_ALLOWED_PATHS_TO_READ even when
// APERIO_ALLOWED_PATHS_TO_WRITE is unset or different.
const DEFAULT_PATHS = removeRedundantChildren([...new Set([...DEFAULT_READ_PATHS, ...DEFAULT_WRITE_PATHS])]);

// Hard floor: always allowed so the model can never be locked out of its own
// workspace, no matter what the persisted list says.
const SCRATCH_ROOT = normalizeSingle(join(BASE_DIR, "var/scratch"));
const FLOOR = [BASE_DIR, SCRATCH_ROOT];

// Merge a candidate list with the floor and dedupe (preserving order: floor last).
function withFloor(paths) {
  return [...new Set([...paths, ...FLOOR])];
}

// Remove paths that are already covered by a parent in the same list.
function removeRedundantChildren(paths) {
  return paths.filter(p =>
    !paths.some(other => other !== p && p.startsWith(other + sep))
  );
}

// Live, app-wide allowed-folders list. Seeded from env, then hydrated from the
// DB by loadAllowlist(). getAllowlist() reads this synchronously on the hot path.
let userPaths  = [...DEFAULT_PATHS];
let allowlist  = withFloor(userPaths);
let settingsStore = null;

/** The current app-wide allowed-folders list (read == write), including the floor. */
export function getAllowlist() {
  return allowlist;
}

/** The user-configured paths only — floor paths excluded. Use this for UI display. */
export function getUserPaths() {
  return userPaths;
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
    const normalized = saved.paths.map(normalizeSingle);
    const cleaned = removeRedundantChildren(normalized);
    if (cleaned.length !== normalized.length) {
      await store.setSetting("allowed-paths", { paths: cleaned });
    }
    userPaths = cleaned;
    allowlist = withFloor(cleaned);
  } else {
    const seed = [...DEFAULT_PATHS];
    userPaths = seed;
    allowlist = withFloor(seed);
    await store.setSetting("allowed-paths", { paths: seed });
  }
  return allowlist;
}

/**
 * Replace the allowed-folders list. Normalizes, merges the floor, dedupes,
 * updates the in-memory list, and persists to the DB.
 */
export async function setAllowlist(paths) {
  const normalized = (paths || []).map(normalizeSingle);
  userPaths = normalized;
  allowlist = withFloor(normalized);
  if (settingsStore) await settingsStore.setSetting("allowed-paths", { paths: normalized });
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

/**
 * Resolve a model-supplied file/script path against the active session
 * workspace. A *bare/relative* path is rewritten to sit inside the per-session
 * scratch dir so files the model names with just a filename (generator scripts,
 * output PDFs/docx, intermediates) land in the workspace — served via /scratch
 * and pruned with the session — instead of the project root.
 *
 * Absolute and ~ paths are returned untouched except for files placed directly
 * in the legacy shared scratch root, which are rebased into the active session.
 * Outside a session context (no scratch dir) paths are returned unchanged, so
 * they fall back to the existing cwd-relative behavior.
 *
 * IMPORTANT: this only works where the scratch context is live — the main
 * process agent loop (wrapped in runWithPaths). The MCP runs as a long-lived
 * shared subprocess with no per-session scratch context, so paths must be
 * resolved here, before the tool call crosses into MCP.
 *
 * With `mustExist`, the scratch candidate is only used when it actually exists;
 * otherwise the original path is returned. Use this for tools that read or run
 * an existing file (read_file, edit_file, run_node_script, …) so a project file
 * referenced by a relative path (e.g. a skill script "skills/pdf/scripts/x.js")
 * still resolves against the project root. Without `mustExist` (write_file) the
 * scratch candidate is always used, since the file is being created.
 */
export function resolveScratchPath(p, { mustExist = false, redirectProjectRoot = false } = {}) {
  if (typeof p !== "string" || !p) return p;
  if (p.startsWith("~") || isAbsolute(p)) {
    const scratch = getActiveScratchDir();
    const abs = resolve(expandTilde(p));

    // Weaker models sometimes collapse the advertised session workspace to the
    // shared var/scratch root and copy that absolute form into later calls.
    // Rebase only files directly in the shared root; paths already inside a
    // session directory (or anywhere else) remain untouched. With mustExist,
    // prefer the rebased path only after the earlier write created it there.
    if (scratch && dirname(abs) === SCRATCH_ROOT) {
      const candidate = join(scratch, basename(abs));
      if (!mustExist || existsSync(candidate)) return candidate;
    }

    // For write operations: if the model sends an absolute path that would
    // create a new file directly in BASE_DIR, OR in a brand-new directory
    // created directly under BASE_DIR, redirect it to the session scratch
    // workspace. The one-level-deep case matters as much as the flat one: a
    // model asked for a PPTX/PDF/etc. routinely invents its own output folder
    // name (observed: "outputs/deck.pptx") — write_file's create_dirs would
    // otherwise silently mkdir -p a brand-new top-level folder into the real
    // project tree. This is deliberately bounded to ONE new level directly
    // under BASE_DIR (not arbitrary depth): a path like "lib/foo/new.js",
    // where "foo" doesn't exist yet but "lib" does, is left untouched because
    // it reads as genuine engineering work (a new subdirectory of an existing,
    // real project area), not an invented one-off output folder.
    if (redirectProjectRoot) {
      if (scratch && !existsSync(p)) {
        const parent = dirname(abs);
        if (parent === BASE_DIR ||
            (dirname(parent) === BASE_DIR && !existsSync(parent))) {
          return join(scratch, basename(abs));
        }
      }
    }
    return p;
  }
  const scratch = getActiveScratchDir();
  if (!scratch) return p;
  const candidate = join(scratch, p);
  if (mustExist && !existsSync(candidate)) return p;
  return candidate;
}

/**
 * True if `filePath` resolves (through symlinks) to `allowedPaths[n]` itself or
 * something beneath it. The single containment gate for the whole app — callers
 * outside this module must import this rather than re-implementing it.
 */
export function isUnder(filePath, allowedPaths) {
  const real = realpathSafe(resolve(expandTilde(filePath)));
  return allowedPaths.some(
    allowed => real === allowed || real.startsWith(allowed + sep)
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
