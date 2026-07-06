// Lossless, private storage for large agent inputs and tool results.
//
// This store is intentionally separate from var/scratch:
// - scratch contains user-facing deliverables served by the web application;
// - agent-artifacts contains internal context that must only be read through an
//   owner-scoped API.
//
// Artifacts are immutable. The metadata file is written last and acts as the
// commit marker for the paired binary content file.

import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { ensureSecureDir } from "../helpers/secureFile.js";

const STORE_VERSION = 1;
const SCOPES = Object.freeze({
  session: "sessions",
  run: "runs",
});
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const DEFAULT_MEDIA_TYPE = "text/plain; charset=utf-8";

function assertSegment(value, label) {
  if (typeof value !== "string" || !SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new TypeError(`${label} must be a safe non-empty identifier`);
  }
  return value;
}

function scopeDirectory(scope) {
  const dir = SCOPES[scope];
  if (!dir) throw new TypeError(`scope must be one of: ${Object.keys(SCOPES).join(", ")}`);
  return dir;
}

function toBuffer(content) {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) return Buffer.from(content);
  throw new TypeError("content must be a string, Buffer, or Uint8Array");
}

function validateLabel(value, label, fallback = null) {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "string" ||
    !resolved.trim() ||
    resolved.length > 256 ||
    CONTROL_CHARACTER.test(resolved)
  ) {
    throw new TypeError(`${label} must be a non-empty string of at most 256 characters`);
  }
  return resolved.trim();
}

function writeAtomicPrivate(target, data, tempId) {
  const temp = join(dirname(target), `.${basename(target)}.${tempId}.tmp`);
  try {
    writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    try { chmodSync(temp, 0o600); } catch { /* best-effort on exotic filesystems */ }
    renameSync(temp, target);
    try { chmodSync(target, 0o600); } catch { /* best-effort on exotic filesystems */ }
  } catch (err) {
    try { unlinkSync(temp); } catch { /* already renamed or never created */ }
    throw err;
  }
}

function parseMetadata(raw, expected) {
  let metadata;
  try {
    metadata = JSON.parse(raw);
  } catch {
    throw new Error(`Artifact metadata is corrupt: ${expected.artifactId}`);
  }
  if (
    metadata?.version !== STORE_VERSION ||
    metadata.id !== expected.artifactId ||
    metadata.scope !== expected.scope ||
    metadata.ownerId !== expected.ownerId ||
    !SHA256_HEX.test(metadata.sha256) ||
    !Number.isSafeInteger(metadata.byteCount) ||
    metadata.byteCount < 0 ||
    typeof metadata.mediaType !== "string" ||
    typeof metadata.sourceTool !== "string" ||
    typeof metadata.createdAt !== "string" ||
    Number.isNaN(Date.parse(metadata.createdAt))
  ) {
    throw new Error(`Artifact metadata does not match its owner: ${expected.artifactId}`);
  }
  return metadata;
}

/**
 * Create a private artifact store.
 *
 * @param {object} [options]
 * @param {string} [options.rootDir] Root storage directory.
 * @param {() => string} [options.idFactory] Artifact ID generator.
 * @param {() => (Date|string|number)} [options.now] Clock used for metadata.
 */
