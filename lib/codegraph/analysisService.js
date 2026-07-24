// lib/codegraph/analysisService.js
// Lazy, revision-invalidated analysis orchestration (issue #283 step 4). Sits
// between the handlers and a codegraph backend module: analyzes on the first
// read after a graph revision changes, persists via compare-before-commit, and
// reuses the warm snapshot while the revision is unchanged.

import { analyzeGraph, importCycles } from './analysis.js';

// Test instrumentation: how many times analyzeGraph() actually ran. Lets the
// suite prove "first read analyzes, warm read reuses" (group I).
let _computeCount = 0;
export function analysisComputeCount() { return _computeCount; }
export function _resetComputeCount() { _computeCount = 0; }

/**
 * Ensure the persisted snapshot is current for a repo. Recomputes + persists
 * only when analyzed_revision !== graph_revision.
 * @returns {{ revision:number, analyzed_at:string|null, recomputed:boolean, committed:boolean }}
 */
export async function ensureAnalysis(mod, store, repoId) {
  const rev = await mod.readRevisions(store, repoId);
  if (!rev) return null;
  const graphRev = Number(rev.graph_revision);
  const analyzedRev = rev.analyzed_revision == null ? null : Number(rev.analyzed_revision);

  if (analyzedRev != null && analyzedRev === graphRev) {
    return { revision: graphRev, analyzed_at: rev.analyzed_at, recomputed: false, committed: true };
  }

  const graph = await mod.loadGraph(store, repoId);
  _computeCount++;
  const snapshot = analyzeGraph(graph);
  const committed = await mod.persistAnalysis(store, repoId, graphRev, snapshot);
  return { revision: graphRev, analyzed_at: null, recomputed: true, committed };
}

/**
 * Build a bounded UI graph payload: community metadata plus at most `limit`
 * nodes (default 300, hard max 1000), prioritizing `focus` nodes then highest
 * degree with deterministic tie-breaks. Edges are restricted to retained nodes.
 *
 * `community`, when set, scopes the candidate node pool to that community
 * before ranking — without it, a small/low-degree community can be entirely
 * absent from the top-`limit` global pool and render as an empty selection.
 */
export async function buildGraphPayload(mod, store, repoId, { limit = 300, focus = [], community = null } = {}) {
  const cap = Math.min(Math.max(limit | 0, 1), 1000);
  const { nodes: allNodes, edges } = await mod.loadGraph(store, repoId);
  const metrics = await mod.readMetricsMap(store, repoId);
  const communities = await mod.readCommunities(store, repoId, 1000);

  const nodes = community == null || community === ''
    ? allNodes
    : allNodes.filter(n => String(metrics.get(n.id)?.community_id ?? '') === String(community));

  const focusSet = new Set(focus);
  const decorate = (n) => {
    const m = metrics.get(n.id);
    return {
      id: n.id, qualified: n.qualified, kind: n.kind, name: n.name, path: n.path ?? null,
      community_id: m?.community_id ?? null, degree: m?.degree ?? 0,
    };
  };

  // Priority: focus/path nodes first, then highest degree; deterministic ties.
  const sorted = [...nodes].sort((a, b) => {
    const fa = focusSet.has(a.qualified) ? 1 : 0, fb = focusSet.has(b.qualified) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    const da = metrics.get(a.id)?.degree ?? 0, db = metrics.get(b.id)?.degree ?? 0;
    if (da !== db) return db - da;
    return a.qualified < b.qualified ? -1 : a.qualified > b.qualified ? 1 : 0;
  });

  const kept = sorted.slice(0, cap);
  const keptIds = new Set(kept.map(n => n.id));
  const keptEdges = edges
    .filter(e => keptIds.has(e.src) && keptIds.has(e.dst))
    .map(e => ({ src: e.src, dst: e.dst, kind: e.kind, confidence: e.confidence ?? null, confidence_score: e.confidence_score ?? null }));

  return {
    communities,
    nodes: kept.map(decorate),
    edges: keptEdges,
    total_nodes: nodes.length,
    returned_nodes: kept.length,
    truncated: nodes.length > kept.length,
  };
}

export { importCycles };
