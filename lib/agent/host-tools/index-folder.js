import { randomBytes } from "node:crypto";

import {
  getActiveScratchDir,
  getAllowlist,
  getUserPaths,
  runWithPaths,
  setAllowlist,
} from "../../routes/paths.js";

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
// Abandoned proposals (the user never confirms) used to sit in the map for the
// process lifetime, holding a validated host path past its authorization window.
const MAX_PENDING_AUTHORIZATIONS = 32;

function formatResult(result) {
  const started = result.targets.filter((entry) => entry.status === "started");
  const active = result.targets.filter((entry) => entry.status === "in_progress");
  const existing = result.targets.filter((entry) => entry.status === "already_indexed");
  const lines = [];
  if (started.length) {
    lines.push(`✅ Indexing started for ${result.path}.`);
    lines.push(`Progress is available in the ${started.map((entry) => entry.panel).join(" and ")} panel${started.length === 1 ? "" : "s"}.`);
  }
  if (active.length) {
    lines.push(`Indexing is already in progress in the ${active.map((entry) => entry.panel).join(" and ")} panel${active.length === 1 ? "" : "s"}.`);
  }
  for (const entry of existing) {
    lines.push(`Already indexed in the ${entry.panel} panel${entry.coveredBy ? ` (covered by ${entry.coveredBy})` : ""}.`);
  }
  return lines.join("\n");
}

function defaultToken() {
  return `idx_${randomBytes(12).toString("hex")}`;
}

async function defaultAuthorizePath(path) {
  const paths = getUserPaths();
  if (!paths.includes(path)) await setAllowlist([...paths, path]);
}

function defaultRunWithUpdatedPaths(fn) {
  const paths = getAllowlist();
  return runWithPaths(paths, paths, getActiveScratchDir(), fn);
}

export function createIndexFolderTool(folderIndexer, {
  createToken = defaultToken,
  authorizePath = defaultAuthorizePath,
  runWithUpdatedPaths = defaultRunWithUpdatedPaths,
  now = () => Date.now(),
  authorizationTtlMs = AUTHORIZATION_TTL_MS,
  maxPendingAuthorizations = MAX_PENDING_AUTHORIZATIONS,
} = {}) {
  const pendingAuthorizations = new Map();

  // Drop every proposal whose window has closed, then enforce a hard cap so a
  // burst of unanswered proposals cannot grow the map without bound. The map is
  // insertion-ordered, so the oldest entries go first.
  function prunePendingAuthorizations() {
    const at = now();
    for (const [token, pending] of pendingAuthorizations) {
      if (pending.expiresAt < at) pendingAuthorizations.delete(token);
    }
    for (const token of pendingAuthorizations.keys()) {
      if (pendingAuthorizations.size < maxPendingAuthorizations) break;
      pendingAuthorizations.delete(token);
    }
  }

  function authorizationProposal(args, path) {
    prunePendingAuthorizations();
    const token = createToken();
    pendingAuthorizations.set(token, {
      args: { path, target: args.target },
      expiresAt: now() + authorizationTtlMs,
    });
    const panels = args.target === "both"
      ? "Code Graph and Document Graph"
      : args.target === "documents" ? "Document Graph" : "Code Graph";
    return [
      "📋 Folder authorization required — nothing has been changed yet.",
      "",
      `Target: ${path}`,
      `Index: ${panels}`,
      "",
      `Action: Authorize and index ${path}`,
      `Token: ${token}`,
    ].join("\n");
  }

  async function confirmAuthorization(token) {
    prunePendingAuthorizations();
    const pending = pendingAuthorizations.get(token);
    pendingAuthorizations.delete(token);
    if (!pending || pending.expiresAt < now()) {
      return "❌ This folder-indexing confirmation is invalid or expired. Ask to index the folder again.";
    }
    await authorizePath(pending.args.path);
    const result = await runWithUpdatedPaths(() => folderIndexer.start(pending.args));
    return `✅ Authorized ${pending.args.path}.\n${formatResult(result)}`;
  }

  return {
    name: "index_folder",
    description:
      "Call this tool for every explicit indexing request for a folder, including when the folder may be outside Allowed Paths. Do not tell the user to add it manually. " +
      "Start live indexing for a folder and return immediately. If the folder is outside Allowed Paths, this tool presents an explicit confirmation action; after the user confirms, it authorizes the exact validated folder and starts indexing automatically. " +
      "Use target=code for repositories/codebases, target=documents for notes/PDFs/documents, and target=both only when the user explicitly asks for both. " +
      "If a bare folder request does not reveal which index is intended, ask the user to choose. Progress appears in the corresponding Code Graph or Document Graph panel.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or ~/ path to any existing directory. It may be outside Allowed Paths; Aperio will request confirmation before authorizing it.",
        },
        target: {
          type: "string",
          enum: ["code", "documents", "both"],
          description: "Which index to populate.",
        },
        confirmation_token: {
          type: "string",
          description: "Server-issued token used only by Aperio's confirmation action. Never invent one.",
        },
      },
      required: ["path", "target"],
      additionalProperties: false,
    },
    async handler(args) {
      try {
        if (args?.confirmation_token) return await confirmAuthorization(args.confirmation_token);
        return formatResult(await folderIndexer.start(args));
      } catch (err) {
        if (err?.code === "PATH_NOT_ALLOWED" && err.path) {
          return authorizationProposal(args, err.path);
        }
        return `❌ Could not start folder indexing: ${err.message}`;
      }
    },
  };
}

export { formatResult as formatIndexFolderResult };
