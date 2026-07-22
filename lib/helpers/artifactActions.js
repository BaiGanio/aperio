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

function resolveArtifactUrl(url, root, allowedRoute) {
  if (typeof url !== "string" || !url.startsWith(`/${allowedRoute}/`)) {
    throw new ArtifactActionError(`A ${allowedRoute} artifact URL is required.`);
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, "http://aperio.local").pathname);
  } catch {
    throw new ArtifactActionError("Invalid scratch artifact URL.");
  }
  const routePrefix = `/${allowedRoute}/`;
  if (!pathname.startsWith(routePrefix) || pathname.includes("\0") || pathname.includes("\\")) {
    throw new ArtifactActionError(`Invalid ${allowedRoute} artifact URL.`);
  }

  const parts = pathname.slice(routePrefix.length).split("/");
  const expectedDepth = allowedRoute === "scratch" ? 2 : 1;
  if (parts.length < expectedDepth || (allowedRoute === "uploads" && parts.length !== 1)
      || parts.some(part => !part || part === "." || part === "..")) {
    throw new ArtifactActionError(`Invalid ${allowedRoute} artifact path.`);
  }

  // Containment goes through the app-wide gate in lib/routes/paths.js so that
  // any future hardening there (symlink/traversal edge cases) applies here too.
  const realRoot = realpathSafe(resolve(root, "var", allowedRoute));
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

/** Resolve a browser-facing /scratch URL to one existing regular file. */
export function resolveScratchArtifactUrl(url, root = process.cwd()) {
  return resolveArtifactUrl(url, root, "scratch");
}

/** Resolve a generated artifact from either the per-session or fallback store. */
export function resolveGeneratedArtifactUrl(url, root = process.cwd()) {
  if (typeof url !== "string") throw new ArtifactActionError("A generated artifact URL is required.");
  if (url.startsWith("/scratch/")) return resolveArtifactUrl(url, root, "scratch");
  if (url.startsWith("/uploads/")) return resolveArtifactUrl(url, root, "uploads");
  throw new ArtifactActionError("A generated artifact URL is required.");
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
  const file = resolveGeneratedArtifactUrl(url, root);
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