export function createArtifactStore({
  rootDir = join(process.cwd(), "var", "agent-artifacts"),
  idFactory = randomUUID,
  now = () => new Date(),
} = {}) {
  if (typeof rootDir !== "string" || !rootDir.trim()) {
    throw new TypeError("rootDir must be a non-empty path");
  }
  const root = resolve(rootDir);

  function paths(scope, ownerId, artifactId = null) {
    const scopeDir = scopeDirectory(scope);
    assertSegment(ownerId, "ownerId");
    if (artifactId !== null) assertSegment(artifactId, "artifactId");
    const ownerDir = join(root, scopeDir, ownerId);
    return {
      ownerDir,
      dataPath: artifactId === null ? null : join(ownerDir, `${artifactId}.bin`),
      metadataPath: artifactId === null ? null : join(ownerDir, `${artifactId}.json`),
    };
  }

  function put({
    scope,
    ownerId,
    content,
    mediaType = DEFAULT_MEDIA_TYPE,
    sourceTool,
  }) {
    const artifactId = assertSegment(idFactory(), "generated artifactId");
    const source = validateLabel(sourceTool, "sourceTool");
    const type = validateLabel(mediaType, "mediaType", DEFAULT_MEDIA_TYPE);
    const bytes = toBuffer(content);
    const { ownerDir, dataPath, metadataPath } = paths(scope, ownerId, artifactId);

    ensureSecureDir(root);
    ensureSecureDir(join(root, scopeDirectory(scope)));
    ensureSecureDir(ownerDir);

    if (existsSync(dataPath) || existsSync(metadataPath)) {
      throw new Error(`Artifact already exists and is immutable: ${artifactId}`);
    }

    let createdAt;
    try {
      createdAt = new Date(now()).toISOString();
    } catch {
      throw new TypeError("now must return a valid date value");
    }

    const metadata = Object.freeze({
      version: STORE_VERSION,
      id: artifactId,
      scope,
      ownerId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteCount: bytes.byteLength,
      mediaType: type,
      sourceTool: source,
      createdAt,
    });

    const tempBase = randomUUID();
    try {
      writeAtomicPrivate(dataPath, bytes, `${tempBase}.data`);
      writeAtomicPrivate(metadataPath, `${JSON.stringify(metadata)}\n`, `${tempBase}.meta`);
    } catch (err) {
      // Metadata is the commit marker. If it was not committed, do not leave an
      // inaccessible content file behind.
      if (!existsSync(metadataPath)) {
        try { unlinkSync(dataPath); } catch { /* nothing to roll back */ }
      }
      throw err;
    }

    return metadata;
  }

  function getMetadata({ scope, ownerId, artifactId }) {
    const { metadataPath } = paths(scope, ownerId, artifactId);
    if (!existsSync(metadataPath)) return null;
    return parseMetadata(readFileSync(metadataPath, "utf8"), { scope, ownerId, artifactId });
  }

  function read({ scope, ownerId, artifactId, verify = true }) {
    const { dataPath } = paths(scope, ownerId, artifactId);
    const metadata = getMetadata({ scope, ownerId, artifactId });
    if (!metadata || !existsSync(dataPath)) return null;
    const content = readFileSync(dataPath);
    if (verify) {
      const digest = createHash("sha256").update(content).digest("hex");
      if (digest !== metadata.sha256 || content.byteLength !== metadata.byteCount) {
        throw new Error(`Artifact content failed integrity verification: ${artifactId}`);
      }
    }
    return { metadata, content };
  }

  function removeOwner({ scope, ownerId }) {
    const { ownerDir } = paths(scope, ownerId);
    if (!existsSync(ownerDir)) return false;
    rmSync(ownerDir, { recursive: true, force: true });
    return true;
  }

  function listIds({ scope, ownerId }) {
    const { ownerDir } = paths(scope, ownerId);
    if (!existsSync(ownerDir)) return [];
    return readdirSync(ownerDir)
      .filter(name => name.endsWith(".json") && SAFE_SEGMENT.test(name.slice(0, -5)))
      .map(name => name.slice(0, -5))
      .sort();
  }

  function pruneOwners({ scope, olderThan }) {
    const cutoff = new Date(olderThan).getTime();
    if (!Number.isFinite(cutoff)) throw new TypeError("olderThan must be a valid date value");
    const scopeRoot = join(root, scopeDirectory(scope));
    if (!existsSync(scopeRoot)) return 0;
    let removed = 0;
    for (const ownerId of readdirSync(scopeRoot).filter(name => SAFE_SEGMENT.test(name))) {
      try {
        const ids = listIds({ scope, ownerId });
        if (!ids.length) continue;
        const expired = ids.every(artifactId => {
          const metadata = getMetadata({ scope, ownerId, artifactId });
          return metadata && Date.parse(metadata.createdAt) < cutoff;
        });
        if (expired && removeOwner({ scope, ownerId })) removed++;
      } catch {
        // Keep corrupt or unreadable owners for manual inspection rather than
        // deleting data whose age cannot be established safely.
      }
    }
    return removed;
  }

  return Object.freeze({
    rootDir: root,
    put,
    read,
    getMetadata,
    listIds,
    pruneOwners,
    removeOwner,
  });
}
