// tests/tools/memory.test.js
// Tests for all memory tool handlers.
// Imports directly from the real mcp/tools/memory.js — no inline copies.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  rememberHandler,
  recallHandler,
  updateMemoryHandler,
  forgetHandler,
  backfillHandler,
  dedupHandler,
} from "../../mcp/tools/memory.js";

// ─── Mock store ───────────────────────────────────────────────────────────────
// Implements the same interface as PostgresStore / LanceDBStore.
// Each test seeds only the methods it needs.

function makeStore(overrides = {}) {
  return {
    async insert(_input, _embedding)        { throw new Error("store.insert not seeded"); },
    async recall(_opts)                     { throw new Error("store.recall not seeded"); },
    async getById(_id)                      { throw new Error("store.getById not seeded"); },
    async update(_id, _input, _embedding)   { throw new Error("store.update not seeded"); },
    async delete(_id)                       { throw new Error("store.delete not seeded"); },
    async listWithoutEmbeddings()           { return []; },
    async setEmbedding(_id, _vec)           { },
    async findDuplicates(_threshold)        { return []; },
    async mergeDuplicate(_idA, _idB)        { },
    ...overrides,
  };
}

// ─── Mock ctx ─────────────────────────────────────────────────────────────────

function makeCtx(storeOverrides = {}, {
  generateEmbedding = async () => [0.1, 0.2, 0.3],
  vectorEnabled     = () => true,
} = {}) {
  return { store: makeStore(storeOverrides), generateEmbedding, vectorEnabled };
}

// ─── remember ─────────────────────────────────────────────────────────────────

describe("rememberHandler", () => {
  const baseArgs = { type: "fact", title: "Test fact", content: "Some content" };

  test("returns confirmation with title and id", async () => {
    const ctx = makeCtx({ insert: async () => ({ id: "abc-123", type: "fact", title: "Test fact" }) });
    const result = await rememberHandler(ctx, baseArgs);
    assert.ok(result.content[0].text.includes("✅ Memory saved"));
    assert.ok(result.content[0].text.includes("Test fact"));
    assert.ok(result.content[0].text.includes("abc-123"));
  });

  test("notes embedding when generateEmbedding returns a vector", async () => {
    const ctx = makeCtx({ insert: async () => ({ id: "x", type: "fact", title: "T" }) });
    const result = await rememberHandler(ctx, baseArgs);
    assert.ok(result.content[0].text.includes("with semantic embedding"));
  });

  test("does not note embedding when generateEmbedding returns null", async () => {
    const ctx = makeCtx(
      { insert: async () => ({ id: "x", type: "fact", title: "T" }) },
      { generateEmbedding: async () => null },
    );
    const result = await rememberHandler(ctx, baseArgs);
    assert.ok(!result.content[0].text.includes("with semantic embedding"));
  });

  test("passes correct fields to store.insert", async () => {
    let captured;
    const ctx = makeCtx({
      insert: async (input, embedding) => {
        captured = { input, embedding };
        return { id: "1", type: input.type, title: input.title };
      },
    });
    await rememberHandler(ctx, { type: "decision", title: "Use pgvector", content: "Yes", tags: ["db"], importance: 4 });
    assert.equal(captured.input.type, "decision");
    assert.equal(captured.input.title, "Use pgvector");
    assert.deepEqual(captured.input.tags, ["db"]);
    assert.equal(captured.input.importance, 4);
    assert.ok(Array.isArray(captured.embedding));
  });

  test("defaults importance to 3 when not provided", async () => {
    let captured;
    const ctx = makeCtx({
      insert: async (input) => { captured = input; return { id: "1", type: "fact", title: "T" }; },
    });
    await rememberHandler(ctx, { type: "fact", title: "T", content: "C" });
    assert.equal(captured.importance, 3);
  });

  test("defaults tags to [] when not provided", async () => {
    let captured;
    const ctx = makeCtx({
      insert: async (input) => { captured = input; return { id: "1", type: "fact", title: "T" }; },
    });
    await rememberHandler(ctx, { type: "fact", title: "T", content: "C" });
    assert.deepEqual(captured.tags, []);
  });
});

// ─── recall ───────────────────────────────────────────────────────────────────

