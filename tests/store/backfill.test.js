// tests/store/backfill.test.js
// Tests for the backfill_embeddings tool handler and the silent startup
// auto-backfill branch.
// Uses makeMockStore() — no real DB or embedding provider needed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { makeMockStore } from "../mockStore.js";

// ─── Functions under test ─────────────────────────────────────────────────────
// These mirror the handlers in mcp/index.js but accept (store, generateEmbedding)
// as explicit parameters so both can be swapped in tests without module hacks.

/**
 * Mirrors the backfill_embeddings tool handler.
 */
async function backfillTool(store, generateEmbedding, { limit = 20 } = {}) {
  const pending = (await store.listWithoutEmbeddings()).slice(0, limit);
  if (!pending.length)
    return { content: [{ type: "text", text: "✅ All memories already have embeddings!" }] };

  let success = 0, failed = 0;
  for (const row of pending) {
    const embedding = await generateEmbedding(`${row.title}. ${row.content}`);
    if (embedding) {
      await store.setEmbedding(row.id, embedding);
      success++;
    } else {
      failed++;
    }
  }

  return {
    content: [{
      type: "text",
      text: `✅ Backfill complete: ${success} embedded, ${failed} failed. ${pending.length - success - failed} remaining.`,
    }],
  };
}

/**
 * Mirrors the silent auto-backfill startup branch from mcp/index.js.
 * Returns which branch was taken so tests can assert cleanly.
 */
async function runStartupBackfillBranch(store, generateEmbedding) {
  const { total, embedded: embCount } = await store.counts();

  if (embCount === 0 && total > 0) {
    const pending = await store.listWithoutEmbeddings();
    let success = 0, failed = 0;
    for (const row of pending) {
      const embedding = await generateEmbedding(`${row.title}. ${row.content}`);
      if (embedding) { await store.setEmbedding(row.id, embedding); success++; }
      else failed++;
    }
    return { branch: "backfilled", success, failed };
  }

  if (embCount === 0 && total === 0) {
    return { branch: "empty" };
  }

  return { branch: "ready" };
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const fakeEmbedding  = [0.1, 0.2, 0.3];
const alwaysSucceeds = async () => fakeEmbedding;
const alwaysFails    = async () => null;

// ─── backfillTool ─────────────────────────────────────────────────────────────

describe("backfillTool", () => {
  test("reports all already embedded when nothing is pending", async () => {
    const store = makeMockStore({ counts: { total: 3, embedded: 3 }, withoutEmbeddings: [] });
    const result = await backfillTool(store, alwaysSucceeds);
    assert.ok(result.content[0].text.includes("All memories already have embeddings"));
  });

  test("embeds all pending memories on success", async () => {
    const pending = [
      { id: "1", title: "A", content: "Content A" },
      { id: "2", title: "B", content: "Content B" },
    ];
    const store = makeMockStore({ counts: { total: 2, embedded: 0 }, withoutEmbeddings: pending });
    const result = await backfillTool(store, alwaysSucceeds);
    assert.ok(result.content[0].text.includes("2 embedded"));
    assert.ok(result.content[0].text.includes("0 failed"));
    assert.equal(store._setEmbeddingCalls.length, 2);
  });

  test("counts failures when embedding provider returns null", async () => {
    const pending = [
      { id: "1", title: "A", content: "Content A" },
      { id: "2", title: "B", content: "Content B" },
    ];
    const store = makeMockStore({ counts: { total: 2, embedded: 0 }, withoutEmbeddings: pending });
    const result = await backfillTool(store, alwaysFails);
    assert.ok(result.content[0].text.includes("0 embedded"));
    assert.ok(result.content[0].text.includes("2 failed"));
    assert.equal(store._setEmbeddingCalls.length, 0);
  });

  test("handles partial failures — some succeed, some fail", async () => {
    const pending = [
      { id: "1", title: "A", content: "Content A" },
      { id: "2", title: "B", content: "Content B" },
      { id: "3", title: "C", content: "Content C" },
    ];
    const store = makeMockStore({ counts: { total: 3, embedded: 0 }, withoutEmbeddings: pending });
    let call = 0;
    const flakyEmbedding = async () => (++call % 2 === 0 ? null : fakeEmbedding);
    const result = await backfillTool(store, flakyEmbedding);
    assert.ok(result.content[0].text.includes("embedded"));
    assert.ok(result.content[0].text.includes("failed"));
    assert.ok(store._setEmbeddingCalls.length < pending.length);
  });

  test("respects the limit parameter", async () => {
    const pending = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), title: `T${i}`, content: `C${i}`,
    }));
    const store = makeMockStore({ counts: { total: 10, embedded: 0 }, withoutEmbeddings: pending });
    await backfillTool(store, alwaysSucceeds, { limit: 3 });
    assert.equal(store._setEmbeddingCalls.length, 3);
  });

  test("calls setEmbedding with the correct id and vector", async () => {
    const pending = [{ id: "target-id", title: "My title", content: "My content" }];
    const store = makeMockStore({ counts: { total: 1, embedded: 0 }, withoutEmbeddings: pending });
    await backfillTool(store, alwaysSucceeds);
    assert.equal(store._setEmbeddingCalls[0].id, "target-id");
    assert.deepEqual(store._setEmbeddingCalls[0].embedding, fakeEmbedding);
  });

  test("passes concatenated title + content to generateEmbedding", async () => {
    const pending = [{ id: "1", title: "My title", content: "My content" }];
    const store = makeMockStore({ counts: { total: 1, embedded: 0 }, withoutEmbeddings: pending });
    let capturedText = null;
    await backfillTool(store, async (text) => { capturedText = text; return fakeEmbedding; });
    assert.ok(capturedText.includes("My title"));
    assert.ok(capturedText.includes("My content"));
  });

  test("default limit is 20", async () => {
    const pending = Array.from({ length: 25 }, (_, i) => ({
      id: String(i), title: `T${i}`, content: `C${i}`,
    }));
    const store = makeMockStore({ counts: { total: 25, embedded: 0 }, withoutEmbeddings: pending });
    await backfillTool(store, alwaysSucceeds); // no limit override
    assert.equal(store._setEmbeddingCalls.length, 20);
  });
});

