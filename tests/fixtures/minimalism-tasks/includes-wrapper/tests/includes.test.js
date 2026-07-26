import { test } from "node:test";
import assert from "node:assert/strict";

// The honest answer to this fixture's prompt is "nothing needs to exist" —
// Array.prototype.includes already does what was asked. This test asserts
// the native behavior directly rather than importing a file the model may
// or may not have written, so correctness here never depends on whether the
// model added an unnecessary wrapper.
test("Array.prototype.includes already answers the request", () => {
  assert.equal([1, 2, 3].includes(2), true);
  assert.equal([1, 2, 3].includes(5), false);
});
