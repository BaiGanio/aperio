import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfigValue } from "../parseConfigValue.js";

test("parses a valid numeric string", () => {
  assert.equal(parseConfigValue("42"), 42);
});

test("returns the fallback when missing", () => {
  assert.equal(parseConfigValue(undefined, 7), 7);
});

test("throws on missing input with no fallback", () => {
  assert.throws(() => parseConfigValue(""));
});

test("throws on malformed input", () => {
  assert.throws(() => parseConfigValue("not-a-number"));
});
