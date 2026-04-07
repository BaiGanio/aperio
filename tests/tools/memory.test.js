// tests/tools/memory.test.js
// Tests for all memory tool handlers:
// rememberHandler, recallHandler, updateMemoryHandler,
// forgetHandler, backfillHandler, dedupHandler.
// Imports directly from mcp/tools/memory.js — no inline copies.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  rememberHandler,
  recallHandler,
  updateMemoryHandler,
  forgetHandler,
  backfillHandler,
  dedupHandler,
} from "../../mcp/tools/memory.js";

// ─── ctx / store factories ────────────────────────────────────────────────────

function makeMemory(overrides = {}) {
  return {
    id:         "aaaaaaaa-0000-0000-0000-000000000001",
    type:       "fact",
    title:      "Test title",
    content:    "Test content",
    tags:       ["testing"],
    importance: 3,
    source:     "claude",
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  return {
    insert:               async (data) => ({ ...makeMemory(), ...data }),
    recall:               async () => [],
    getById:              async () => makeMemory(),
    update:               async (id, input) => ({ ...makeMemory(), ...input }),
    delete:               async () => "Test title",
    listWithoutEmbeddings: async () => [],
    setEmbedding:         async () => {},
    findDuplicates:       async () => [],
    mergeDuplicate:       async () => {},
    ...overrides,
  };
}

function makeCtx(storeOverrides = {}, { vectorOn = true } = {}) {
  return {
    store:            makeStore(storeOverrides),
    generateEmbedding: async () => [0.1, 0.2, 0.3],
    vectorEnabled:    () => vectorOn,
  };
}

// ─── rememberHandler ─────────────────────────────────────────────────────────

describe("rememberHandler", () => {
  test("saves a memory and returns confirmation with id", async () => {
    const ctx = makeCtx();
    const result = await rememberHandler(ctx, {
      type: "fact", title: "Sky color", content: "The sky is blue.",
    });
    const text = result.content[0].text;
    assert.ok(text.includes("✅ Memory saved"));
    assert.ok(text.includes("[fact]"));
    assert.ok(text.includes("Sky color"));
  });

  test("includes semantic embedding note when embedding is generated", async () => {
    const ctx = makeCtx();
    const result = await rememberHandler(ctx, {
      type: "fact", title: "T", content: "C",
    });
    assert.ok(result.content[0].text.includes("with semantic embedding"));
  });

  test("omits embedding note when generateEmbedding returns null", async () => {
    const ctx = { ...makeCtx(), generateEmbedding: async () => null };
    const result = await rememberHandler(ctx, { type: "fact", title: "T", content: "C" });
    assert.ok(!result.content[0].text.includes("semantic embedding"));
  });

  test("forwards tags and importance to store", async () => {
    let received;
    const ctx = makeCtx({ insert: async (data) => { received = data; return makeMemory(data); } });
    await rememberHandler(ctx, {
      type: "preference", title: "T", content: "C", tags: ["a", "b"], importance: 5,
    });
    assert.deepEqual(received.tags, ["a", "b"]);
    assert.equal(received.importance, 5);
  });
});

// ─── recallHandler ────────────────────────────────────────────────────────────

describe("recallHandler", () => {
  test("returns 'No memories found' when store returns empty", async () => {
    const result = await recallHandler(makeCtx(), { query: "anything" });
    assert.ok(result.content[0].text.includes("No memories found"));
  });

  test("formats and returns memories when rows exist", async () => {
    const ctx = makeCtx({
      recall: async () => [makeMemory({ similarity: 0.95 })],
    });
    const result = await recallHandler(ctx, { query: "test" });
    const text = result.content[0].text;
    assert.ok(text.includes("[FACT]"));
    assert.ok(text.includes("Test title"));
    assert.ok(text.includes("95%"));
    assert.ok(text.includes("testing"));
  });

  test("skips embedding when vectorEnabled is false", async () => {
    let embeddingCalled = false;
    const ctx = {
      store: makeStore({ recall: async () => [] }),
      generateEmbedding: async () => { embeddingCalled = true; return [0.1]; },
      vectorEnabled: () => false,
    };
    await recallHandler(ctx, { query: "test" });
    assert.equal(embeddingCalled, false);
  });

  test("skips embedding when search_mode is fulltext", async () => {
    let embeddingCalled = false;
    const ctx = {
      store: makeStore({ recall: async () => [] }),
      generateEmbedding: async () => { embeddingCalled = true; return [0.1]; },
      vectorEnabled: () => true,
    };
    await recallHandler(ctx, { query: "test", search_mode: "fulltext" });
    assert.equal(embeddingCalled, false);
  });

  test("applies default limit of 10 when not specified", async () => {
    let capturedLimit;
    const ctx = makeCtx({ recall: async ({ limit }) => { capturedLimit = limit; return []; } });
    await recallHandler(ctx, {});
    assert.equal(capturedLimit, 10);
  });

  test("formats rows without similarity score (full-text path)", async () => {
    const ctx = makeCtx({
      recall: async () => [makeMemory()], // no similarity field
    });
    const result = await recallHandler(ctx, { query: "test", search_mode: "fulltext" });
    assert.ok(!result.content[0].text.includes("similarity"));
  });
});

// ─── updateMemoryHandler ──────────────────────────────────────────────────────

describe("updateMemoryHandler", () => {
  test("returns error when memory id does not exist", async () => {
    const ctx = makeCtx({ getById: async () => null });
    const result = await updateMemoryHandler(ctx, { id: "missing-id", title: "X" });
    assert.ok(result.content[0].text.includes("❌ No memory found"));
  });

  test("returns error when no fields are provided", async () => {
    const result = await updateMemoryHandler(makeCtx(), { id: "some-id" });
    assert.ok(result.content[0].text.includes("❌ No fields to update"));
  });

  test("updates title and returns confirmation", async () => {
    const result = await updateMemoryHandler(makeCtx(), {
      id: "some-id", title: "New title",
    });
    assert.ok(result.content[0].text.includes("✅ Updated"));
    assert.ok(result.content[0].text.includes("New title"));
  });

  test("updates content and regenerates embedding when vectorEnabled", async () => {
    let embeddingCalled = false;
    const ctx = {
      store: makeStore(),
      generateEmbedding: async () => { embeddingCalled = true; return [0.1]; },
      vectorEnabled: () => true,
    };
    await updateMemoryHandler(ctx, { id: "id", content: "Updated content" });
    assert.equal(embeddingCalled, true);
  });

  test("does not regenerate embedding when vectorEnabled is false", async () => {
    let embeddingCalled = false;
    const ctx = {
      store: makeStore(),
      generateEmbedding: async () => { embeddingCalled = true; return [0.1]; },
      vectorEnabled: () => false,
    };
    await updateMemoryHandler(ctx, { id: "id", content: "Updated" });
    assert.equal(embeddingCalled, false);
  });

  test("updates tags and importance without regenerating embedding", async () => {
    let embeddingCalled = false;
    const ctx = {
      store: makeStore(),
      generateEmbedding: async () => { embeddingCalled = true; return [0.1]; },
      vectorEnabled: () => true,
    };
    await updateMemoryHandler(ctx, { id: "id", tags: ["new"], importance: 4 });
    assert.equal(embeddingCalled, false);
  });
});

// ─── forgetHandler ────────────────────────────────────────────────────────────

describe("forgetHandler", () => {
  test("returns confirmation when memory is deleted", async () => {
    const result = await forgetHandler(makeCtx(), { id: "some-id" });
    assert.ok(result.content[0].text.includes("🗑️ Forgotten"));
    assert.ok(result.content[0].text.includes("Test title"));
  });

  test("returns error when memory id does not exist", async () => {
    const ctx = makeCtx({ delete: async () => null });
    const result = await forgetHandler(ctx, { id: "missing-id" });
    assert.ok(result.content[0].text.includes("❌ No memory found"));
  });
});

// ─── backfillHandler ─────────────────────────────────────────────────────────

describe("backfillHandler", () => {
  test("returns error when vector search is not enabled", async () => {
    const ctx = makeCtx({}, { vectorOn: false });
    const result = await backfillHandler(ctx, {});
    assert.ok(result.content[0].text.includes("❌ Vector search not enabled"));
  });

  test("returns success when no pending memories exist", async () => {
    const result = await backfillHandler(makeCtx(), {});
    assert.ok(result.content[0].text.includes("✅ All memories already have embeddings"));
  });

  test("embeds pending memories and reports success count", async () => {
    const pending = [
      { id: "1", title: "A", content: "Content A" },
      { id: "2", title: "B", content: "Content B" },
    ];
    const ctx = makeCtx({ listWithoutEmbeddings: async () => pending });
    const result = await backfillHandler(ctx, { limit: 10 });
    const text = result.content[0].text;
    assert.ok(text.includes("✅ Backfill complete"));
    assert.ok(text.includes("2 embedded"));
    assert.ok(text.includes("0 failed"));
  });

  test("counts failed embeddings when generateEmbedding returns null", async () => {
    const pending = [{ id: "1", title: "A", content: "C" }];
    const ctx = {
      store: makeStore({ listWithoutEmbeddings: async () => pending }),
      generateEmbedding: async () => null,
      vectorEnabled: () => true,
    };
    const result = await backfillHandler(ctx, {});
    assert.ok(result.content[0].text.includes("1 failed"));
    assert.ok(result.content[0].text.includes("0 embedded"));
  });

  test("respects limit and slices pending list", async () => {
    const pending = Array.from({ length: 10 }, (_, i) => ({ id: String(i), title: "T", content: "C" }));
    let processed = 0;
    const ctx = {
      store: makeStore({
        listWithoutEmbeddings: async () => pending,
        setEmbedding: async () => { processed++; },
      }),
      generateEmbedding: async () => [0.1],
      vectorEnabled: () => true,
    };
    await backfillHandler(ctx, { limit: 3 });
    assert.equal(processed, 3);
  });
});

// ─── dedupHandler ─────────────────────────────────────────────────────────────

describe("dedupHandler", () => {
  test("returns error when vector search is not enabled", async () => {
    const ctx = makeCtx({}, { vectorOn: false });
    const result = await dedupHandler(ctx, {});
    assert.ok(result.content[0].text.includes("❌ Vector search not enabled"));
  });

  test("returns success message when no duplicates found", async () => {
    const result = await dedupHandler(makeCtx(), { threshold: 0.97 });
    assert.ok(result.content[0].text.includes("✅ No duplicates found"));
    assert.ok(result.content[0].text.includes("97%"));
  });

  test("reports duplicate pairs in dry_run mode without merging", async () => {
    const pairs = [{
      similarity: 0.99, id_a: "1", id_b: "2",
      type_a: "fact", type_b: "fact",
      title_a: "Same A", title_b: "Same B",
    }];
    const ctx = makeCtx({ findDuplicates: async () => pairs });
    const result = await dedupHandler(ctx, { dry_run: true });
    const text = result.content[0].text;
    assert.ok(text.includes("99.0% similar"));
    assert.ok(text.includes("Same A"));
    assert.ok(text.includes("Same B"));
    assert.ok(text.includes("dry_run=false"));
  });

  test("merges duplicates when dry_run is false", async () => {
    let mergedPair;
    const pairs = [{
      similarity: 0.99, id_a: "1", id_b: "2",
      type_a: "fact", type_b: "fact",
      title_a: "Dup A", title_b: "Dup B",
    }];
    const ctx = makeCtx({
      findDuplicates: async () => pairs,
      mergeDuplicate: async (a, b) => { mergedPair = [a, b]; },
    });
    const result = await dedupHandler(ctx, { dry_run: false });
    assert.ok(result.content[0].text.includes("🧹 Merged 1"));
    assert.deepEqual(mergedPair, ["1", "2"]);
  });
});