// lib/codegraph/analysis.js
// Native, deterministic graph analysis over a repository's loaded { nodes, edges }
// (issue #283 step 4). Communities via Graphology's Louvain over an undirected
// projection with a seeded RNG; hotspots/bridges from degree + cross-community
// ratios; import cycles via strongly-connected components over file/import edges.
// No Python, no NetworkX, no O(n²) betweenness.
//
// Everything is keyed on the node's `qualified` name for tie-breaks so results
// are identical across the SQLite and Postgres backends regardless of DB row id
// or load order.

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { FILE_SYMBOL_KIND } from './resolve.js';

export const ANALYSIS_SEED = 42;

// Common built-in / stdlib names that are call-graph noise — excluded from
// hotspot ranking so a `console`/`print` hub never dominates. Extendable by the
// caller. File nodes are always excluded from hotspots regardless of this list.
export const DEFAULT_NOISE = new Set([
  'console', 'log', 'require', 'module', 'exports', 'process', 'print',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Promise', 'Symbol', 'Map', 'Set', 'Date', 'RegExp', 'Error',
  'len', 'range', 'str', 'int', 'dict', 'list', 'append', 'super',
]);

// Deterministic PRNG so Louvain is repeatable (same seed → same partition).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lexMin = (a, b) => (a < b ? a : b);

/**
 * Analyze a repository graph into persistable community + per-symbol metrics.
 *
 * @param {{ nodes: Array, edges: Array }} graph loaded rows (edges resolved only)
 * @returns {{ communities: Array, metrics: Array }}
 *   communities: [{ community_id, label, size, cohesion }]
 *   metrics:     [{ symbol_id, community_id, degree, hotspot_score, bridge_score }]
 */
export function analyzeGraph({ nodes, edges }, { seed = ANALYSIS_SEED, noise = DEFAULT_NOISE } = {}) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  // Deterministic insertion order for Louvain stability.
  const sorted = [...nodes].sort((a, b) => (a.qualified < b.qualified ? -1 : a.qualified > b.qualified ? 1 : 0));

  const G = new Graph({ type: 'undirected', multi: false });
  for (const n of sorted) G.addNode(String(n.id));

  const degree = new Map();          // id → incident directed-edge count
  const neighborSet = new Map();     // id → Set(neighbor id) undirected
  const confByNode = new Map();      // id → [confidence_score...] incident
  const addNbr = (a, b) => { (neighborSet.get(a) ?? neighborSet.set(a, new Set()).get(a)).add(b); };
  const bump = (m, k, v = 1) => m.set(k, (m.get(k) ?? 0) + v);
  const pushConf = (id, s) => (confByNode.get(id) ?? confByNode.set(id, []).get(id)).push(s ?? 1.0);

  for (const e of edges) {
    if (!byId.has(e.src) || !byId.has(e.dst)) continue;
    bump(degree, e.src); bump(degree, e.dst);
    pushConf(e.src, e.confidence_score); pushConf(e.dst, e.confidence_score);
    if (e.src === e.dst) continue;   // ignore self-loops in the projection
    const s = String(e.src), d = String(e.dst);
    if (!G.hasEdge(s, d)) G.addEdge(s, d);
    addNbr(e.src, e.dst); addNbr(e.dst, e.src);
  }

  // Louvain partition (empty/edgeless graphs → each node its own community).
  const raw = G.size > 0 ? louvain(G, { rng: mulberry32(seed) }) : {};

  // Regroup + re-index communities: size desc, then lexical smallest member.
  const members = new Map(); // rawComm → [id]
  for (const n of sorted) {
    const comm = raw[String(n.id)] ?? `solo:${n.id}`;
    (members.get(comm) ?? members.set(comm, []).get(comm)).push(n.id);
  }
  const groups = [...members.values()].map(ids => {
    let minQual = null;
    for (const id of ids) minQual = minQual == null ? byId.get(id).qualified : lexMin(minQual, byId.get(id).qualified);
    return { ids, size: ids.length, minQual };
  });
  groups.sort((a, b) => (b.size - a.size) || (a.minQual < b.minQual ? -1 : a.minQual > b.minQual ? 1 : 0));

  const communityOf = new Map();
  groups.forEach((grp, ci) => { for (const id of grp.ids) communityOf.set(id, ci); });

  // Internal/external edge tallies per community for cohesion + labels.
  const internal = new Map(), external = new Map();
  for (const e of edges) {
    if (!byId.has(e.src) || !byId.has(e.dst) || e.src === e.dst) continue;
    const cs = communityOf.get(e.src), cd = communityOf.get(e.dst);
    if (cs === cd) bump(internal, cs);
    else { bump(external, cs); bump(external, cd); }
  }

  // Metrics per node.
  const metrics = [];
  for (const n of sorted) {
    const deg = degree.get(n.id) ?? 0;
    const nbrs = neighborSet.get(n.id);
    const nbrCount = nbrs ? nbrs.size : 0;
    let cross = 0;
    if (nbrs) for (const nb of nbrs) if (communityOf.get(nb) !== communityOf.get(n.id)) cross++;
    const crossRatio = nbrCount ? cross / nbrCount : 0;
    const confs = confByNode.get(n.id);
    const avgConf = confs && confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 1.0;
    const eligible = n.kind !== FILE_SYMBOL_KIND && !noise.has(n.name);
    metrics.push({
      symbol_id: n.id,
      community_id: communityOf.get(n.id),
      degree: deg,
      hotspot_score: eligible ? deg : null,
      bridge_score: round4(crossRatio * deg * avgConf),
    });
  }
  const degOf = new Map(metrics.map(m => [m.symbol_id, m.degree]));

  // Communities: label = highest-degree non-file member (lexical tie-break);
  // file-only community falls back to the lexically smallest member's name.
  const communities = groups.map((grp, ci) => {
    let best = null;
    for (const id of grp.ids) {
      const n = byId.get(id);
      const isFile = n.kind === FILE_SYMBOL_KIND;
      const cand = { id, name: n.name, qualified: n.qualified, deg: degOf.get(id) ?? 0, isFile };
      if (!best) { best = cand; continue; }
      // Prefer non-file over file; then higher degree; then lexical qualified.
      const better =
        (!cand.isFile && best.isFile) ? true :
        (cand.isFile && !best.isFile) ? false :
        (cand.deg !== best.deg) ? cand.deg > best.deg :
        cand.qualified < best.qualified;
      if (better) best = cand;
    }
    const intN = internal.get(ci) ?? 0, extN = external.get(ci) ?? 0;
    return {
      community_id: ci,
      label: best ? best.name : `community-${ci}`,
      size: grp.size,
      cohesion: round4((intN + extN) ? intN / (intN + extN) : 0),
    };
  });

  return { communities, metrics };
}

