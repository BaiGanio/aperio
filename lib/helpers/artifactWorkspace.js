import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { getActiveScratchDir } from "../routes/paths.js";

const DAY_MS = 24 * 60 * 60 * 1000;
let standaloneRunDir = null;
let sweepPromise = null;

function retentionMs() {
  return Math.max(1, Number(process.env.SESSION_RETENTION_DAYS) || 90) * DAY_MS;
}

async function pruneExpiredRunWorkspaces(scratchRoot, now = Date.now()) {
  let entries = [];
  try { entries = await readdir(scratchRoot, { withFileTypes: true }); }
  catch { return; }

  await Promise.all(entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith("mcp-"))
    .map(async entry => {
      const path = join(scratchRoot, entry.name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > retentionMs()) await rm(path, { recursive: true, force: true });
      } catch { /* another process may have removed it */ }
    }));
}

/**
 * Resolve the owned workspace for generated artifacts. Web and terminal turns
 * inherit their session scratch directory through AsyncLocalStorage. A raw MCP
 * process gets one run-scoped directory, retained and aged out like sessions.
 */
export async function getArtifactWorkspace() {
  const active = getActiveScratchDir();
  if (active) {
    return { dir: active, urlBase: `/scratch/${basename(active)}`, ownership: "session" };
  }

  const scratchRoot = resolve(process.cwd(), "var/scratch");
  if (!standaloneRunDir) standaloneRunDir = join(scratchRoot, `mcp-${randomUUID()}`);
  await mkdir(standaloneRunDir, { recursive: true });
  sweepPromise ??= pruneExpiredRunWorkspaces(scratchRoot);
  await sweepPromise;
  return {
    dir: standaloneRunDir,
    urlBase: `/scratch/${basename(standaloneRunDir)}`,
    ownership: "run",
  };
}

export { pruneExpiredRunWorkspaces };
