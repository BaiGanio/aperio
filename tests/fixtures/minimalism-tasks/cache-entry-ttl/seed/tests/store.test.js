import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";

test("set and get a value", () => {
  const store = createStore();
  store.set("a", 1);
  assert.equal(store.get("a"), 1);
});

test("has reflects presence", () => {
  const store = createStore();
  assert.equal(store.has("a"), false);
  store.set("a", 1);
  assert.equal(store.has("a"), true);
});

test("delete removes a key", () => {
  const store = createStore();
  store.set("a", 1);
  store.delete("a");
  assert.equal(store.has("a"), false);
});

test("size reflects entry count", () => {
  const store = createStore();
  store.set("a", 1);
  store.set("b", 2);
  assert.equal(store.size, 2);
});