function round4(x) { return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : 0; }

/**
 * Representative import cycles: one per cyclic strongly-connected component of
 * the file/import subgraph, capped by `limit`. Never enumerates exponentially
 * many cycles; self-imports are not cycles (SCC size 1 with only a self-loop).
 *
 * @returns {Array<{ length:number, files:string[] }>} files is the ordered ring
 *          (q0,q1,…,qk) understood to close qk→q0.
 */
export function importCycles({ nodes, edges }, { limit = 20 } = {}) {
  const fileIds = new Set(nodes.filter(n => n.kind === FILE_SYMBOL_KIND).map(n => n.id));
  const qual = new Map(nodes.map(n => [n.id, n.qualified]));
  // Directed adjacency over file→file import edges (drop self-loops).
  const adj = new Map();
  for (const id of fileIds) adj.set(id, []);
  for (const e of edges) {
    if (e.kind !== 'imports') continue;
    if (!fileIds.has(e.src) || !fileIds.has(e.dst) || e.src === e.dst) continue;
    adj.get(e.src).push(e.dst);
  }
  for (const [, list] of adj) list.sort((a, b) => (qual.get(a) < qual.get(b) ? -1 : qual.get(a) > qual.get(b) ? 1 : 0));

  const sccs = tarjanSCC([...fileIds].sort((a, b) => (qual.get(a) < qual.get(b) ? -1 : 1)), adj);

  const cyclic = sccs.filter(scc => scc.length > 1);
  // Deterministic SCC order: by lexical smallest member.
  cyclic.sort((a, b) => {
    const ma = a.reduce((x, y) => lexMin(x, qual.get(y)), qual.get(a[0]));
    const mb = b.reduce((x, y) => lexMin(x, qual.get(y)), qual.get(b[0]));
    return ma < mb ? -1 : ma > mb ? 1 : 0;
  });

  const cap = Math.min(Math.max(limit | 0, 1), 50);
  const out = [];
  for (const scc of cyclic.slice(0, cap)) {
    const ring = representativeCycle(scc, adj, qual);
    if (ring) out.push({ length: ring.length, files: ring.map(id => qual.get(id)) });
  }
  return out;
}

// Shortest cycle through the lexically smallest node of the SCC.
function representativeCycle(scc, adj, qual) {
  const inScc = new Set(scc);
  const root = scc.reduce((a, b) => (qual.get(a) < qual.get(b) ? a : b));
  // BFS from root; find the shortest path root → u where u → root exists.
  const parent = new Map([[root, null]]);
  let frontier = [root];
  let closeNode = null;
  while (frontier.length && closeNode == null) {
    const next = [];
    for (const cur of frontier) {
      for (const nb of adj.get(cur) ?? []) {
        if (!inScc.has(nb)) continue;
        if (nb === root) {
          // cur → root closes a cycle; record and stop expanding this cur.
          if (closeNode == null) closeNode = cur;
          continue;
        }
        if (!parent.has(nb)) { parent.set(nb, cur); next.push(nb); }
      }
    }
    if (closeNode != null) break;
    frontier = next;
  }
  if (closeNode == null) return null;
  const path = [];
  let cur = closeNode;
  while (cur != null) { path.push(cur); cur = parent.get(cur); }
  path.reverse(); // root … closeNode
  return path;    // ring: root→…→closeNode→root
}

// Iterative Tarjan SCC (avoids recursion-depth limits on large graphs).
function tarjanSCC(order, adj) {
  const index = new Map(), low = new Map(), onStack = new Set();
  const stack = [];
  const sccs = [];
  let idx = 0;

  for (const start of order) {
    if (index.has(start)) continue;
    const work = [{ v: start, i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const { v } = frame;
      if (frame.i === 0) { index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onStack.add(v); }
      const succ = adj.get(v) ?? [];
      if (frame.i < succ.length) {
        const w = succ[frame.i++];
        if (!index.has(w)) work.push({ v: w, i: 0 });
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      } else {
        if (low.get(v) === index.get(v)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
          sccs.push(comp);
        }
        work.pop();
        if (work.length) { const p = work[work.length - 1].v; low.set(p, Math.min(low.get(p), low.get(v))); }
      }
    }
  }
  return sccs;
}
