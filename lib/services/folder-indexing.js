import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import { pickBackend as pickCodeBackend } from "../codegraph/indexer.js";
import { startWatcher as startCodeWatcher } from "../codegraph/watcher.js";
import { addRoot as addCodeRoot, markAllDone as markCodeDone } from "../codegraph/status.js";
import { pickBackend as pickDocBackend } from "../docgraph/indexer.js";
import { startWatcher as startDocWatcher } from "../docgraph/watcher.js";
import { addRoot as addDocRoot, markAllDone as markDocDone } from "../docgraph/status.js";
import { expandTilde, isReadPathAllowed } from "../routes/paths.js";
import { logError } from "../helpers/logger.js";

const VALID_TARGETS = new Set(["code", "documents", "both"]);

export class FolderIndexingError extends Error {
  constructor(message, { status = 400, code = "INDEXING_ERROR", path = null } = {}) {
    super(message);
    this.name = "FolderIndexingError";
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

function defaultResolveDirectory(raw) {
  const abs = resolve(expandTilde(raw));
  if (!existsSync(abs)) return { abs, exists: false, isDirectory: false };
  return { abs: realpathSync(abs), exists: true, isDirectory: statSync(abs).isDirectory() };
}

function defaultKinds(store) {
  const listRoots = async (pickBackend) => {
    const backend = pickBackend(store);
    if (!backend) {
      throw new FolderIndexingError("Folder indexing requires the SQLite or Postgres backend.", {
        code: "BACKEND_UNAVAILABLE",
      });
    }
    const result = await backend.mod.repos(store);
    return result?.repos ?? [];
  };
  return {
    code: {
      panel: "Code Graph",
      registryKind: "codegraph",
      listRoots: () => listRoots(pickCodeBackend),
      addRoot: addCodeRoot,
      startWatcher: startCodeWatcher,
      markAllDone: markCodeDone,
    },
    documents: {
      panel: "Document Graph",
      registryKind: "docgraph",
      listRoots: () => listRoots(pickDocBackend),
      addRoot: addDocRoot,
      startWatcher: startDocWatcher,
      markAllDone: markDocDone,
    },
  };
}

function rootPath(entry) {
  return typeof entry === "string" ? entry : entry?.root_path;
}

function covers(root, candidate) {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Owns user-triggered indexing in the main application process so the watcher
 * registry and the progress objects read by the UI stay in the same process.
 */
export function createFolderIndexingService({ store, watcherEvents, watcherRegistry, deps = {} } = {}) {
  const registry = watcherRegistry ?? { register: async () => {} };
  const resolveDirectory = deps.resolveDirectory ?? defaultResolveDirectory;
  const pathAllowed = deps.isReadPathAllowed ?? isReadPathAllowed;
  const kinds = deps.kinds ?? defaultKinds(store);
  const reportError = deps.logError ?? logError;
  const inFlight = new Map();

  async function queueTarget(target, abs) {
    const kind = kinds[target];
    if (!kind) throw new FolderIndexingError(`Unsupported indexing target: ${target}`);

    const roots = await kind.listRoots();
    const coveredBy = roots.map(rootPath).filter(Boolean).find((root) => covers(root, abs));
    if (coveredBy) {
      return { entry: { target, status: "already_indexed", panel: kind.panel, coveredBy }, settled: null };
    }

    const key = `${target}:${abs}`;
    const pending = inFlight.get(key);
    if (pending) {
      return { entry: { target, status: "in_progress", panel: kind.panel }, settled: pending };
    }

    kind.addRoot(abs);
    const run = Promise.resolve().then(async () => {
      try {
        const handle = await kind.startWatcher(store, abs, watcherEvents);
        await registry.register(kind.registryKind ?? target, abs, handle);
      } catch (err) {
        reportError(`[${kind.registryKind ?? target}] conversational indexing failed`, err, { abs });
      } finally {
        kind.markAllDone();
        inFlight.delete(key);
      }
    });
    inFlight.set(key, run);
    return { entry: { target, status: "started", panel: kind.panel }, settled: run };
  }

  async function start({ path, target } = {}) {
    const raw = String(path ?? "").trim();
    if (!raw) throw new FolderIndexingError("path is required", { code: "PATH_REQUIRED" });
    if (!VALID_TARGETS.has(target)) {
      throw new FolderIndexingError("target must be one of: code, documents, both", { code: "INVALID_TARGET" });
    }

    const resolved = resolveDirectory(raw);
    if (!resolved.exists || !resolved.isDirectory) {
      throw new FolderIndexingError(`Not a directory: ${resolved.abs}`, {
        code: "NOT_A_DIRECTORY",
        path: resolved.abs,
      });
    }
    if (!pathAllowed(resolved.abs)) {
      throw new FolderIndexingError(
        `Path is outside Allowed Paths. Authorize it in the Paths panel, then try again: ${resolved.abs}`,
        { status: 403, code: "PATH_NOT_ALLOWED", path: resolved.abs },
      );
    }

    const requested = target === "both" ? ["code", "documents"] : [target];
    const queued = [];
    for (const item of requested) queued.push(await queueTarget(item, resolved.abs));
    const result = { ok: true, path: resolved.abs, targets: queued.map(({ entry }) => entry) };
    Object.defineProperty(result, "settled", {
      enumerable: false,
      value: Promise.allSettled(queued.map(({ settled }) => settled).filter(Boolean)),
    });
    return result;
  }

  return { start };
}