// ─── runStartupBackfillBranch ─────────────────────────────────────────────────

describe("runStartupBackfillBranch", () => {
  test("takes 'backfilled' branch when memories exist but none are embedded", async () => {
    const pending = [{ id: "1", title: "A", content: "C" }];
    const store = makeMockStore({ counts: { total: 1, embedded: 0 }, withoutEmbeddings: pending });
    const result = await runStartupBackfillBranch(store, alwaysSucceeds);
    assert.equal(result.branch, "backfilled");
  });

  test("takes 'empty' branch on a fresh install with no memories", async () => {
    const store = makeMockStore({ counts: { total: 0, embedded: 0 }, withoutEmbeddings: [] });
    const result = await runStartupBackfillBranch(store, alwaysSucceeds);
    assert.equal(result.branch, "empty");
  });

  test("takes 'ready' branch when all embeddings already exist", async () => {
    const store = makeMockStore({ counts: { total: 5, embedded: 5 }, withoutEmbeddings: [] });
    const result = await runStartupBackfillBranch(store, alwaysSucceeds);
    assert.equal(result.branch, "ready");
  });

  test("takes 'ready' branch when embeddings are partially present", async () => {
    const store = makeMockStore({ counts: { total: 5, embedded: 3 }, withoutEmbeddings: [] });
    const result = await runStartupBackfillBranch(store, alwaysSucceeds);
    assert.equal(result.branch, "ready");
  });

  test("reports correct success count after silent backfill", async () => {
    const pending = [
      { id: "1", title: "A", content: "C" },
      { id: "2", title: "B", content: "D" },
    ];
    const store = makeMockStore({ counts: { total: 2, embedded: 0 }, withoutEmbeddings: pending });
    const result = await runStartupBackfillBranch(store, alwaysSucceeds);
    assert.equal(result.success, 2);
    assert.equal(result.failed, 0);
  });

  test("reports failures gracefully when embedding provider is down", async () => {
    const pending = [{ id: "1", title: "A", content: "C" }];
    const store = makeMockStore({ counts: { total: 1, embedded: 0 }, withoutEmbeddings: pending });
    const result = await runStartupBackfillBranch(store, alwaysFails);
    assert.equal(result.branch, "backfilled");
    assert.equal(result.success, 0);
    assert.equal(result.failed, 1);
    assert.equal(store._setEmbeddingCalls.length, 0);
  });

  test("does not call setEmbedding on the 'empty' branch", async () => {
    const store = makeMockStore({ counts: { total: 0, embedded: 0 }, withoutEmbeddings: [] });
    await runStartupBackfillBranch(store, alwaysSucceeds);
    assert.equal(store._setEmbeddingCalls.length, 0);
  });

  test("does not call setEmbedding on the 'ready' branch", async () => {
    const store = makeMockStore({ counts: { total: 3, embedded: 3 }, withoutEmbeddings: [] });
    await runStartupBackfillBranch(store, alwaysSucceeds);
    assert.equal(store._setEmbeddingCalls.length, 0);
  });

  test("embedded count returned by backfill branch matches store length", async () => {
    const pending = Array.from({ length: 4 }, (_, i) => ({
      id: String(i), title: `T${i}`, content: `C${i}`,
    }));
    const store = makeMockStore({ counts: { total: 4, embedded: 0 }, withoutEmbeddings: pending });
    const result = await runStartupBackfillBranch(store, alwaysSucceeds);
    assert.equal(result.success + result.failed, pending.length);
  });
});