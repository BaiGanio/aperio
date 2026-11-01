// tests/unit/codegraph/analysis.test.js
// Native analysis (issue #283 step 4, groups F–H): deterministic communities,
// hotspot/bridge metrics, and representative import cycles. Pure, no DB.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { analyzeGraph, importCycles } from "../../../lib/codegraph/analysis.js";

// Two triangles {A,B,C} and {D,E,F} joined by a single C→D bridge.
const fn = (n) => ({ id: n.charCodeAt(0), qualified: `m/${n}.js::${n}`, kind: "function", name: n });
const COMMUNITY_NODES = ["A", "B", "C", "D", "E", "F"].map(fn);
const COMMUNITY_EDGES = [
  ["A", "B"], ["B", "C"], ["A", "C"],
  ["D", "E"], ["E", "F"], ["D", "F"],
  ["C", "D"],
].map(([s, d]) => ({ src: s.charCodeAt(0), dst: d.charCodeAt(0), kind: "calls", confidence_score: 1.0 }));
const cg = () => ({ nodes: COMMUNITY_NODES, edges: COMMUNITY_EDGES });

describe("analyzeGraph — communities & metrics", () => {
  test("splits into two communities, deterministically and repeatably", () => {
    const a = analyzeGraph(cg());
    const b = analyzeGraph(cg());
    assert.deepEqual(a.communities, b.communities);
    assert.deepEqual(a.metrics, b.metrics);
    assert.equal(a.communities.length, 2);
  });

  test("every symbol has exactly one membership; sizes sum to node count", () => {
    const { communities, metrics } = analyzeGraph(cg());
    assert.equal(metrics.length, COMMUNITY_NODES.length);
    const total = communities.reduce((s, c) => s + c.size, 0);
    assert.equal(total, COMMUNITY_NODES.length);
    const ids = new Set(metrics.map(m => m.community_id));
    for (const c of communities) assert.ok(ids.has(c.community_id));
  });

  test("labels are the bridge nodes C and D (highest degree), cohesion finite", () => {
    const { communities } = analyzeGraph(cg());
    const labels = communities.map(c => c.label).sort();
    assert.deepEqual(labels, ["C", "D"]);
    for (const c of communities) {
      assert.ok(Number.isFinite(c.cohesion) && c.cohesion >= 0 && c.cohesion <= 1);
    }
  });

  test("community ids are size-desc then lexical (stable re-index)", () => {
    const { communities } = analyzeGraph(cg());
    for (let i = 1; i < communities.length; i++) {
      assert.ok(communities[i - 1].size >= communities[i].size);
    }
    assert.deepEqual(communities.map(c => c.community_id), [0, 1]);
  });
});

describe("analyzeGraph — hotspots & bridges", () => {
  test("file nodes and configured noise are excluded from hotspot scoring", () => {
    const nodes = [
      { id: 1, qualified: "m/a.js", kind: "file", name: "a.js" },
      { id: 2, qualified: "m/a.js::real", kind: "function", name: "real" },
      { id: 3, qualified: "m/a.js::console", kind: "function", name: "console" }, // noise name
    ];
    const edges = [
      { src: 2, dst: 3, kind: "calls", confidence_score: 0.8 },
      { src: 1, dst: 2, kind: "imports", confidence_score: 0.8 },
    ];
    const { metrics } = analyzeGraph({ nodes, edges });
    const byId = new Map(metrics.map(m => [m.symbol_id, m]));
    assert.equal(byId.get(1).hotspot_score, null, "file node excluded");
    assert.equal(byId.get(3).hotspot_score, null, "noise name excluded");
    assert.equal(byId.get(2).hotspot_score, 2, "real symbol keeps its degree");
    for (const m of metrics) assert.ok(Number.isFinite(m.bridge_score));
  });

  test("a cross-community connector scores a higher bridge_score than a local-only node", () => {
    const { metrics } = analyzeGraph(cg());
    const byId = new Map(metrics.map(m => [m.symbol_id, m]));
    const C = byId.get("C".charCodeAt(0)); // bridges the two triangles
    const A = byId.get("A".charCodeAt(0)); // fully inside its community
    assert.ok(C.bridge_score > A.bridge_score, `C(${C.bridge_score}) should outrank A(${A.bridge_score})`);
  });
});

describe("importCycles — representative cycles per SCC", () => {
  const fileNode = (n) => ({ id: n, qualified: `f${n}.js`, kind: "file", name: `f${n}.js` });
  const imp = (s, d) => ({ src: s, dst: d, kind: "imports" });

  test("returns one ordered representative cycle per cyclic SCC; ignores tails", () => {
    const nodes = [1, 2, 3, 4].map(fileNode);
    // 1→2→3→1 cycle, plus acyclic tail 3→4.
    const edges = [imp(1, 2), imp(2, 3), imp(3, 1), imp(3, 4)];
    const cycles = importCycles({ nodes, edges }, { limit: 10 });
    assert.equal(cycles.length, 1);
    const ring = cycles[0].files;
    assert.equal(ring.length, 3);
    // Every consecutive pair (incl. wraparound) is a directed import.
    const edgeSet = new Set(edges.map(e => `${e.src}>${e.dst}`));
    const idOf = (q) => Number(q.slice(1, q.indexOf(".")));
    for (let i = 0; i < ring.length; i++) {
      const a = idOf(ring[i]), b = idOf(ring[(i + 1) % ring.length]);
      assert.ok(edgeSet.has(`${a}>${b}`), `${a}→${b} should be an import edge`);
    }
  });

  test("self-import alone is not a cycle", () => {
    const nodes = [5].map(fileNode);
    const cycles = importCycles({ nodes, edges: [imp(5, 5)] }, {});
    assert.deepEqual(cycles, []);
  });

  test("respects the limit cap across multiple SCCs", () => {
    // Two independent 2-node cycles.
    const nodes = [1, 2, 3, 4].map(fileNode);
    const edges = [imp(1, 2), imp(2, 1), imp(3, 4), imp(4, 3)];
    assert.equal(importCycles({ nodes, edges }, { limit: 1 }).length, 1);
    assert.equal(importCycles({ nodes, edges }, { limit: 10 }).length, 2);
  });
});
