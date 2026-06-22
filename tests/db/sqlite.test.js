// tests/db/sqlite.test.js
//
// Tests for SqliteStore. Uses an in-memory (':memory:') database — sqlite-vec
// loads into RAM and no file is created on disk — then exercises CRUD, recall,
// settings, and pin/expiry operations.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

let oldPath;
let store;

before(async () => {
  // ':memory:' → init() opens an ephemeral in-RAM DB (zero real disk access).
  oldPath = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = ":memory:";
  // Use low dims for fast vectors
  process.env.EMBEDDING_DIMS = "4";

  const { SqliteStore } = await import("../../db/sqlite.js");
  store = await SqliteStore.init();
});

after(() => {
  if (oldPath) process.env.SQLITE_PATH = oldPath;
  else delete process.env.SQLITE_PATH;
});

// =============================================================================
// Basic store properties
// =============================================================================
describe("SqliteStore init", () => {
  test("store has expected properties", () => {
    assert.ok(store.db, "should have db");
    assert.ok(store.wiki, "should have wiki sub-store");
    assert.ok(Array.isArray(store.cache), "should have cache array");
    assert.ok(store.cache.length > 0, "should have seeded memories");
  });

  test("store.db is a better-sqlite3 Database instance", () => {
    assert.equal(typeof store.db.prepare, "function");
    assert.equal(typeof store.db.transaction, "function");
  });
});

// =============================================================================
// CRUD: insert, getById, listAll, delete
// =============================================================================
describe("CRUD operations", () => {
  test("insert creates a memory and returns it", async () => {
    const mem = await store.insert({
      type: "fact",
      title: "Test memory",
      content: "This is a test memory content.",
      tags: ["test", "demo"],
      importance: 5,
      source: "manual",
    });
    assert.ok(mem.id, "should have id");
    assert.equal(mem.title, "Test memory");
    assert.equal(mem.type, "fact");
    assert.ok(mem.tags.includes("test"));
    assert.equal(mem.importance, 5);
  });

  test("insert with embedding stores vector", async () => {
    const mem = await store.insert(
      { type: "fact", title: "Vector test", content: "With embedding" },
      new Array(1024).fill(0.1)
    );
    assert.ok(mem.id);

    // List without embeddings should NOT include this memory
    const unembedded = await store.listWithoutEmbeddings();
    assert.ok(!unembedded.some(m => m.id === mem.id), "should not appear in unembedded list");
  });

  test("getById returns null for nonexistent id", async () => {
    const mem = await store.getById("nonexistent-id");
    assert.equal(mem, null);
  });

  test("listAll returns all current memories", async () => {
    const all = await store.listAll();
    assert.ok(Array.isArray(all));
    // Should include seeded memories + our inserts
    assert.ok(all.length >= 2, "should have at least seeded + test memories");
  });

  test("delete removes a memory", async () => {
    const mem = await store.insert({
      type: "fact", title: "To delete", content: "Will be removed",
    });
    const deleted = await store.delete(mem.id);
    assert.equal(deleted, "To delete");
    const gone = await store.getById(mem.id);
    assert.equal(gone, null);
  });

  test("delete returns null for nonexistent id", async () => {
    const result = await store.delete("nonexistent");
    assert.equal(result, null);
  });
});

// =============================================================================
// update (supersede row pattern)
// =============================================================================
describe("update", () => {
  let original;

  before(async () => {
    original = await store.insert({
      type: "fact", title: "Original", content: "Original content",
      importance: 3, tags: ["old"],
    });
  });

  test("marks old row as superseded and creates new row", async () => {
    const updated = await store.update(original.id, {
      title: "Updated title",
      content: "Updated content",
      importance: 5,
    });
    assert.ok(updated.id !== original.id, "new row has different id");
    assert.equal(updated.title, "Updated title");
    assert.equal(updated.importance, 5);
  });

  test("old row no longer appears in listAll", async () => {
    const all = await store.listAll();
    assert.ok(!all.some(m => m.id === original.id), "original should not appear");
  });

  test("throws for nonexistent id", async () => {
    await assert.rejects(
      () => store.update("nonexistent-id", { title: "Nope" }),
      { message: /not found/ }
    );
  });
});

