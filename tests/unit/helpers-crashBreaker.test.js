// tests/lib/helpers/crashBreaker.test.js
// PROC-01 — sliding-window circuit breaker for repeated fatal errors.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createCrashBreaker } from "../../lib/helpers/crashBreaker.js";

describe("crashBreaker", () => {
  test("trips once the threshold is reached within the window", () => {
    let t = 0;
    const breaker = createCrashBreaker({ threshold: 3, windowMs: 1000, now: () => t });
    assert.equal(breaker.record(), false); // 1
    assert.equal(breaker.record(), false); // 2
    assert.equal(breaker.record(), true);  // 3 → trip
  });

  test("does not trip when errors are spread beyond the window", () => {
    let t = 0;
    const breaker = createCrashBreaker({ threshold: 3, windowMs: 1000, now: () => t });
    assert.equal(breaker.record(), false); t += 600;
    assert.equal(breaker.record(), false); t += 600;  // first hit now expired
    assert.equal(breaker.record(), false); t += 600;  // still only 2 in window
    assert.equal(breaker.record(), false);
  });

  test("a burst still trips even after earlier hits expired", () => {
    let t = 0;
    const breaker = createCrashBreaker({ threshold: 2, windowMs: 100, now: () => t });
    breaker.record(); t += 500;          // expires
    assert.equal(breaker.record(), false);
    assert.equal(breaker.record(), true); // two within the fresh window
  });
});
