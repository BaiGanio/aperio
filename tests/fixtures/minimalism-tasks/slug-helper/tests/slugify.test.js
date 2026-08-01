import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../slugify.js";

test("lowercases and hyphenates", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("strips non-alphanumeric characters", () => {
  assert.equal(slugify("Café & Bar!!"), "caf-bar");
});

test("trims leading and trailing hyphens", () => {
  assert.equal(slugify("  --Weird Title--  "), "weird-title");
});
