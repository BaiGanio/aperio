// tests/unit/codegraph/graph.test.js
// Shared traversal layer (issue #283 step 3, test group D). Pure in-memory graph,
// no DB — exercises direction, depth, relation filters, limits/truncation, and
// bounded directed/undirected shortest path with deterministic tie-breaks.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, neighbors, shortestPath } from "../../../lib/codegraph/graph.js";

// A(1) →calls B(2) ; A →imports C(3) ; B →calls D(4) ; C →references D ;
// D →calls E(5) ; E →calls A (cycle). F(6) is isolated.
const NODES = [
  { id: 1, qualified: "x/A.js::A", kind: "function", name: "A" },
  { id: 2, qualified: "x/B.js::B", kind: "function", name: "B" },
  { id: 3, qualified: "x/C.js::C", kind: "function", name: "C" },
  { id: 4, qualified: "x/D.js::D", kind: "function", name: "D" },
  { id: 5, qualified: "x/E.js::E", kind: "function", name: "E" },
  { id: 6, qualified: "x/F.js::F", kind: "function", name: "F" },
];
const EDGES = [
  { src: 1, dst: 2, kind: "calls" },
  { src: 1, dst: 3, kind: "imports" },
  { src: 2, dst: 4, kind: "calls" },
  { src: 3, dst: 4, kind: "references" },
  { src: 4, dst: 5, kind: "calls" },
  { src: 5, dst: 1, kind: "calls" },
];
const g = () => buildGraph(NODES, EDGES);
const quals = (r) => r.nodes.map(n => n.qualified);

describe("neighbors", () => {
  test("out direction, depth 1", () => {
    const r = neighbors(g(), "x/A.js::A", { direction: "out", depth: 1 });
    assert.deepEqual(quals(r), ["x/B.js::B", "x/C.js::C"]);
    assert.deepEqual(r.nodes.map(n => n.hop), [1, 1]);
    assert.equal(r.truncated, false);
    assert.equal(r.total, 2);
  });

  test("relation-kind filter", () => {
    const r = neighbors(g(), "x/A.js::A", { direction: "out", depth: 1, kinds: ["calls"] });
    assert.deepEqual(quals(r), ["x/B.js::B"]);
  });

  test("depth bounds reachability and records minimum hop", () => {
    const r2 = neighbors(g(), "x/A.js::A", { direction: "out", depth: 2 });
    assert.deepEqual(quals(r2), ["x/B.js::B", "x/C.js::C", "x/D.js::D"]);
    assert.equal(r2.nodes.find(n => n.qualified === "x/D.js::D").hop, 2);

    const r3 = neighbors(g(), "x/A.js::A", { direction: "out", depth: 3 });
    assert.ok(quals(r3).includes("x/E.js::E"));
    assert.equal(r3.nodes.find(n => n.qualified === "x/E.js::E").hop, 3);
  });

  test("in direction follows incoming edges", () => {
    const r = neighbors(g(), "x/A.js::A", { direction: "in", depth: 1 });
    assert.deepEqual(quals(r), ["x/E.js::E"]);
  });

  test("both direction unions in and out", () => {
    const r = neighbors(g(), "x/A.js::A", { direction: "both", depth: 1 });
    assert.deepEqual(quals(r), ["x/B.js::B", "x/C.js::C", "x/E.js::E"]);
  });

  test("limit truncates honestly and deterministically", () => {
    const r = neighbors(g(), "x/A.js::A", { direction: "out", depth: 3, limit: 2 });
    assert.equal(r.returned, 2);
    assert.equal(r.truncated, true);
    assert.equal(r.total, 4);
    assert.deepEqual(quals(r), ["x/B.js::B", "x/C.js::C"]);
    // No returned edge references an omitted node.
    const kept = new Set([...quals(r), "x/A.js::A"]);
    for (const e of r.edges) { assert.ok(kept.has(e.from) && kept.has(e.to)); }
  });

  test("unknown seed returns null", () => {
    assert.equal(neighbors(g(), "x/Z.js::Z", {}), null);
  });
});

describe("shortestPath", () => {
  test("directed respects orientation with deterministic tie-break", () => {
    const r = shortestPath(g(), "x/A.js::A", "x/E.js::E", { directed: true });
    assert.equal(r.found, true);
    assert.equal(r.hop_count, 3);
    assert.deepEqual(r.nodes.map(n => n.qualified), ["x/A.js::A", "x/B.js::B", "x/D.js::D", "x/E.js::E"]);
    assert.equal(r.edges.length, 3);
  });

  test("undirected finds the shorter reverse route", () => {
    const directed = shortestPath(g(), "x/C.js::C", "x/B.js::B", { directed: true });
    assert.equal(directed.hop_count, 4);
    const undirected = shortestPath(g(), "x/C.js::C", "x/B.js::B", { directed: false });
    assert.equal(undirected.hop_count, 2); // C–D–B via the shared D target
  });

  test("zero-hop path when source equals target", () => {
    const r = shortestPath(g(), "x/A.js::A", "x/A.js::A", {});
    assert.equal(r.found, true);
    assert.equal(r.hop_count, 0);
    assert.deepEqual(r.nodes.map(n => n.qualified), ["x/A.js::A"]);
    assert.deepEqual(r.edges, []);
  });

  test("disconnected endpoints return found:false (distinct from unknown)", () => {
    const r = shortestPath(g(), "x/A.js::A", "x/F.js::F", { directed: false });
    assert.deepEqual(r, { found: false });
  });

  test("unknown endpoint returns null (caller surfaces resolution error)", () => {
    assert.equal(shortestPath(g(), "x/A.js::A", "x/Z.js::Z", {}), null);
  });

  test("max_depth caps the search", () => {
    const r = shortestPath(g(), "x/A.js::A", "x/E.js::E", { directed: true, maxDepth: 2 });
    assert.deepEqual(r, { found: false });
  });

  test("relation filter can disconnect an otherwise connected graph", () => {
    // C reaches D only via a 'references' edge; filtering to calls disconnects it.
    const r = shortestPath(g(), "x/C.js::C", "x/E.js::E", { directed: true, kinds: ["calls"] });
    assert.deepEqual(r, { found: false });
  });
});
