// lib/handlers/docgraph/docgraphHandlers.js
// MCP / HTTP handlers for the document graph. Dispatches to the SQLite backend;
// other backends return a clean "not available" message. Mirrors the codegraph
// handler shape: safeHandler wrapping, asText success, stale-file fallback.

import { pickBackend, deleteRepo } from '../../docgraph/indexer.js';
import path from 'path';
import { logError } from '../../helpers/logger.js';

const NOT_AVAILABLE = {
  content: [{ type: "text", text: "❌ docgraph requires the Postgres or SQLite backend. Set DB_BACKEND=sqlite (zero-config) or DB_BACKEND=postgres." }],
  isError: true,
};

function asText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function safeHandler(name, fn) {
  return async (ctx, args = {}) => {
    try { return await fn(ctx, args); }
    catch (err) {
      if (err.userFacing) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }], isError: true };
      }
      logError(`[docgraph] ${name} failed`, err, { args });
      return { content: [{ type: "text", text: `❌ docgraph.${name} failed: ${err.message}` }], isError: true };
    }
  };
}

const backendOf = (ctx) => pickBackend(ctx.store);

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
  const result = await backend.mod.outline(ctx.store, args);
  if (!result) return { content: [{ type: "text", text: `No indexed document matches path='${args.path}'` }], isError: true };
  return asText(result);
}

async function _context(ctx, { path: docPath, section_id, chunk_id, folder }) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  const ref = await backend.mod.context(ctx.store, { path: docPath, section_id, chunk_id, folder });
  if (!ref) {
    const key = chunk_id != null ? `chunk_id=${chunk_id}` : `section_id=${section_id}`;
    return { content: [{ type: "text", text: `No match for path='${docPath}' ${key}` }], isError: true };
  }
  return asText({
    path: ref.rel_path, repo: path.basename(ref.root_path), root_path: ref.root_path,
    heading: ref.heading, text: ref.text,
  });
}

async function _refs(ctx, args) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!args.ref) { const e = new Error('ref is required'); e.userFacing = true; throw e; }
  return asText(await backend.mod.refs(ctx.store, args));
}

async function _deleteRepo(ctx, { path: rootPath }) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!rootPath) { const e = new Error('path is required'); e.userFacing = true; throw e; }
  return asText(await deleteRepo(ctx.store, rootPath));
}

// ─── Public exports ───────────────────────────────────────────────────────────
export const searchHandler     = safeHandler('search',     _search);
export const reposHandler      = safeHandler('repos',      _repos);
export const outlineHandler    = safeHandler('outline',    _outline);
export const contextHandler    = safeHandler('context',    _context);
export const refsHandler       = safeHandler('refs',       _refs);
export const deleteRepoHandler = safeHandler('deleteRepo', _deleteRepo);
