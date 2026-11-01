// tests/unit/codegraph/owner-index.test.js
//
// createOwnerIndex replaced a linear scan that was O(symbols × call sites) and
// dominated extraction on large files (issue S2.1). The only thing that makes
// that replacement safe is that it answers *exactly* what the scan answered —
// including the scan's unstated tie-break, which a first attempt got wrong and
// a differential run caught.
//
// So the primary test here is differential: a verbatim copy of the old scan,
// run against the new index over thousands of randomised symbol layouts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createOwnerIndex } from "../../../lib/codegraph/owner-index.js";

// The implementation this change replaced, kept verbatim as the oracle.
function findOwnerLinearScan(symbols, index) {
  let best = null, bestSize = Infinity;
  for (const s of symbols) {
    if (s.startIdx <= index && index <= s.endIdx) {
      const size = s.endIdx - s.startIdx;
      if (size < bestSize) { best = s; bestSize = size; }
    }
  }
  return best?.localId ?? null;
}

// Deterministic PRNG (mulberry32) so a failure is reproducible from the seed
// rather than "it went red once on CI".
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sym = (localId, startIdx, endIdx) => ({ localId, startIdx, endIdx });

describe("createOwnerIndex", () => {
  test("returns null when there are no symbols", () => {
    assert.equal(createOwnerIndex([])(42), null);
  });

  test("returns null for an offset outside every symbol", () => {
    const ownerAt = createOwnerIndex([sym("a", 10, 20)]);
    assert.equal(ownerAt(9), null);
    assert.equal(ownerAt(21), null);
  });

  test("boundaries are inclusive at both ends", () => {
    const ownerAt = createOwnerIndex([sym("a", 10, 20)]);
    assert.equal(ownerAt(10), "a");
    assert.equal(ownerAt(20), "a");
  });

  test("picks the innermost of nested symbols", () => {
    const ownerAt = createOwnerIndex([
      sym("outer", 0, 100),
      sym("middle", 10, 60),
      sym("inner", 20, 30),
    ]);
    assert.equal(ownerAt(25), "inner");
    assert.equal(ownerAt(40), "middle");
    assert.equal(ownerAt(80), "outer");
  });

  test("two symbols covering the same range resolve to the earlier one", () => {
    // This is the tie-break the old scan had only by accident — it replaced its
    // best on a *strictly* smaller span — and the one a sorted backward scan
    // flips unless it carries the original order. Pinned here on purpose.
    const symbols = [sym("first", 5, 15), sym("second", 5, 15)];
    assert.equal(createOwnerIndex(symbols)(10), "first");
    assert.equal(findOwnerLinearScan(symbols, 10), "first");
  });

  test("order of the input array does not change which span wins, only ties", () => {
    const a = [sym("big", 0, 100), sym("small", 10, 20)];
    const b = [sym("small", 10, 20), sym("big", 0, 100)];
    assert.equal(createOwnerIndex(a)(15), "small");
    assert.equal(createOwnerIndex(b)(15), "small");
  });

  test("does not mutate the caller's array", () => {
    const symbols = [sym("b", 50, 60), sym("a", 0, 10)];
    const before = JSON.stringify(symbols);
    createOwnerIndex(symbols)(55);
    assert.equal(JSON.stringify(symbols), before);
  });

  test("flat sibling layout — the bundle shape the fix was written for", () => {
    const symbols = [];
    for (let i = 0; i < 500; i++) symbols.push(sym(`fn${i}`, i * 10, i * 10 + 9));
    const ownerAt = createOwnerIndex(symbols);
    for (let i = 0; i < 500; i++) {
      assert.equal(ownerAt(i * 10 + 4), `fn${i}`);
    }
  });

  test("matches the old linear scan over randomised layouts", () => {
    // Overlapping, nested, duplicated and zero-width spans all appear here.
    let probes = 0;
    for (const seed of [1, 7, 1234, 98765, 2026]) {
      const rand = rng(seed);
      const int = (n) => Math.floor(rand() * n);
      for (let trial = 0; trial < 300; trial++) {
        const n = 1 + int(40);
        const symbols = [];
        for (let i = 0; i < n; i++) {
          const start = int(400);
          symbols.push(sym(`s${i}`, start, start + int(200)));
        }
        const ownerAt = createOwnerIndex(symbols);
        for (let idx = -5; idx <= 610; idx += 3) {
          probes++;
          assert.equal(
            ownerAt(idx),
            findOwnerLinearScan(symbols, idx),
            `seed=${seed} trial=${trial} idx=${idx} symbols=${JSON.stringify(symbols)}`,
          );
        }
      }
    }
    assert.ok(probes > 300_000, `expected a meaningful number of probes, got ${probes}`);
  });
});