// =============================================================================
// update → wiki staleness + source re-pointing
// (tombstone+insert hides the edit from the AFTER-UPDATE trigger, so update()
//  marks citing articles stale and re-points their sources explicitly)
// =============================================================================
describe("update marks citing wiki articles stale", () => {
  let mem;

  before(async () => {
    mem = await store.insert({
      type: "fact", title: "Source memory", content: "Grounding content", importance: 3,
    });
    await store.wiki.upsert({
      slug: "wiki-stale-test", title: "Stale Test", summary: "s",
      body_md: `Cites [[mem:${mem.id}]].`, tags: [],
      generated_by: "test", source_hash: "h", source_memory_ids: [mem.id],
    }, null);
  });

  test("article starts fresh and cites the original memory", async () => {
    const a = await store.wiki.get("wiki-stale-test");
    assert.equal(a.status, "fresh");
    assert.deepEqual(a.source_memory_ids, [mem.id]);
  });

  test("editing the memory marks the article stale and re-points the source", async () => {
    const updated = await store.update(mem.id, { content: "Changed content" });
    const a = await store.wiki.get("wiki-stale-test");
    assert.equal(a.status, "stale", "article should be marked stale");
    assert.deepEqual(a.source_memory_ids, [updated.id], "source should point at the new version");
    assert.ok(!a.source_memory_ids.includes(mem.id), "old (tombstoned) id should be gone");
  });
});

// =============================================================================
// mergeDuplicate → folds the duplicate's wiki citations into the survivor
// =============================================================================
describe("mergeDuplicate re-points wiki sources to the survivor", () => {
  test("article citing only the duplicate moves to the survivor and goes stale", async () => {
    const survivor  = await store.insert({ type: "fact", title: "A", content: "aaa" });
    const duplicate = await store.insert({ type: "fact", title: "B", content: "bbb" });
    await store.wiki.upsert({
      slug: "wiki-merge-only-b", title: "Only B", body_md: `[[mem:${duplicate.id}]]`,
      tags: [], generated_by: "test", source_hash: "h", source_memory_ids: [duplicate.id],
    }, null);

    await store.mergeDuplicate(survivor.id, duplicate.id);

    const a = await store.wiki.get("wiki-merge-only-b");
    assert.equal(a.status, "stale");
    assert.deepEqual(a.source_memory_ids, [survivor.id], "citation should move to survivor");
  });

  test("article citing both collapses to a single survivor citation", async () => {
    const survivor  = await store.insert({ type: "fact", title: "C", content: "ccc" });
    const duplicate = await store.insert({ type: "fact", title: "D", content: "ddd" });
    await store.wiki.upsert({
      slug: "wiki-merge-both", title: "Both",
      body_md: `[[mem:${survivor.id}]] [[mem:${duplicate.id}]]`, tags: [],
      generated_by: "test", source_hash: "h",
      source_memory_ids: [survivor.id, duplicate.id],
    }, null);

    await store.mergeDuplicate(survivor.id, duplicate.id);

    const a = await store.wiki.get("wiki-merge-both");
    assert.equal(a.status, "stale");
    assert.deepEqual(a.source_memory_ids, [survivor.id], "redundant duplicate citation dropped");
  });
});

// =============================================================================
// Recall (FTS-only path)
// =============================================================================
describe("recall (FTS-only)", () => {
  before(async () => {
    await store.insert({
      type: "fact", title: "Apple pie", content: "How to bake an apple pie",
      tags: ["recipe"],
    });
    await store.insert({
      type: "fact", title: "Banana bread", content: "Banana bread recipe",
      tags: ["recipe", "baking"],
    });
  });

  test("returns results for text query", async () => {
    const results = await store.recall({ query: "apple", limit: 10, mode: "fulltext" });
    assert.ok(results.length >= 1, "should find apple memories");
    assert.ok(results.some(r => r.title === "Apple pie"));
  });

  test("filters by type", async () => {
    const results = await store.recall({
      query: "recipe", type: "fact", limit: 10, mode: "fulltext",
    });
    assert.ok(results.length >= 1);
  });

  test("filters by tags", async () => {
    const results = await store.recall({
      query: "banana", tags: ["baking"], limit: 10, mode: "fulltext",
    });
    assert.ok(results.length >= 1);
  });
});

