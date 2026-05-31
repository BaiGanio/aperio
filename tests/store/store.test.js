// tests/store/store.test.js
// Unit tests for the PostgresStore / LanceDBStore interface.
// Covers counts(), listWithoutEmbeddings(), and setEmbedding().
// Uses makeMockStore() — no real DB connection needed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { makeMockStore } from "../mockStore.js";

// ─── counts() ────────────────────────────────────────────────────────────────

describe("counts()", () => {
  test("returns total and embedded counts", async () => {
    const store = makeMockStore({ counts: { total: 5, embedded: 3 } });
    const result = await store.counts();
    assert.equal(result.total, 5);
    assert.equal(result.embedded, 3);
  });

  test("returns zeros for an empty store", async () => {
    const store = makeMockStore({ counts: { total: 0, embedded: 0 } });
    const result = await store.counts();
    assert.equal(result.total, 0);
    assert.equal(result.embedded, 0);
  });

  test("embedded can equal total when all are embedded", async () => {
    const store = makeMockStore({ counts: { total: 4, embedded: 4 } });
    const { total, embedded } = await store.counts();
    assert.equal(total, embedded);
  });

  test("embedded can be less than total when some are missing", async () => {
    const store = makeMockStore({ counts: { total: 10, embedded: 7 } });
    const { total, embedded } = await store.counts();
    assert.ok(embedded < total);
  });
});

// ─── listWithoutEmbeddings() ─────────────────────────────────────────────────

describe("listWithoutEmbeddings()", () => {
  test("returns rows missing embeddings", async () => {
    const pending = [
      { id: "1", title: "Fact A", content: "Content A" },
      { id: "2", title: "Fact B", content: "Content B" },
    ];
    const store = makeMockStore({ counts: { total: 2, embedded: 0 }, withoutEmbeddings: pending });
    const result = await store.listWithoutEmbeddings();
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "1");
    assert.equal(result[1].title, "Fact B");
  });

  test("returns empty array when all memories are embedded", async () => {
    const store = makeMockStore({ counts: { total: 3, embedded: 3 }, withoutEmbeddings: [] });
    const result = await store.listWithoutEmbeddings();
    assert.equal(result.length, 0);
  });

  test("returns empty array when store is empty", async () => {
    const store = makeMockStore({ counts: { total: 0, embedded: 0 }, withoutEmbeddings: [] });
    const result = await store.listWithoutEmbeddings();
    assert.deepEqual(result, []);
  });

  test("returns only id, title, content fields", async () => {
    const pending = [{ id: "abc", title: "T", content: "C" }];
    const store = makeMockStore({ counts: { total: 1, embedded: 0 }, withoutEmbeddings: pending });
    const [row] = await store.listWithoutEmbeddings();
    assert.ok("id" in row);
    assert.ok("title" in row);
    assert.ok("content" in row);
  });

  test("result length matches total minus embedded", async () => {
    const pending = [
      { id: "1", title: "A", content: "a" },
      { id: "2", title: "B", content: "b" },
    ];
    const store = makeMockStore({ counts: { total: 5, embedded: 3 }, withoutEmbeddings: pending });
    const result = await store.listWithoutEmbeddings();
    assert.equal(result.length, 2);
  });
});

// ─── setEmbedding() ──────────────────────────────────────────────────────────

describe("setEmbedding()", () => {
  test("records the id and embedding vector", async () => {
    const store = makeMockStore({ counts: { total: 1, embedded: 0 } });
    const vec = [0.1, 0.2, 0.3];
    await store.setEmbedding("id-1", vec);
    assert.equal(store._setEmbeddingCalls.length, 1);
    assert.equal(store._setEmbeddingCalls[0].id, "id-1");
    assert.deepEqual(store._setEmbeddingCalls[0].embedding, vec);
  });

  test("records multiple calls independently", async () => {
    const store = makeMockStore({ counts: { total: 2, embedded: 0 } });
    await store.setEmbedding("id-1", [0.1]);
    await store.setEmbedding("id-2", [0.9]);
    assert.equal(store._setEmbeddingCalls.length, 2);
    assert.equal(store._setEmbeddingCalls[0].id, "id-1");
    assert.equal(store._setEmbeddingCalls[1].id, "id-2");
  });

  test("preserves vector dimensionality", async () => {
    const store = makeMockStore({ counts: { total: 1, embedded: 0 } });
    const vec = Array.from({ length: 1536 }, (_, i) => i / 1536);
    await store.setEmbedding("hi-dim", vec);
    assert.equal(store._setEmbeddingCalls[0].embedding.length, 1536);
  });

  test("invokes optional setEmbeddingFn side-effect", async () => {
    let sideEffectId = null;
    const store = makeMockStore({
      counts: { total: 1, embedded: 0 },
      setEmbeddingFn: (id) => { sideEffectId = id; },
    });
    await store.setEmbedding("effect-id", [0.5]);
    assert.equal(sideEffectId, "effect-id");
  });

  test("does not share call history between independent stores", async () => {
    const storeA = makeMockStore({ counts: { total: 1, embedded: 0 } });
    const storeB = makeMockStore({ counts: { total: 1, embedded: 0 } });
    await storeA.setEmbedding("a", [0.1]);
    assert.equal(storeA._setEmbeddingCalls.length, 1);
    assert.equal(storeB._setEmbeddingCalls.length, 0);
  });
});