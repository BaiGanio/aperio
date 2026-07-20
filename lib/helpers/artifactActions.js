import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { isUnder, realpathSafe } from "../routes/paths.js";

export class ArtifactActionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ArtifactActionError";
    this.status = status;
  }
}

/** Resolve a browser-facing /scratch URL to one existing regular file. */
export function resolveScratchArtifactUrl(url, root = process.cwd()) {
  if (typeof url !== "string" || !url.startsWith("/scratch/")) {
    throw new ArtifactActionError("A scratch artifact URL is required.");
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, "http://aperio.local").pathname);
  } catch {
    throw new ArtifactActionError("Invalid scratch artifact URL.");
  }
  if (!pathname.startsWith("/scratch/") || pathname.includes("\0") || pathname.includes("\\")) {
    throw new ArtifactActionError("Invalid scratch artifact URL.");
  }

  const parts = pathname.slice("/scratch/".length).split("/");
  if (parts.length < 2 || parts.some(part => !part || part === "." || part === "..")) {
    throw new ArtifactActionError("Invalid scratch artifact path.");
  }

  // Containment goes through the app-wide gate in lib/routes/paths.js so that
  // any future hardening there (symlink/traversal edge cases) applies here too.
  const realRoot = realpathSafe(resolve(root, "var", "scratch"));
  const candidate = resolve(realRoot, ...parts);
  if (!isUnder(candidate, [realRoot])) {
    throw new ArtifactActionError("Artifact is outside the scratch workspace.");
  }

  const realFile = realpathSafe(candidate);
  let stats;
  try {
    stats = statSync(realFile);
  } catch {
    throw new ArtifactActionError("Artifact not found.", 404);
  }
  if (!stats.isFile()) {
    throw new ArtifactActionError("Artifact path is not a file.");
  }
  return realFile;
}

function execFileAsync(command, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, (err) => err ? reject(err) : resolvePromise());
  });
}

/** Reveal one generated artifact using the host platform's file manager. */
export async function revealScratchArtifact(url, {
  root = process.cwd(),
  platform = process.platform,
  execFileImpl = execFileAsync,
} = {}) {
  const file = resolveScratchArtifactUrl(url, root);
  if (platform === "darwin") {
    await execFileImpl("open", ["-R", file]);
  } else if (platform === "win32") {
    try {
      await execFileImpl("explorer.exe", [`/select,${file}`]);
    } catch (error) {
      // Explorer can return 1 after successfully handing the reveal to its existing process.
      if (error?.code !== 1) throw error;
    }
  } else if (platform === "linux") {
    await execFileImpl("xdg-open", [dirname(file)]);
  } else {
    throw new ArtifactActionError(`Showing files is not supported on ${platform}.`, 501);
  }
  return file;
}