// =============================================================================
// Pin / Expiry
// =============================================================================
describe("pin / expiry", () => {
  let mem;

  before(async () => {
    mem = await store.insert({
      type: "fact", title: "Pin test", content: "Testing pin",
    });
  });

  test("setPin returns true and pins a memory", async () => {
    const ok = await store.setPin(mem.id, true);
    assert.ok(ok);
    const updated = await store.getById(mem.id);
    assert.equal(updated.pinned, true);
  });

  test("setExpiry returns true", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString(); // +1 day
    const ok = await store.setExpiry(mem.id, future);
    assert.ok(ok);
  });

  test("setExpiry with null clears expiry", async () => {
    const ok = await store.setExpiry(mem.id, null);
    assert.ok(ok);
  });
});

// =============================================================================
// Counts
// =============================================================================
describe("counts", () => {
  test("returns total and embedded counts", async () => {
    const c = await store.counts();
    assert.ok(typeof c.total === "number");
    assert.ok(c.total >= 1);
    assert.ok(typeof c.embedded === "number");
  });
});

// =============================================================================
// ListWithoutEmbeddings
// =============================================================================
describe("listWithoutEmbeddings", () => {
  test("returns memories without vector embeddings", async () => {
    // Insert without embedding
    await store.insert({
      type: "fact", title: "No vec", content: "No vector for this one",
    });
    const unembedded = await store.listWithoutEmbeddings();
    assert.ok(Array.isArray(unembedded));
  });
});

// =============================================================================
// Settings
// =============================================================================
describe("settings", () => {
  test("setSetting stores a value", async () => {
    const result = await store.setSetting("theme", "dark");
    assert.equal(result, "dark");
  });

  test("getSetting retrieves a value", async () => {
    await store.setSetting("theme", "dark");
    const value = await store.getSetting("theme");
    assert.equal(value, "dark");
  });

  test("getSetting returns null for missing key", async () => {
    const value = await store.getSetting("nonexistent-key");
    assert.equal(value, null);
  });

  test("getSettings returns all settings as object", async () => {
    const all = await store.getSettings();
    assert.equal(all.theme, "dark");
  });

  test("deleteSetting returns true for existing key", async () => {
    const ok = await store.deleteSetting("theme");
    assert.ok(ok);
    const value = await store.getSetting("theme");
    assert.equal(value, null);
  });

  test("deleteSetting returns false for missing key", async () => {
    const ok = await store.deleteSetting("nonexistent");
    assert.equal(ok, false);
  });
});

// =============================================================================
// Bulk insert
// =============================================================================
describe("bulkInsert", () => {
  test("inserts multiple memories", async () => {
    const results = await store.bulkInsert([
      { type: "fact", title: "Bulk A", content: "First bulk" },
      { type: "fact", title: "Bulk B", content: "Second bulk" },
    ]);
    assert.equal(results.length, 2);
    assert.ok(results[0].id);
    assert.equal(results[1].title, "Bulk B");
  });

  test("returns empty array for empty input", async () => {
    const results = await store.bulkInsert([]);
    assert.deepEqual(results, []);
  });
});

