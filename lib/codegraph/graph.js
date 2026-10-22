// lib/codegraph/graph.js
// Shared, backend-agnostic in-memory graph for one repository. Both the SQLite
// and Postgres backends load the same { nodes, edges } shape via loadGraph(); this
// module builds a directed adjacency index and runs deterministic neighbors and
// bounded shortest-path traversal over it. Traversal is dependency-free — the
// Graphology-based community analysis (issue #283 step 4) is layered separately
// on the same loaded rows.
//
// Determinism is a contract: identical inputs always yield identically ordered
// nodes/edges, so MCP/HTTP snapshots are stable. Ordering key is the node's
// `qualified` name (unique within a repo), then edge kind.

/**
 * @typedef {{ id:number, qualified:string, kind:string, name:string, path?:string, root_path?:string }} GraphNode
 * @typedef {{ src:number, dst:number, kind:string, confidence?:string, confidence_score?:number, relation_context?:string }} GraphEdge
 */

/**
 * Build a directed adjacency index from repository rows.
 * @param {GraphNode[]} nodes
 * @param {GraphEdge[]} edges — only resolved edges (dst not null)
 */
export function buildGraph(nodes, edges) {
  const byId = new Map();
  const byQualified = new Map();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (!byQualified.has(n.qualified)) byQualified.set(n.qualified, n.id);
  }
  const out = new Map(); // srcId → [{ to, edge }]
  const inn = new Map(); // dstId → [{ to, edge }]
  for (const e of edges) {
    if (!byId.has(e.src) || !byId.has(e.dst)) continue;
    if (!out.has(e.src)) out.set(e.src, []);
    if (!inn.has(e.dst)) inn.set(e.dst, []);
    out.get(e.src).push({ to: e.dst, edge: e });
    inn.get(e.dst).push({ to: e.src, edge: e });
  }
  return { byId, byQualified, out, inn, nodeCount: byId.size, edgeCount: edges.length };
}

// Resolve a qualified name to a node id (or null). Callers surface not-found.
export function nodeIdFor(graph, qualified) {
  return graph.byQualified.get(qualified) ?? null;
}

function edgeView(graph, e) {
  return {
    from: graph.byId.get(e.src)?.qualified ?? null,
    to: graph.byId.get(e.dst)?.qualified ?? null,
    kind: e.kind,
    confidence: e.confidence ?? null,
    confidence_score: e.confidence_score ?? null,
  };
}

function nodeView(graph, id, hop) {
  const n = graph.byId.get(id);
  return {
    qualified: n.qualified, kind: n.kind, name: n.name,
    path: n.path ?? null, repo: n.repo ?? null, hop,
  };
}

// Collect the outgoing candidate edges from a node for a given traversal
// direction, filtered by relation kinds, in a deterministic order.
function stepEdges(graph, id, direction, kindSet) {
  const cands = [];
  if (direction === 'out' || direction === 'both') {
    for (const { to, edge } of graph.out.get(id) ?? []) cands.push({ to, edge });
  }
  if (direction === 'in' || direction === 'both') {
    for (const { to, edge } of graph.inn.get(id) ?? []) cands.push({ to, edge });
  }
  const filtered = kindSet ? cands.filter(c => kindSet.has(c.edge.kind)) : cands;
  // Deterministic: by neighbor qualified, then edge kind.
  filtered.sort((a, b) => {
    const qa = graph.byId.get(a.to)?.qualified ?? '';
    const qb = graph.byId.get(b.to)?.qualified ?? '';
    return qa < qb ? -1 : qa > qb ? 1 : (a.edge.kind < b.edge.kind ? -1 : a.edge.kind > b.edge.kind ? 1 : 0);
  });
  return filtered;
}

/**
 * BFS neighborhood around a seed. Each node carries its minimum hop; results are
 * deterministically ordered and honestly truncated at `limit` (excludes seed).
 *
 * @returns {{ seed, nodes, edges, truncated, returned, total }} or null if seed unknown
 */
