// lib/handlers/codegraph/codegraphHandlers.js
// MCP / HTTP handlers for the code graph. Dispatches to the Postgres or
// SQLite backend; other backends return a clean "not available" message.

import { pickBackend } from '../../codegraph/indexer.js';
import { buildGraph, neighbors as graphNeighbors, shortestPath } from '../../codegraph/graph.js';
import { ensureAnalysis, buildGraphPayload, importCycles } from '../../codegraph/analysisService.js';
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

// Resolve which repo to load for a traversal. With an explicit `repo`, defer to
// the existing repo-resolution behavior. Otherwise the given qualified name(s)
// must live in exactly one common repo — ambiguity is an error, not a silent pick.
async function resolveTraversalRepo(mod, store, qualifieds, repo) {
  if (repo) return mod.resolveRepoId(store, repo);
  const repoSets = await Promise.all(qualifieds.map(q => mod.findReposForSymbol(store, q)));
  for (let i = 0; i < repoSets.length; i++) {
    if (repoSets[i].length === 0) {
      const e = new Error(`No indexed symbol matches '${qualifieds[i]}'.`); e.userFacing = true; e.notFound = true; throw e;
    }
    if (repoSets[i].length > 1) {
      const e = new Error(`Ambiguous symbol '${qualifieds[i]}' — present in multiple repos; pass repo to disambiguate.`); e.userFacing = true; throw e;
    }
  }
  // Intersect the singleton repo sets.
  const common = repoSets.reduce((acc, s) => acc.filter(id => s.includes(id)));
  return common.length ? common[0] : null; // null → endpoints in different repos
}

async function _neighbors(ctx, { qualified, repo, direction = 'both', kinds, depth = 1, limit = 50 }) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!qualified) { const e = new Error('qualified is required'); e.userFacing = true; throw e; }
  const repoId = await resolveTraversalRepo(backend.mod, ctx.store, [qualified], repo);
  if (repoId == null) {
    const e = new Error(`No indexed symbol matches '${qualified}'.`); e.userFacing = true; throw e;
  }
  const { nodes, edges } = await backend.mod.loadGraph(ctx.store, repoId);
  const graph = buildGraph(nodes, edges);
  const result = graphNeighbors(graph, qualified, { direction, kinds, depth, limit });
  if (!result) {
    return { content: [{ type: 'text', text: `No symbol matches qualified='${qualified}'` }], isError: true };
  }
  return asText(result);
}

async function _path(ctx, { from, to, repo, directed = false, kinds, max_depth = 6 }) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!from || !to) { const e = new Error('from and to are required'); e.userFacing = true; throw e; }
  const repoId = await resolveTraversalRepo(backend.mod, ctx.store, [from, to], repo);
  // Endpoints resolved to different repos → they cannot be connected.
  if (repoId == null) return asText({ found: false, from, to });
  const { nodes, edges } = await backend.mod.loadGraph(ctx.store, repoId);
  const graph = buildGraph(nodes, edges);
  const result = shortestPath(graph, from, to, { directed, kinds, maxDepth: max_depth });
  if (result == null) {
    const e = new Error(`No indexed symbol matches '${from}' or '${to}'.`); e.userFacing = true; throw e;
  }
  return asText(result);
}

const INSIGHT_VIEWS = new Set(['summary', 'communities', 'hotspots', 'bridges', 'cycles']);

async function _insights(ctx, { repo, view = 'summary', limit = 20 }) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!repo) { const e = new Error('repo is required'); e.userFacing = true; throw e; }
  if (!INSIGHT_VIEWS.has(view)) { const e = new Error(`Unknown view '${view}'. Use one of: ${[...INSIGHT_VIEWS].join(', ')}.`); e.userFacing = true; throw e; }
  const cap = Math.min(Math.max(limit | 0, 1), 50);
  const { mod } = backend;
  const repoId = await mod.resolveRepoId(ctx.store, repo);

  const meta = await ensureAnalysis(mod, ctx.store, repoId);
  if (!meta) { const e = new Error(`Repo '${repo}' has no indexed graph yet.`); e.userFacing = true; throw e; }
  const base = { repo, analyzed_revision: meta.revision, analyzed_at: meta.analyzed_at, view };

  switch (view) {
    case 'communities': return asText({ ...base, communities: await mod.readCommunities(ctx.store, repoId, cap) });
    case 'hotspots':    return asText({ ...base, hotspots: await mod.readHotspots(ctx.store, repoId, cap) });
    case 'bridges':     return asText({ ...base, bridges: await mod.readBridges(ctx.store, repoId, cap) });
    case 'cycles':      return asText({ ...base, cycles: importCycles(await mod.loadGraph(ctx.store, repoId), { limit: cap }) });
    default:            return asText({ ...base, summary: await mod.analysisSummary(ctx.store, repoId) });
  }
}

async function _graph(ctx, { repo, limit = 300, focus }) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!repo) { const e = new Error('repo is required'); e.userFacing = true; throw e; }
  const { mod } = backend;
  const repoId = await mod.resolveRepoId(ctx.store, repo);
  const meta = await ensureAnalysis(mod, ctx.store, repoId);
  if (!meta) { const e = new Error(`Repo '${repo}' has no indexed graph yet.`); e.userFacing = true; throw e; }
  const focusList = Array.isArray(focus) ? focus : focus ? [focus] : [];
  const payload = await buildGraphPayload(mod, ctx.store, repoId, { limit, focus: focusList });
  return asText({ repo, analyzed_revision: meta.revision, ...payload });
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
export const neighborsHandler  = safeHandler('neighbors',  _neighbors);
export const pathHandler       = safeHandler('path',       _path);
export const insightsHandler   = safeHandler('insights',   _insights);
export const graphHandler      = safeHandler('graph',      _graph);
export const deleteRepoHandler = safeHandler('deleteRepo', _deleteRepo);