// =============================================================================
// Background-agent jobs + run history (Phase 4)
// =============================================================================
describe("agent jobs", () => {
  test("seeds the nightly-maintenance example", async () => {
    const job = await store.getAgentJob("nightly-maintenance");
    assert.ok(job, "example job should be seeded by the migration");
    assert.equal(job.enabled, true);
    assert.equal(job.trigger.kind, "interval");
    assert.equal(job.steps.length, 2);
  });

  test("upsert round-trips a freeform job and merges definition fields", async () => {
    const saved = await store.upsertAgentJob({
      id: "digest",
      enabled: false,
      trigger: { kind: "interval", everyMs: 3600000 },
      prompt: "Summarise recent memories.",
      provider: { name: "deepseek", model: "deepseek-v4-flash" },
    });
    assert.equal(saved.id, "digest");
    assert.equal(saved.enabled, false);
    assert.equal(saved.prompt, "Summarise recent memories.");
    assert.equal(saved.provider.model, "deepseek-v4-flash");

    const fetched = await store.getAgentJob("digest");
    assert.equal(fetched.prompt, "Summarise recent memories.");
  });

  test("upsert overwrites an existing job", async () => {
    await store.upsertAgentJob({ id: "ov", enabled: true, prompt: "v1" });
    const updated = await store.upsertAgentJob({ id: "ov", enabled: true, prompt: "v2" });
    assert.equal(updated.prompt, "v2");
  });

  test("listAgentJobs returns all jobs", async () => {
    const jobs = await store.listAgentJobs();
    const ids = jobs.map(j => j.id);
    assert.ok(ids.includes("nightly-maintenance"));
    assert.ok(ids.includes("digest"));
  });

  test("delete removes a job and reports success", async () => {
    await store.upsertAgentJob({ id: "tmp", enabled: true, prompt: "x" });
    assert.equal(await store.deleteAgentJob("tmp"), true);
    assert.equal(await store.getAgentJob("tmp"), null);
    assert.equal(await store.deleteAgentJob("tmp"), false);
  });
});

describe("agent run history", () => {
  test("records runs and lists them newest-first", async () => {
    await store.recordAgentRun({
      jobId: "hist", startedAt: "2026-06-16T10:00:00.000Z", finishedAt: "2026-06-16T10:00:01.000Z",
      durationMs: 1000, verdict: "ok", mode: "steps", trigger: "manual", tools: ["recall"], answer: "done",
    });
    await store.recordAgentRun({
      jobId: "hist", startedAt: "2026-06-16T11:00:00.000Z", finishedAt: "2026-06-16T11:00:02.000Z",
      durationMs: 2000, verdict: "error", mode: "steps", trigger: "interval", error: "boom",
    });

    const runs = await store.listAgentRuns("hist");
    assert.equal(runs.length, 2);
    assert.equal(runs[0].verdict, "error");      // newest first
    assert.equal(runs[1].verdict, "ok");
    assert.deepEqual(runs[1].tools, ["recall"]);  // JSON round-trips to an array
  });

  test("limit caps the number of rows returned", async () => {
    const runs = await store.listAgentRuns("hist", 1);
    assert.equal(runs.length, 1);
  });

  test("returns [] for a job with no runs", async () => {
    assert.deepEqual(await store.listAgentRuns("never-ran"), []);
  });

  test("deleteAgentRun removes one run and reports hit/miss", async () => {
    await store.recordAgentRun({
      jobId: "del", startedAt: "2026-06-16T10:00:00.000Z", verdict: "ok", mode: "steps",
    });
    const [run] = await store.listAgentRuns("del");
    assert.equal(await store.deleteAgentRun(run.id), true);
    assert.deepEqual(await store.listAgentRuns("del"), []);
    assert.equal(await store.deleteAgentRun(run.id), false); // already gone
  });

  test("pruneAgentRuns removes runs older than the retention window", async () => {
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    const recent = new Date(Date.now() - 2 * 86400000).toISOString();
    await store.recordAgentRun({ jobId: "gc", startedAt: old,    verdict: "ok", mode: "steps" });
    await store.recordAgentRun({ jobId: "gc", startedAt: recent, verdict: "ok", mode: "steps" });

    const removed = await store.pruneAgentRuns(30);
    assert.equal(removed, 1);
    const left = await store.listAgentRuns("gc");
    assert.equal(left.length, 1);
    assert.equal(left[0].started_at, recent);
  });
});