describe("recallHandler", () => {
  const row = { id: "1", type: "fact", title: "Test", content: "Body", tags: ["x"], importance: 3 };

  test("returns formatted results", async () => {
    const ctx = makeCtx({ recall: async () => [row] });
    const result = await recallHandler(ctx, { query: "test" });
    assert.ok(result.content[0].text.includes("[FACT]"));
    assert.ok(result.content[0].text.includes("Test"));
    assert.ok(result.content[0].text.includes("ID: 1"));
  });

  test("returns no memories message on empty result", async () => {
    const ctx = makeCtx({ recall: async () => [] });
    const result = await recallHandler(ctx, { query: "nothing" });
    assert.equal(result.content[0].text, "No memories found.");
  });

  test("skips embedding when vectorEnabled returns false", async () => {
    let embeddingCalled = false;
    const ctx = makeCtx(
      { recall: async () => [] },
      { generateEmbedding: async () => { embeddingCalled = true; return [0.1]; }, vectorEnabled: () => false },
    );
    await recallHandler(ctx, { query: "hello" });
    assert.ok(!embeddingCalled);
  });

  test("skips embedding when search_mode is fulltext", async () => {
    let embeddingCalled = false;
    const ctx = makeCtx(
      { recall: async () => [] },
      { generateEmbedding: async () => { embeddingCalled = true; return [0.1]; } },
    );
    await recallHandler(ctx, { query: "hello", search_mode: "fulltext" });
    assert.ok(!embeddingCalled);
  });

  test("passes queryEmbedding to store.recall in semantic mode", async () => {
    let capturedOpts;
    const ctx = makeCtx({ recall: async (opts) => { capturedOpts = opts; return []; } });
    await recallHandler(ctx, { query: "hello", search_mode: "semantic" });
    assert.ok(Array.isArray(capturedOpts.queryEmbedding));
  });

  test("formats similarity note when present", async () => {
    const ctx = makeCtx({ recall: async () => [{ ...row, similarity: 0.92 }] });
    const result = await recallHandler(ctx, { query: "test" });
    assert.ok(result.content[0].text.includes("similarity: 92%"));
  });

  test("uses --- separator for multiple results", async () => {
    const ctx = makeCtx({ recall: async () => [row, { ...row, id: "2", title: "Second" }] });
    const result = await recallHandler(ctx, {});
    assert.ok(result.content[0].text.includes("---"));
  });

  test("shows 'none' for empty tags", async () => {
    const ctx = makeCtx({ recall: async () => [{ ...row, tags: [] }] });
    const result = await recallHandler(ctx, {});
    assert.ok(result.content[0].text.includes("Tags: none"));
  });

  test("defaults limit to 10", async () => {
    let capturedOpts;
    const ctx = makeCtx({ recall: async (opts) => { capturedOpts = opts; return []; } });
    await recallHandler(ctx, {});
    assert.equal(capturedOpts.limit, 10);
  });
});

// ─── update_memory ────────────────────────────────────────────────────────────

describe("updateMemoryHandler", () => {
  const existing = { id: "abc", title: "Original", content: "Old content" };

  test("returns updated title on success", async () => {
    const ctx = makeCtx({
      getById: async () => existing,
      update:  async () => ({ title: "New title" }),
    });
    const result = await updateMemoryHandler(ctx, { id: "abc", title: "New title" });
    assert.ok(result.content[0].text.includes("✅ Updated"));
    assert.ok(result.content[0].text.includes("New title"));
  });

  test("returns error when memory not found", async () => {
    const ctx = makeCtx({ getById: async () => null });
    const result = await updateMemoryHandler(ctx, { id: "missing", title: "X" });
    assert.ok(result.content[0].text.includes("❌ No memory found"));
  });

  test("returns error when no fields provided", async () => {
    const ctx = makeCtx({ getById: async () => existing });
    const result = await updateMemoryHandler(ctx, { id: "abc" });
    assert.ok(result.content[0].text.includes("❌ No fields to update"));
  });

  test("regenerates embedding when content changes", async () => {
    let embeddingCalled = false;
    const ctx = makeCtx(
      { getById: async () => existing, update: async () => ({ title: "T" }) },
      { generateEmbedding: async () => { embeddingCalled = true; return [0.1]; } },
    );
    await updateMemoryHandler(ctx, { id: "abc", content: "New content" });
    assert.ok(embeddingCalled);
  });

  test("does not regenerate embedding when only tags/importance change", async () => {
    let embeddingCalled = false;
    const ctx = makeCtx(
      { getById: async () => existing, update: async () => ({ title: "Original" }) },
      { generateEmbedding: async () => { embeddingCalled = true; return [0.1]; } },
    );
    await updateMemoryHandler(ctx, { id: "abc", importance: 5 });
    assert.ok(!embeddingCalled);
  });

  test("does not regenerate embedding when vectorEnabled is false", async () => {
    let embeddingCalled = false;
    const ctx = makeCtx(
      { getById: async () => existing, update: async () => ({ title: "T" }) },
      { generateEmbedding: async () => { embeddingCalled = true; return [0.1]; }, vectorEnabled: () => false },
    );
    await updateMemoryHandler(ctx, { id: "abc", title: "New title" });
    assert.ok(!embeddingCalled);
  });
});

// ─── forget ───────────────────────────────────────────────────────────────────

