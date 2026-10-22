// lib/codegraph/owner-index.js
// Smallest-enclosing-symbol lookup, shared by extract-ts.js and
// extract-generic.js (both previously carried the same scan, verbatim).
//
// Call-site attribution asks "which symbol encloses this byte offset?" once per
// call expression. The obvious form — scan every symbol per call site — is
// O(symbols × calls). On a bundle-shaped file (8k functions, 24k call sites)
// that measured 511 ms of a 613 ms extraction, and it grew quadratically: 16k
// functions took 1523 ms. That CPU is the main thread's while indexing, which
// is what issue S2.1 is about.
//
// Same answers, built from a sorted start index and a binary search.

/**
 * @param {Array<{localId: string, startIdx: number, endIdx: number}>} symbols
 * @returns {(index: number) => string|null} the smallest enclosing localId
 */
export function createOwnerIndex(symbols) {
  // Symbols are pushed in tree order, which is already sorted by startIdx, but
  // that is a property of the traversal rather than a guarantee — so sort.
  //
  // `ord` carries each symbol's position in the caller's array, because the old
  // scan's tie-break was positional: it walked the array in order and replaced
  // its best only on a *strictly* smaller span, so when two symbols cover the
  // same range the earlier one won. Sorting loses that order and this index
  // scans backwards, so without `ord` the tie would flip — which is exactly
  // what a differential run against the old implementation caught.
  const sorted = symbols
    .map((s, ord) => ({ s, ord }))
    .sort((a, b) => a.s.startIdx - b.s.startIdx || a.ord - b.ord);

  // maxEnd[i] = the largest endIdx among sorted[0..i]. Once that prefix maximum
  // falls short of `index`, no earlier symbol can still reach it, so the
  // backward scan can stop.
  const maxEnd = new Array(sorted.length);
  let running = -Infinity;
  for (let i = 0; i < sorted.length; i++) {
    running = Math.max(running, sorted[i].s.endIdx);
    maxEnd[i] = running;
  }

  return function ownerAt(index) {
    // Rightmost symbol whose startIdx <= index. Anything starting later cannot
    // contain `index` at all.
    let lo = 0, hi = sorted.length - 1, start = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].s.startIdx <= index) { start = mid; lo = mid + 1; }
      else hi = mid - 1;
    }

    // Walk back over the candidates that can still enclose `index` and keep the
    // narrowest — breaking a tie on `ord`, so the answer matches the old scan
    // exactly. For a flat file of siblings this stops after two steps; nesting
    // depth bounds it otherwise.
    let best = null, bestSize = Infinity, bestOrd = Infinity;
    for (let i = start; i >= 0; i--) {
      if (maxEnd[i] < index) break;
      const { s, ord } = sorted[i];
      if (index <= s.endIdx) {
        const size = s.endIdx - s.startIdx;
        if (size < bestSize || (size === bestSize && ord < bestOrd)) {
          best = s; bestSize = size; bestOrd = ord;
        }
      }
    }
    return best?.localId ?? null;
  };
}