export function neighbors(graph, seedQualified, { direction = 'both', kinds = null, depth = 1, limit = 50 } = {}) {
  const seedId = nodeIdFor(graph, seedQualified);
  if (seedId == null) return null;

  const d = Math.min(Math.max(depth | 0, 1), 3);
  const cap = Math.min(Math.max(limit | 0, 1), 100);
  const kindSet = kinds && kinds.length ? new Set(kinds) : null;

  const hopOf = new Map([[seedId, 0]]);
  const orderedIds = [];   // discovery order, excluding seed
  const edgeKey = new Set();
  const edgesOut = [];
  let frontier = [seedId];

  for (let hop = 1; hop <= d; hop++) {
    const nextSet = [];
    const seenThisHop = new Set();
    // Stable frontier order by qualified.
    frontier.sort((a, b) => {
      const qa = graph.byId.get(a).qualified, qb = graph.byId.get(b).qualified;
      return qa < qb ? -1 : qa > qb ? 1 : 0;
    });
    for (const cur of frontier) {
      for (const { to, edge } of stepEdges(graph, cur, direction, kindSet)) {
        const key = `${edge.src}>${edge.dst}:${edge.kind}`;
        if (!edgeKey.has(key)) { edgeKey.add(key); edgesOut.push(edge); }
        if (!hopOf.has(to)) {
          hopOf.set(to, hop);
          orderedIds.push(to);
          if (!seenThisHop.has(to)) { seenThisHop.add(to); nextSet.push(to); }
        }
      }
    }
    frontier = nextSet;
  }

  const total = orderedIds.length;
  const retainedIds = orderedIds.slice(0, cap);
  const retainedSet = new Set(retainedIds);
  retainedSet.add(seedId);
  const truncated = total > cap;

  // Only keep edges whose both endpoints are retained (seed included).
  const edges = edgesOut
    .filter(e => retainedSet.has(e.src) && retainedSet.has(e.dst))
    .map(e => edgeView(graph, e))
    .sort((a, b) => (a.from + a.to + a.kind).localeCompare(b.from + b.to + b.kind));

  const nodes = retainedIds.map(id => nodeView(graph, id, hopOf.get(id)));

  return {
    seed: nodeView(graph, seedId, 0),
    nodes, edges, truncated, returned: nodes.length, total,
  };
}

/**
 * Bounded shortest path from `from` to `to`. Deterministic tie-break via
 * lexical neighbor ordering. Returns a distinct { found:false } when the
 * endpoints are known but unreachable within max_depth.
 *
 * @returns null if either endpoint is unknown (caller surfaces resolution error)
 */
export function shortestPath(graph, fromQualified, toQualified, { directed = false, kinds = null, maxDepth = 6 } = {}) {
  const fromId = nodeIdFor(graph, fromQualified);
  const toId = nodeIdFor(graph, toQualified);
  if (fromId == null || toId == null) return null;

  const cap = Math.min(Math.max(maxDepth | 0, 1), 10);
  const kindSet = kinds && kinds.length ? new Set(kinds) : null;
  const direction = directed ? 'out' : 'both';

  if (fromId === toId) {
    return { found: true, hop_count: 0, nodes: [nodeView(graph, fromId, 0)], edges: [] };
  }

  const parent = new Map([[fromId, null]]); // id → { prev, edge }
  const depth = new Map([[fromId, 0]]);
  let frontier = [fromId];

  for (let hop = 1; hop <= cap && frontier.length; hop++) {
    const next = [];
    frontier.sort((a, b) => {
      const qa = graph.byId.get(a).qualified, qb = graph.byId.get(b).qualified;
      return qa < qb ? -1 : qa > qb ? 1 : 0;
    });
    for (const cur of frontier) {
      for (const { to, edge } of stepEdges(graph, cur, direction, kindSet)) {
        if (parent.has(to)) continue;
        parent.set(to, { prev: cur, edge });
        depth.set(to, hop);
        if (to === toId) { frontier = []; next.length = 0; break; }
        next.push(to);
      }
      if (parent.has(toId)) break;
    }
    if (parent.has(toId)) break;
    frontier = next;
  }

  if (!parent.has(toId)) return { found: false };

  // Reconstruct.
  const idPath = [];
  const edgePath = [];
  let cur = toId;
  while (cur != null) {
    idPath.push(cur);
    const p = parent.get(cur);
    if (p && p.prev != null) edgePath.push(p.edge);
    cur = p ? p.prev : null;
  }
  idPath.reverse();
  edgePath.reverse();

  return {
    found: true,
    hop_count: edgePath.length,
    nodes: idPath.map((id, i) => nodeView(graph, id, i)),
    edges: edgePath.map(e => edgeView(graph, e)),
  };
}