describe("forgetHandler", () => {
  test("returns confirmation with deleted title", async () => {
    const ctx = makeCtx({ delete: async () => "Old memory" });
    const result = await forgetHandler(ctx, { id: "abc-123" });
    assert.ok(result.content[0].text.includes("🗑️ Forgotten"));
    assert.ok(result.content[0].text.includes("Old memory"));
  });

  test("returns error when memory not found", async () => {
    const ctx = makeCtx({ delete: async () => null });
    const result = await forgetHandler(ctx, { id: "nonexistent" });
    assert.ok(result.content[0].text.includes("❌ No memory found"));
  });

  test("passes correct id to store.delete", async () => {
    let capturedId;
    const ctx = makeCtx({ delete: async (id) => { capturedId = id; return "T"; } });
    await forgetHandler(ctx, { id: "target-uuid" });
    assert.equal(capturedId, "target-uuid");
  });
});

// ─── backfill_embeddings ──────────────────────────────────────────────────────

describe("backfillHandler", () => {
  const pending = [
    { id: "1", title: "A", content: "Content A" },
    { id: "2", title: "B", content: "Content B" },
  ];

  test("returns error when vector search not enabled", async () => {
    const ctx = makeCtx({}, { vectorEnabled: () => false });
    const result = await backfillHandler(ctx, {});
    assert.ok(result.content[0].text.includes("❌ Vector search not enabled"));
  });

  test("reports all already embedded when nothing is pending", async () => {
    const ctx = makeCtx({ listWithoutEmbeddings: async () => [] });
    const result = await backfillHandler(ctx, {});
    assert.ok(result.content[0].text.includes("All memories already have embeddings"));
  });

  test("embeds all pending memories on success", async () => {
    let calls = [];
    const ctx = makeCtx({
      listWithoutEmbeddings: async () => pending,
      setEmbedding: async (id, vec) => calls.push({ id, vec }),
    });
    const result = await backfillHandler(ctx, {});
    assert.ok(result.content[0].text.includes("2 embedded"));
    assert.ok(result.content[0].text.includes("0 failed"));
    assert.equal(calls.length, 2);
  });

  test("counts failures when generateEmbedding returns null", async () => {
    let calls = [];
    const ctx = makeCtx(
      { listWithoutEmbeddings: async () => pending, setEmbedding: async (id, vec) => calls.push({ id, vec }) },
      { generateEmbedding: async () => null },
    );
    const result = await backfillHandler(ctx, {});
    assert.ok(result.content[0].text.includes("0 embedded"));
    assert.ok(result.content[0].text.includes("2 failed"));
    assert.equal(calls.length, 0);
  });

  test("respects limit parameter", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), title: `T${i}`, content: `C${i}` }));
    let calls = [];
    const ctx = makeCtx({
      listWithoutEmbeddings: async () => many,
      setEmbedding: async (id) => calls.push(id),
    });
    await backfillHandler(ctx, { limit: 3 });
    assert.equal(calls.length, 3);
  });
});

// ─── dedup_memories ───────────────────────────────────────────────────────────

describe("dedupHandler", () => {
  const pair = { similarity: 0.98, type_a: "fact", title_a: "A", id_a: "1", type_b: "fact", title_b: "B", id_b: "2" };

  test("returns error when vector search not enabled", async () => {
    const ctx = makeCtx({}, { vectorEnabled: () => false });
    const result = await dedupHandler(ctx, {});
    assert.ok(result.content[0].text.includes("❌ Vector search not enabled"));
  });

  test("reports no duplicates when none found", async () => {
    const ctx = makeCtx({ findDuplicates: async () => [] });
    const result = await dedupHandler(ctx, {});
    assert.ok(result.content[0].text.includes("✅ No duplicates found"));
  });

  test("reports duplicate pairs in dry_run mode without merging", async () => {
    let mergeCalled = false;
    const ctx = makeCtx({
      findDuplicates: async () => [pair],
      mergeDuplicate: async () => { mergeCalled = true; },
    });
    const result = await dedupHandler(ctx, { dry_run: true });
    assert.ok(result.content[0].text.includes("98.0% similar"));
    assert.ok(result.content[0].text.includes('"A"'));
    assert.ok(result.content[0].text.includes("dry_run=false"));
    assert.ok(!mergeCalled);
  });

  test("merges duplicates when dry_run is false", async () => {
    let mergedPairs = [];
    const ctx = makeCtx({
      findDuplicates: async () => [pair],
      mergeDuplicate: async (a, b) => mergedPairs.push([a, b]),
    });
    const result = await dedupHandler(ctx, { dry_run: false });
    assert.ok(result.content[0].text.includes("Merged 1 duplicate"));
    assert.equal(mergedPairs.length, 1);
    assert.deepEqual(mergedPairs[0], ["1", "2"]);
  });

  test("passes threshold to store.findDuplicates", async () => {
    let capturedThreshold;
    const ctx = makeCtx({ findDuplicates: async (t) => { capturedThreshold = t; return []; } });
    await dedupHandler(ctx, { threshold: 0.85 });
    assert.equal(capturedThreshold, 0.85);
  });
});