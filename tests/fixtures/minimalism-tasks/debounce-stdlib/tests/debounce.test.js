import { test } from "node:test";
import assert from "node:assert/strict";
import { debounce } from "../debounce.js";

test("collapses rapid calls into one trailing call", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const fn = debounce(() => { calls++; }, 100);
  fn(); fn(); fn();
  t.mock.timers.tick(100);
  assert.equal(calls, 1);
});

test("resets the timer on each call", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const fn = debounce(() => { calls++; }, 100);
  fn();
  t.mock.timers.tick(50);
  fn();
  t.mock.timers.tick(50);
  assert.equal(calls, 0);
  t.mock.timers.tick(50);
  assert.equal(calls, 1);
});
