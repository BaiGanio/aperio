// lib/helpers/timeSlice.js
// Cooperative time slicing for long synchronous loops.
//
// Why: better-sqlite3 is synchronous, so a loop that writes one row per
// statement holds the event loop for the whole loop. A single bundle-shaped
// source file can produce ~32k statements — measured at ~2.2 s of unbroken
// main-thread time, during which the HTTP server answers nothing (issue S2.1).
// `await readFile()` between *files* yields; nothing yielded *within* a file.
//
// A slicer hands the loop a `tick()` to await. It only actually yields once the
// current slice has run longer than `sliceMs`, so the common case (a small
// file, a handful of statements) pays one `performance.now()` per batch and
// never defers at all.
//
// setImmediate, not setTimeout(0): setImmediate runs after the current poll
// phase, so pending I/O callbacks — an inbound HTTP request — are serviced
// before the loop resumes. A timer would let the loop re-acquire the thread
// ahead of them.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

// 8 ms: below one 60 Hz frame, so a yield is imperceptible, and large enough
// that a repo pass spends well under 1% of its time in scheduling overhead.
export const DEFAULT_SLICE_MS = 8;

// How many iterations run between two clock reads. performance.now() is cheap
// but not free, and an insert is ~0.07 ms, so checking every 64 rows keeps the
// worst-case overshoot near 4 ms while making the check itself noise.
export const DEFAULT_CHECK_EVERY = 64;

/**
 * @param {object} [opts]
 * @param {number} [opts.sliceMs]      max unbroken main-thread time per slice
 * @param {number} [opts.checkEvery]   iterations between clock reads
 * @param {() => number} [opts.now]    injectable clock (tests)
 * @param {() => Promise<void>} [opts.yieldFn] injectable yield (tests)
 */
export function createTimeSlicer({
  sliceMs = DEFAULT_SLICE_MS,
  checkEvery = DEFAULT_CHECK_EVERY,
  now = () => performance.now(),
  yieldFn = yieldToEventLoop,
} = {}) {
  let sliceStart = now();
  let sinceCheck = 0;
  let yields = 0;

  return {
    /**
     * Call once per loop iteration and await it. Resolves synchronously
     * (already-resolved promise) unless the slice is over budget.
     */
    async tick() {
      if (++sinceCheck < checkEvery) return;
      sinceCheck = 0;
      if (now() - sliceStart < sliceMs) return;
      yields++;
      await yieldFn();
      sliceStart = now();
    },

    /**
     * Yield unconditionally and start a fresh slice. Used at a natural
     * boundary — the end of one file — where the next unit of work is known
     * to be large.
     */
    async yieldNow() {
      yields++;
      await yieldFn();
      sliceStart = now();
      sinceCheck = 0;
    },

    /** Diagnostics only. */
    get yields() { return yields; },
  };
}
