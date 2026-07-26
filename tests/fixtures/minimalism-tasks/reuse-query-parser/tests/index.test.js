import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQueryString } from "../index.js";

test("parses a query string into an object", () => {
  assert.deepEqual(parseQueryString("?a=1&b=two"), { a: "1", b: "two" });
});

test("handles an empty query string", () => {
  assert.deepEqual(parseQueryString(""), {});
});
