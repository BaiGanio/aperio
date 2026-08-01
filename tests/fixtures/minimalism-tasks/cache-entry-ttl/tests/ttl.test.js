import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";

test("set without ttlMs never expires", async () => {
  const store = createStore();
  store.set("a", 1);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(store.get("a"), 1);
});

test("entry expires after ttlMs elapses, from both get and has", async () => {
  const store = createStore();
  store.set("a", 1, 10);
  assert.equal(store.get("a"), 1);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(store.get("a"), undefined);
  assert.equal(store.has("a"), false);
});

test("negative ttlMs throws instead of silently accepting it", () => {
  const store = createStore();
  assert.throws(() => store.set("a", 1, -5));
});

test("non-numeric ttlMs throws instead of silently accepting it", () => {
  const store = createStore();
  assert.throws(() => store.set("a", 1, "soon"));
});
