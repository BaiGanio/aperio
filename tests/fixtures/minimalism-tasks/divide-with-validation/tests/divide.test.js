import { test } from "node:test";
import assert from "node:assert/strict";
import { divide } from "../divide.js";

test("divides two numbers", () => {
  assert.equal(divide(10, 2), 5);
});

test("rejects division by zero", () => {
  assert.throws(() => divide(10, 0), RangeError);
});

test("rejects non-numeric input", () => {
  assert.throws(() => divide(undefined, 2), TypeError);
  assert.throws(() => divide(10, {}), TypeError);
});
