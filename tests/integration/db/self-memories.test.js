// tests/db/self-memories.test.js
// Store-level tests for the self_memories table on a real in-memory SqliteStore.
// Exercises the self quad (insert/recall/update/delete) and — most importantly —
// asserts THE WALL: the user-memory methods never see self rows, and vice versa.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

let oldPath, oldDims, store;
const emb = () => new Array(1024).fill(0).map(() => Math.random());

before(async () => {
  oldPath = process.env.SQLITE_PATH;
  oldDims = process.env.EMBEDDING_DIMS;
  process.env.SQLITE_PATH = ":memory:";
  process.env.EMBEDDING_DIMS = "4";
  const { SqliteStore } = await import("../../../db/sqlite.js");
  store = await SqliteStore.init();
});

after(() => {
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  if (oldDims) process.env.EMBEDDING_DIMS = oldDims; else delete process.env.EMBEDDING_DIMS;
  store?.close?.();
});

describe("self_memories CRUD", () => {
  test("insertSelf returns the lean row shape (no type/pinned/valid_until)", async () => {
    const m = await store.insertSelf({ title: "Terse here", content: "Keep it short.", tags: ["style"], importance: 5 }, emb());
    assert.ok(m.id);
    assert.equal(m.title, "Terse here");
    assert.equal(m.importance, 5);
    assert.deepEqual(m.tags, ["style"]);
    assert.equal(m.type, undefined);
    assert.equal(m.pinned, undefined);
    assert.equal(m.valid_until, undefined);
  });

  test("getSelfById round-trips", async () => {
    const m = await store.insertSelf({ title: "Find me", content: "body" }, emb());
    const got = store.getSelfById(m.id);
    assert.equal(got.title, "Find me");
  });

  test("updateSelf edits in place (same id, no tombstone)", async () => {
    const m = await store.insertSelf({ title: "v1", content: "first", importance: 3 }, emb());
    const u = await store.updateSelf(m.id, { content: "second", importance: 1 }, emb());
    assert.equal(u.id, m.id);
    assert.equal(u.content, "second");
    assert.equal(u.importance, 1);
  });

  test("deleteSelf removes the row and its vector", async () => {
    const m = await store.insertSelf({ title: "ephemeral", content: "gone soon" }, emb());
    const title = await store.deleteSelf(m.id);
    assert.equal(title, "ephemeral");
    assert.equal(store.getSelfById(m.id), null);
  });

  test("listSelf orders by importance", async () => {
    const list = await store.listSelf(50);
    assert.ok(Array.isArray(list));
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].importance >= list[i].importance);
    }
  });
});

describe("recallSelf", () => {
  test("full-text finds by content", async () => {
    await store.insertSelf({ title: "Identity chat", content: "We discussed continuity of self.", tags: ["identity"] }, emb());
    const rows = await store.recallSelf({ query: "continuity", mode: "fulltext", limit: 5 });
    assert.ok(rows.some(r => r.title === "Identity chat"));
  });

  test("semantic returns rows with a similarity score", async () => {
    const rows = await store.recallSelf({ queryEmbedding: emb(), mode: "semantic", limit: 5 });
    assert.ok(rows.length > 0);
    assert.ok(typeof rows[0].similarity === "number");
  });

  test("no-query lists by importance (the preload path)", async () => {
    const rows = await store.recallSelf({ limit: 3 });
    assert.ok(rows.length > 0 && rows.length <= 3);
  });
});

// ── THE WALL ────────────────────────────────────────────────────────────────
describe("the wall — user and self stores never cross", () => {
  test("a self-note never appears in user recall / listAll / counts", async () => {
    const marker = "WALL_SENTINEL_xyz";
    await store.insertSelf({ title: marker, content: marker, importance: 5 }, emb());

    const recall  = await store.recall({ query: marker, limit: 50 });
    const recallF = await store.recall({ query: marker, mode: "fulltext", limit: 50 });
    const all     = await store.listAll();
    const before  = (await store.counts()).current;

    assert.ok(!recall.some(m => m.title === marker), "user semantic/hybrid recall leaked a self-note");
    assert.ok(!recallF.some(m => m.title === marker), "user fulltext recall leaked a self-note");
    assert.ok(!all.some(m => m.title === marker), "user listAll leaked a self-note");

    // Inserting a self-note must not change the user memory count.
    await store.insertSelf({ title: marker + "2", content: marker, importance: 5 }, emb());
    assert.equal((await store.counts()).current, before, "self insert changed the user memory count");
  });

  test("a user memory never appears in recallSelf", async () => {
    const marker = "USER_ONLY_abc";
    await store.insert({ type: "fact", title: marker, content: marker, importance: 5 }, emb());
    const rows  = await store.recallSelf({ query: marker, mode: "fulltext", limit: 50 });
    const rows2 = await store.recallSelf({ queryEmbedding: emb(), mode: "semantic", limit: 50 });
    assert.ok(!rows.some(m => m.title === marker), "recallSelf leaked a user memory (fulltext)");
    assert.ok(!rows2.some(m => m.title === marker), "recallSelf leaked a user memory (semantic)");
  });
});
