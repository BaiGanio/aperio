// lib/handlers/codegraph/codegraphHandlers.js
// MCP / HTTP handlers for the code graph. Dispatches to the Postgres or
// SQLite backend; other backends return a clean "not available" message.

import { pickBackend } from '../../codegraph/indexer.js';
import { readFile } from 'fs/promises';
import path from 'path';
import { logError } from '../../helpers/logger.js';

const NOT_AVAILABLE = {
  content: [{ type: "text", text: "❌ codegraph requires the Postgres or SQLite backend. Set DB_BACKEND=sqlite (zero-config) or DB_BACKEND=postgres." }],
  isError: true,
};

function asText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

// Wrap a handler body so any thrown error is logged with full stack and
// returned to the caller as a clean text error.
function safeHandler(name, fn) {
  return async (ctx, args = {}) => {
    try { return await fn(ctx, args); }
    catch (err) {
      if (err.userFacing) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }], isError: true };
      }
      logError(`[codegraph] ${name} failed`, err, { args });
      return {
        content: [{ type: "text", text: `❌ codegraph.${name} failed: ${err.message}` }],
        isError: true,
      };
    }
  };
}

function backendOf(ctx) {
  return pickBackend(ctx.store);
}

// ─── Implementations ──────────────────────────────────────────────────────────
async function _search(ctx, args) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  const result = await backend.mod.search(ctx.store, args, {
    generateEmbedding: ctx.generateEmbedding,
    vectorEnabled:     ctx.vectorEnabled,
  });
  return asText(result);
}

async function _repos(ctx) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  return asText(await backend.mod.repos(ctx.store));
}

async function _outline(ctx, args) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  return asText(await backend.mod.outline(ctx.store, args));
}

async function _context(ctx, { qualified, padding = 2, repo }) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  const sym = await backend.mod.context(ctx.store, { qualified, repo });
  if (!sym) {
    return { content: [{ type: "text", text: `No symbol matches qualified='${qualified}'` }], isError: true };
  }
  let snippet;
  try {
    const abs = path.join(sym.root_path, sym.path);
    const lines = (await readFile(abs, 'utf8')).split('\n');
    const start = Math.max(0, sym.start_line - 1 - padding);
    const end   = Math.min(lines.length, sym.end_line + padding);
    snippet = lines.slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(5, ' ')}  ${line}`)
      .join('\n');
  } catch {
    snippet = '<file not found — repo may have moved; reindex with `node lib/codegraph/indexer.js <path>`>';
  }
  return asText({
    qualified: sym.qualified, kind: sym.kind, name: sym.name,
    repo: path.basename(sym.root_path), root_path: sym.root_path,
    path: sym.path, lines: `${sym.start_line}-${sym.end_line}`,
    signature: sym.signature, doc: sym.doc, source: snippet,
  });
}

async function _callers(ctx, args) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  const result = await backend.mod.callers(ctx.store, args);
  if (result === null) return { content: [{ type: "text", text: `No symbol matches qualified='${args.qualified}'` }], isError: true };
  return asText({ qualified: args.qualified, depth: args.depth ?? 1, callers: result });
}

async function _callees(ctx, args) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  const result = await backend.mod.callees(ctx.store, args);
  if (result === null) return { content: [{ type: "text", text: `No symbol matches qualified='${args.qualified}'` }], isError: true };
  return asText({ qualified: args.qualified, depth: args.depth ?? 1, callees: result });
}

async function _deleteRepo(ctx, { path: rootPath }) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!rootPath) {
    const e = new Error("path is required"); e.userFacing = true; throw e;
  }
  return asText(await backend.mod.deleteRepo(ctx.store, rootPath));
}

// ─── Public exports ───────────────────────────────────────────────────────────
export const searchHandler     = safeHandler('search',     _search);
export const reposHandler      = safeHandler('repos',      _repos);
export const outlineHandler    = safeHandler('outline',    _outline);
export const contextHandler    = safeHandler('context',    _context);
export const callersHandler    = safeHandler('callers',    _callers);
export const calleesHandler    = safeHandler('callees',    _callees);
export const deleteRepoHandler = safeHandler('deleteRepo', _deleteRepo);
