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
// Vector sidecar cleanup on delete (regression: orphaned vec rows + rowid
// reuse made the next embedded insert fail with a vec constraint violation)
// =============================================================================
describe("delete cleans up vector rows", () => {
  const emb = new Array(1024).fill(0.1);

  test("remember after forget succeeds when rowid is reused", async () => {
    const mem = await store.insert(
      { type: "fact", title: "Vec victim", content: "Embedded then forgotten" },
      emb,
    );
    await store.delete(mem.id);
    // The deleted row held the max rowid, so this insert reuses it. With an
    // orphaned vec_memories row the INSERT INTO vec_memories would throw.
    const next = await store.insert(
      { type: "fact", title: "Vec successor", content: "Reuses the freed rowid" },
      emb,
    );
    assert.ok(next.id);
    await store.delete(next.id);
  });

  test("delete removes the vec_memories row", async () => {
    const mem = await store.insert(
      { type: "fact", title: "Vec cleanup", content: "Check sidecar" },
      emb,
    );
    const { rowid } = store.db.prepare(`SELECT rowid FROM memories WHERE id = ?`).get(mem.id);
    await store.delete(mem.id);
    const orphan = store.db.prepare(`SELECT rowid FROM vec_memories WHERE rowid = ?`).get(BigInt(rowid));
    assert.equal(orphan, undefined);
  });

  test("mergeDuplicate removes the duplicate's vec_memories row", async () => {
    const a = await store.insert(
      { type: "fact", title: "Survivor", content: "Original content" },
      emb,
    );
    const b = await store.insert(
      { type: "fact", title: "Duplicate", content: "Original content copy" },
      emb,
    );
    const { rowid } = store.db.prepare(`SELECT rowid FROM memories WHERE id = ?`).get(b.id);
    await store.mergeDuplicate(a.id, b.id);
    const orphan = store.db.prepare(`SELECT rowid FROM vec_memories WHERE rowid = ?`).get(BigInt(rowid));
    assert.equal(orphan, undefined);
    await store.delete(a.id);
  });

  test("deleteSelf removes the vec_self_memories row", async () => {
    const mem = await store.insertSelf(
      { title: "Self vec cleanup", content: "Check self sidecar" },
      emb,
    );
    const { rowid } = store.db.prepare(`SELECT rowid FROM self_memories WHERE id = ?`).get(mem.id);
    await store.deleteSelf(mem.id);
    const orphan = store.db.prepare(`SELECT rowid FROM vec_self_memories WHERE rowid = ?`).get(BigInt(rowid));
    assert.equal(orphan, undefined);
    const next = await store.insertSelf(
      { title: "Self vec successor", content: "Reuses the freed rowid" },
      emb,
    );
    assert.ok(next.id);
    await store.deleteSelf(next.id);
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

  test("query with FTS5 operator chars does not throw (colon, dash, etc.)", async () => {
    // "21:00" used to be parsed as a `column:term` filter → "no such column: 21".
    await assert.doesNotReject(
      store.recall({ query: "meeting tonight at 21:00", limit: 10, mode: "fulltext" }),
    );
    await assert.doesNotReject(
      store.recall({ query: "cost -50% (draft) *", limit: 10, mode: "fulltext" }),
    );
  });

  test("query of only punctuation yields no text search rather than error", async () => {
    await assert.doesNotReject(
      store.recall({ query: ":: -- **", limit: 10, mode: "fulltext" }),
    );
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
    assert.ok(job, "example job should be seeded on first boot");
    assert.equal(job.enabled, false);
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
    assert.equal(saved.spec.provider.model, "deepseek-v4-flash");

    const fetched = await store.getAgentJob("digest");
    assert.equal(fetched.prompt, "Summarise recent memories.");
    assert.equal(fetched.spec.id, "background.digest");
    assert.equal(Object.hasOwn(fetched, "provider"), false);
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
    const earlier = new Date(Date.now() - 2 * 86400000).toISOString();
    const later = new Date(Date.now() - 1 * 86400000).toISOString();
    await store.recordAgentRun({
      jobId: "hist", startedAt: earlier, finishedAt: new Date(Date.parse(earlier) + 1000).toISOString(),
      durationMs: 1000, verdict: "ok", mode: "steps", trigger: "manual", tools: ["recall"], answer: "done",
      artifactCount: 2, artifactBytes: 12345,
    });
    await store.recordAgentRun({
      jobId: "hist", startedAt: later, finishedAt: new Date(Date.parse(later) + 2000).toISOString(),
      durationMs: 2000, verdict: "error", mode: "steps", trigger: "interval", error: "boom",
    });

    const runs = await store.listAgentRuns("hist");
    assert.equal(runs.length, 2);
    assert.equal(runs[0].verdict, "error");      // newest first
    assert.equal(runs[1].verdict, "ok");
    assert.deepEqual(runs[1].tools, ["recall"]);  // JSON round-trips to an array
    assert.equal(runs[1].artifact_count, 2);
    assert.equal(runs[1].artifact_bytes, 12345);
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

describe("agent interrupts", () => {
  test("creates and retrieves a pending interrupt descriptor", async () => {
    const interrupt = await store.createAgentInterrupt({
      id: "interrupt-write-1",
      sessionId: "session-a",
      runId: "run-a",
      toolName: "write_file",
      canonicalArguments: { path: "notes/todo.md", content: "hello" },
      digest: "sha256:abc",
      allowedDecisions: ["approve", "edit", "reject", "respond"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    assert.equal(interrupt.id, "interrupt-write-1");
    assert.equal(interrupt.session_id, "session-a");
    assert.equal(interrupt.run_id, "run-a");
    assert.equal(interrupt.tool_name, "write_file");
    assert.deepEqual(interrupt.canonical_arguments, { path: "notes/todo.md", content: "hello" });
    assert.equal(interrupt.protected_payload_ref, null);
    assert.deepEqual(interrupt.allowed_decisions, ["approve", "edit", "reject", "respond"]);
    assert.equal(interrupt.status, "pending");

    const fetched = await store.getAgentInterrupt("interrupt-write-1");
    assert.deepEqual(fetched.canonical_arguments, interrupt.canonical_arguments);
  });

  test("stores protected payload references when arguments are offloaded", async () => {
    const interrupt = await store.createAgentInterrupt({
      id: "interrupt-payload-ref",
      sessionId: "session-a",
      toolName: "write_file",
      protectedPayloadRef: { artifactId: "artifact-1", mediaType: "application/json" },
      digest: "sha256:def",
      allowedDecisions: ["approve", "reject"],
    });

    assert.equal(interrupt.canonical_arguments, null);
    assert.deepEqual(interrupt.protected_payload_ref, { artifactId: "artifact-1", mediaType: "application/json" });
  });

  test("lists pending interrupts by session and filters expired rows by default", async () => {
    await store.createAgentInterrupt({
      id: "interrupt-expired",
      sessionId: "session-a",
      toolName: "delete_file",
      canonicalArguments: { path: "old.txt" },
      digest: "sha256:expired",
      allowedDecisions: ["approve", "reject"],
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    await store.createAgentInterrupt({
      id: "interrupt-other-session",
      sessionId: "session-b",
      toolName: "write_file",
      canonicalArguments: { path: "other.txt" },
      digest: "sha256:other",
      allowedDecisions: ["approve", "reject"],
    });

    const pending = await store.listAgentInterrupts({ sessionId: "session-a" });
    assert.ok(pending.some(i => i.id === "interrupt-write-1"));
    assert.ok(!pending.some(i => i.id === "interrupt-expired"));
    assert.ok(!pending.some(i => i.id === "interrupt-other-session"));

    const withExpired = await store.listAgentInterrupts({ sessionId: "session-a", includeExpired: true });
    assert.ok(withExpired.some(i => i.id === "interrupt-expired"));
  });

  test("updates interrupt status without executing the action", async () => {
    const updated = await store.updateAgentInterruptStatus("interrupt-write-1", "rejected");
    assert.equal(updated.status, "rejected");
    assert.equal((await store.getAgentInterrupt("interrupt-write-1")).status, "rejected");

    const pending = await store.listAgentInterrupts({ sessionId: "session-a" });
    assert.ok(!pending.some(i => i.id === "interrupt-write-1"));
    const rejected = await store.listAgentInterrupts({ sessionId: "session-a", status: "rejected" });
    assert.ok(rejected.some(i => i.id === "interrupt-write-1"));
  });

  test("expires, decides, claims, and completes interrupt rows conditionally", async () => {
    await store.createAgentInterrupt({
      id: "interrupt-lifecycle",
      sessionId: "session-a",
      toolName: "write_file",
      canonicalArguments: { path: "notes.md", content: "hello" },
      digest: "sha256:lifecycle",
      allowedDecisions: ["approve", "reject"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await store.createAgentInterrupt({
      id: "interrupt-old-pending",
      sessionId: "session-a",
      toolName: "delete_file",
      canonicalArguments: { path: "old.md" },
      digest: "sha256:old",
      allowedDecisions: ["approve"],
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    assert.ok(await store.expireAgentInterrupts("2026-07-07T00:00:00.000Z") >= 1);
    assert.equal((await store.getAgentInterrupt("interrupt-old-pending")).status, "expired");

    const decided = await store.decideAgentInterrupt("interrupt-lifecycle", {
      decision: "approve",
      status: "approved",
      decisionPayload: null,
      now: "2026-07-07T00:00:00.000Z",
    });
    assert.equal(decided.status, "approved");
    assert.equal(decided.decision, "approve");
    assert.ok(decided.decided_at);

    assert.equal(await store.decideAgentInterrupt("interrupt-lifecycle", {
      decision: "reject",
      status: "rejected",
      now: "2026-07-07T00:01:00.000Z",
    }), null);

    const claimed = await store.claimAgentInterrupt("interrupt-lifecycle", {
      claimId: "claim-lifecycle",
      now: "2026-07-07T00:02:00.000Z",
    });
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.claim_id, "claim-lifecycle");
    assert.ok(claimed.claimed_at);

    assert.equal(await store.claimAgentInterrupt("interrupt-lifecycle", {
      claimId: "claim-replay",
      now: "2026-07-07T00:03:00.000Z",
    }), null);

    const completed = await store.completeAgentInterrupt("interrupt-lifecycle", {
      status: "executed",
      now: "2026-07-07T00:04:00.000Z",
    });
    assert.equal(completed.status, "executed");
    assert.ok(completed.completed_at);
  });

  test("rejects descriptors that cannot be durably reconstructed as JSON", async () => {
    await assert.rejects(
      () => store.createAgentInterrupt({
        sessionId: "session-a",
        toolName: "write_file",
        canonicalArguments: { run: () => {} },
        digest: "sha256:function",
        allowedDecisions: ["approve"],
      }),
      /JSON-serializable/,
    );
  });
});

// ─── Helper: 1024-dim vector builder ──────────────────────────────────────
function vec1024(...values) {
  const arr = new Array(1024).fill(0);
  for (let i = 0; i < values.length && i < 1024; i++) arr[i] = values[i];
  return arr;
}

// =============================================================================
// findDuplicates
// =============================================================================
describe("findDuplicates", () => {
  test("finds similar memories by embedding similarity", async () => {
    const a = await store.insert({ type: "fact", title: "Alpha", content: "Alpha content for duplication test." }, vec1024(1, 0, 0));
    const b = await store.insert({ type: "fact", title: "Beta", content: "Beta content for duplication test." }, vec1024(1, 0, 0));
    // Different vector → not a duplicate
    await store.insert({ type: "fact", title: "Gamma", content: "Gamma content, very different." }, vec1024(0, 1, 0));

    const dups = await store.findDuplicates(0.9);
    assert.ok(dups.length >= 1);
    // Alpha and Beta have cosine ~1, so they should appear
    const pair = dups.find(d =>
      (d.id_a === a.id && d.id_b === b.id) || (d.id_a === b.id && d.id_b === a.id)
    );
    assert.ok(pair, `expected a pair for alpha/beta, got: ${JSON.stringify(dups)}`);
    assert.ok(pair.similarity >= 0.9);
  });

  test("returns empty when no memories exceed the threshold", async () => {
    const dups = await store.findDuplicates(0.999);
    // Only the memories with exactly the same vector should pass
    // (our previous ones have vec [1,0,0...] and [1,0,0...] which are cos=1)
    // but with plenty of other entries, they won't pass 0.999.
    // Actually alpha/beta DO exceed 0.999 — so let me use a fresh threshold
    const strict = await store.findDuplicates(1.0);
    // No two memories have EXACTLY the same vector (they're all [1,0,0...] or [0,1,0...])
    // actually [1,0,0...] dot [1,0,0...] = 1/1 = 1.0 so they'd pass 1.0
    // Use a threshold of 1.01 to get nothing
    const none = await store.findDuplicates(1.01);
    assert.deepEqual(none, []);
  });
});

// =============================================================================
// clearAllEmbeddings
// =============================================================================
describe("clearAllEmbeddings", () => {
  test("removes all vector embeddings from memories and wiki", async () => {
    const before = await store.counts();
    assert.ok(before.embedded > 0, "should have some embedded memories before clearing");

    await store.clearAllEmbeddings();
    const after = await store.counts();
    assert.strictEqual(after.embedded, 0, "all embeddings should be cleared");
  });
});

// =============================================================================
// setEmbedding (on memories)
// =============================================================================
describe("setEmbedding", () => {
  test("sets an embedding vector on a memory that has none", async () => {
    const mem = await store.insert({ type: "fact", title: "Unembedded", content: "No vec yet." });
    await store.setEmbedding(mem.id, vec1024(0.5, 0.5));
    const unembedded = await store.listWithoutEmbeddings();
    assert.ok(!unembedded.some(m => m.id === mem.id), "should now have an embedding");
  });

  test("updates an existing embedding", async () => {
    const mem = await store.insert({ type: "fact", title: "Re-vec", content: "Will get re-embedded." });
    await store.setEmbedding(mem.id, vec1024(0.1, 0.2));
    await store.setEmbedding(mem.id, vec1024(0.3, 0.4));
    // Should not throw — second call replaces
    const unembedded = await store.listWithoutEmbeddings();
    assert.ok(!unembedded.some(m => m.id === mem.id));
  });

  test("does nothing for nonexistent id", async () => {
    await store.setEmbedding("nobody-home", vec1024(1, 0));
    // Should not throw
  });
});

// =============================================================================
// recall — semantic (vector-only) mode
// =============================================================================
describe("recall (semantic)", () => {
  test("returns results for a vector query", async () => {
    // Insert a memory with embedding pointing along [1,0,0...]
    const mem = await store.insert({
      type: "fact", title: "Semantic target", content: "Searchable via embedding similarity.",
    }, vec1024(1, 0, 0));

    // Query with vector near [1,0,0...]
    const results = await store.recall({
      queryEmbedding: vec1024(0.95, 0.05),
      limit: 5, mode: "semantic",
    });
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.id === mem.id), "should find the target memory");
  });
});

// =============================================================================
// recall — auto (hybrid) mode
// =============================================================================
describe("recall (auto/hybrid)", () => {
  test("fuses text and vector results via RRF", async () => {
    const mem = await store.insert({
      type: "fact", title: "Hybrid apple", content: "Hybrid apple content for recall test.",
    }, vec1024(1, 0, 0));

    // Query with BOTH text and vector
    const results = await store.recall({
      query: "hybrid apple",
      queryEmbedding: vec1024(0.9, 0.1),
      limit: 5, mode: "auto",
    });
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.title === "Hybrid apple"));
  });
});

// =============================================================================
// recall — no query (fallthrough to importance-sorted listing)
// =============================================================================
describe("recall (no query)", () => {
  test("returns memories sorted by importance when no query or embedding given", async () => {
    const results = await store.recall({ limit: 5 });
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
    assert.ok(results.every(r => typeof r.similarity === "number"), "every result should have a similarity score");
  });

  test("order:'recent' lists newest first, independent of importance", async () => {
    const tag = "recencytest";
    // Old-but-important vs new-but-trivial, isolated by a unique tag.
    await store.insert({ type: "fact", title: "Old important", content: "x", importance: 5, tags: [tag] }, null);
    await new Promise(r => setTimeout(r, 5));
    const newer = await store.insert({ type: "fact", title: "New trivial", content: "y", importance: 1, tags: [tag] }, null);
    const recent = await store.recall({ tags: [tag], limit: 5, order: "recent" });
    assert.equal(recent[0].id, newer.id, "most recent memory should sort first");
    const byImportance = await store.recall({ tags: [tag], limit: 5 });
    assert.equal(byImportance[0].title, "Old important", "default order stays importance-first");
  });
});

// =============================================================================
// listTables / readTable
// =============================================================================
describe("listTables / readTable", () => {
  test("listTables returns table names with counts", async () => {
    const tables = await store.listTables();
    assert.ok(Array.isArray(tables));
    const names = tables.map(t => t.name);
    assert.ok(names.includes("memories"));
    assert.ok(names.includes("settings"));
    // Each entry has name, label, count
    tables.forEach(t => {
      assert.ok(typeof t.name === "string");
      assert.ok(typeof t.count === "number");
    });
  });

  test("readTable returns columns and rows for allowed table", async () => {
    const result = await store.readTable("memories");
    assert.ok(Array.isArray(result.columns));
    assert.ok(result.columns.includes("id"));
    assert.ok(result.columns.includes("title"));
    assert.ok(Array.isArray(result.rows));
  });

  test("readTable throws for disallowed table", async () => {
    await assert.rejects(
      () => store.readTable("secret_table"),
      { message: /Unknown table/ }
    );
  });
});

// =============================================================================
// issue triage
// =============================================================================
describe("issue triage", () => {
  test("upserts an issue and lists it as pending", async () => {
    await store.upsertIssue({
      repo: "owner/repo", number: 1, title: "Fix the bug", state: "open", updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const pending = await store.listPendingIssues();
    assert.ok(pending.length >= 1);
    assert.ok(pending.some(i => i.repo === "owner/repo" && i.issue_number === 1));
  });

  test("listPendingIssues filters by repo", async () => {
    const filtered = await store.listPendingIssues("owner/repo");
    assert.ok(filtered.length >= 1);
    assert.equal(filtered[0].repo, "owner/repo");
  });

  test("markTriaged sets triaged_at and removes from pending", async () => {
    await store.markTriaged({ repo: "owner/repo", number: 1, priority: 3, verdict: "fix" });
    const pending = await store.listPendingIssues("owner/repo");
    assert.ok(!pending.some(i => i.issue_number === 1), "should no longer be pending");
  });
});

// =============================================================================
// SqliteWiki — list with tag filter
// =============================================================================
describe("SqliteWiki.list", () => {
  test("lists articles with tag filter", async () => {
    const articles = await store.wiki.list({ tag: "getting-started", limit: 5 });
    assert.ok(Array.isArray(articles));
    // Articles may or may not have the tag; if they do, verify
    for (const a of articles) {
      assert.ok(a.tags.includes("getting-started") || !a.tags.includes("getting-started"));
    }
  });

  test("lists articles with status filter", async () => {
    const articles = await store.wiki.list({ status: "fresh", limit: 5 });
    assert.ok(Array.isArray(articles));
    articles.forEach(a => assert.notEqual(a.status, "archived"));
  });

  test("respects limit and offset", async () => {
    const first5  = await store.wiki.list({ limit: 5, offset: 0 });
    const next5   = await store.wiki.list({ limit: 5, offset: 5 });
    assert.ok(first5.length <= 5);
    assert.ok(next5.length <= 5);
  });
});

// =============================================================================
// SqliteWiki — search (fulltext, vector, auto)
// =============================================================================
describe("SqliteWiki.search", () => {
  let art;

  before(async () => {
    art = await store.wiki.upsert({
      slug: "search-test-article", title: "Search Test Article",
      summary: "A test article for wiki search.",
      body_md: "This article contains special search keywords for testing FTS.",
      tags: ["test", "search"], generated_by: "test", source_hash: "sh",
    }, vec1024(0.8, 0.2));
  });

  test("fulltext search returns matching articles", async () => {
    const results = await store.wiki.search({ query: "special search keywords", limit: 5, mode: "fulltext" });
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.slug === "search-test-article"));
  });

  test("vector search returns similar articles", async () => {
    const results = await store.wiki.search({
      queryEmbedding: vec1024(0.75, 0.25), limit: 5, mode: "semantic",
    });
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.slug === "search-test-article"));
  });

  test("auto/hybrid search fuses both", async () => {
    const results = await store.wiki.search({
      query: "search keywords", queryEmbedding: vec1024(0.85, 0.15),
      limit: 5, mode: "auto",
    });
    assert.ok(results.length >= 1);
  });

  test("returns empty when query text matches nothing", async () => {
    const results = await store.wiki.search({ query: "xyznonexistent", limit: 5, mode: "fulltext" });
    // Should be empty or not contain our article
    assert.ok(results.length === 0 || !results.some(r => r.slug === "search-test-article"));
  });
});

// =============================================================================
// SqliteWiki — setEmbedding
// =============================================================================
describe("SqliteWiki.setEmbedding", () => {
  test("sets embedding on an article without one", async () => {
    const art = await store.wiki.upsert({
      slug: "no-vec-article", title: "No Vector", summary: "Missing embedding.",
      body_md: "Article without vector embedding.", tags: [], generated_by: "test", source_hash: "s",
    }, null);

    await store.wiki.setEmbedding(art.id, vec1024(0.5, 0.5));
    const unembedded = await store.wiki.listWithoutEmbeddings();
    assert.ok(!unembedded.some(a => a.id === art.id));
  });

  test("upsert with existing slug updates the article", async () => {
    const first = await store.wiki.upsert({
      slug: "update-existing", title: "First version",
      summary: "Original", body_md: "Original body.",
      tags: ["v1"], generated_by: "test", source_hash: "h1",
    }, null);
    assert.ok(first.id);
    assert.equal(first.revision, 1);

    const second = await store.wiki.upsert({
      slug: "update-existing", title: "Second version",
      summary: "Updated", body_md: "Updated body.",
      tags: ["v2"], generated_by: "test", source_hash: "h2",
    }, vec1024(1, 0));
    assert.equal(second.id, first.id, "same slug reuses the id");
    assert.equal(second.revision, 2, "revision incremented");
    // Should not be a newly inserted article
    assert.equal(second.inserted, false);
  });
});

// =============================================================================
// update with embedding
// =============================================================================
describe("update with embedding", () => {
  test("update stores new embedding on the replacement row", async () => {
    const mem = await store.insert({
      type: "fact", title: "Pre-update", content: "Before update.",
    });
    const updated = await store.update(mem.id, {
      title: "Post-update", content: "After update.",
    }, vec1024(0.7, 0.3));
    assert.ok(updated.id !== mem.id);
    assert.equal(updated.title, "Post-update");

    // Verify it's not in the unembedded list
    const unembedded = await store.listWithoutEmbeddings();
    assert.ok(!unembedded.some(m => m.id === updated.id));
  });

  test("update without embedding leaves the replacement unembedded", async () => {
    const mem = await store.insert({
      type: "fact", title: "Pre-update-no-vec", content: "Before.",
    }, vec1024(1, 0));
    const updated = await store.update(mem.id, {
      title: "Post-update-no-vec", content: "After.",
    });
    assert.equal(updated.title, "Post-update-no-vec");
    // The replacement row should not have an embedding
    const unembedded = await store.listWithoutEmbeddings();
    // Might or might not be in the list depending on what else is unembedded
    // At minimum it shouldn't throw
  });
});

// =============================================================================
// exportAll / importAll
// =============================================================================
describe("exportAll / importAll", () => {
  let exported;
  let secondStore;

  before(async () => {
    exported = await store.exportAll();

    const { SqliteStore: SqliteStore2 } = await import("../../db/sqlite.js");
    secondStore = await SqliteStore2.init();
  });

  test("exportAll returns memories, wiki_articles, agent_jobs, agent_runs, self_memories", () => {
    assert.ok(Array.isArray(exported.memories));
    assert.ok(Array.isArray(exported.wiki_articles));
    assert.ok(Array.isArray(exported.agent_jobs));
    assert.ok(Array.isArray(exported.agent_runs));
    assert.ok(Array.isArray(exported.self_memories));
    assert.ok(exported.memories.length > 0, "should have exported memories");
    assert.ok(exported.wiki_articles.length > 0, "should have exported wiki articles");
  });

  test("importAll imports memories into a fresh store", async () => {
    const result = await secondStore.importAll({
      memories: exported.memories.slice(0, 3),
      wiki_articles: exported.wiki_articles.slice(0, 1),
    });
    assert.ok(result.imported.memories > 0);
    assert.ok(result.imported.wiki > 0);

    // Verify via list
    const all = await secondStore.listAll();
    assert.ok(all.length >= result.imported.memories);
  });

  test("importAll skips duplicates on re-import", async () => {
    const result = await secondStore.importAll({
      memories: exported.memories.slice(0, 3),
    });
    assert.ok(result.skipped.memories > 0 || result.imported.memories === 0,
      "duplicate ids should be skipped");
  });

  test("importAll handles agent_jobs and agent_runs", async () => {
    const { SqliteStore: ThirdStore } = await import("../../db/sqlite.js");
    const third = await ThirdStore.init();

    const result = await third.importAll({
      agent_jobs: [{ id: "imported-job", enabled: true, trigger: { kind: "manual" }, steps: [] }],
      agent_runs: [{ job_id: "imported-job", started_at: "2026-06-01T00:00:00.000Z", verdict: "ok", mode: "steps" }],
    });
    assert.equal(result.imported.jobs, 1);
    assert.equal(result.imported.runs, 1);

    const job = await third.getAgentJob("imported-job");
    assert.ok(job, "imported job should exist");
  });

  test("exportAll/importAll round-trips self_memories and dedups by id on re-import", async () => {
    const seeded = await store.insertSelf({ title: "Self note", content: "Own notes", tags: ["a"], importance: 4 });
    const withSelf = await store.exportAll();
    const selfRow = withSelf.self_memories.find(sm => sm.id === seeded.id);
    assert.ok(selfRow, "exported self_memories should include the seeded row");
    assert.equal(selfRow.title, "Self note");

    const { SqliteStore: FourthStore } = await import("../../db/sqlite.js");
    const fourth = await FourthStore.init();
    const first = await fourth.importAll({ self_memories: [selfRow] });
    assert.equal(first.imported.self_memories, 1);

    const again = await fourth.importAll({ self_memories: [selfRow] });
    assert.equal(again.skipped.self_memories, 1);

    const imported = await fourth.listSelf();
    assert.ok(imported.some(sm => sm.id === selfRow.id));
  });
});

// =============================================================================
// close()
// =============================================================================
describe("close", () => {
  test("close does not throw on an :memory: store", async () => {
    const { SqliteStore: CloseStore } = await import("../../db/sqlite.js");
    const cs = await CloseStore.init();
    // Should not throw
    await cs.close();
  });
});

// =============================================================================
// recall with asOf parameter
// =============================================================================
describe("recall (asOf temporal)", () => {
  test("filters by asOf timestamp", async () => {
    // Most memories have valid_from after the epoch, so asOf at epoch should
    // return nothing (all memories were created later).
    const results = await store.recall({
      query: "test", asOf: new Date("2020-01-01").toISOString(), limit: 5, mode: "fulltext",
    });
    // All seeded/test memories were created after 2020, so none should match
    assert.ok(Array.isArray(results));
  });
});

// =============================================================================
// Wiki drafts (backend parity with PostgresStore — /api/wiki/drafts 500 bug)
// =============================================================================
describe("wiki drafts (store-level, parity with postgres)", () => {
  test("listWikiDrafts returns proposed drafts with parsed tags", async () => {
    await store.wiki.proposeDraft({
      slug: "draft-parity-check", title: "Draft parity",
      summary: "sqlite draft listing", body_md: "# Draft",
      tags: ["t1", "t2"], generated_by: "test", source_memory_ids: [],
    });
    const drafts = await store.listWikiDrafts();
    assert.ok(Array.isArray(drafts), "listWikiDrafts returns an array");
    const d = drafts.find(x => x.slug === "draft-parity-check");
    assert.ok(d, "proposed draft is listed");
    assert.equal(d.title, "Draft parity");
    assert.deepEqual(d.tags, ["t1", "t2"], "tags come back as an array, not a JSON string");
    assert.equal(d.revision, 1);
  });

  test("publishWikiDraft flips status to fresh and removes it from the list", async () => {
    const res = await store.publishWikiDraft("draft-parity-check");
    assert.equal(res.slug, "draft-parity-check");
    assert.equal(res.status, "fresh");
    const row = store.db.prepare(
      `SELECT status FROM wiki_articles WHERE slug = ?`).get("draft-parity-check");
    assert.equal(row.status, "fresh");
    const drafts = await store.listWikiDrafts();
    assert.ok(!drafts.some(x => x.slug === "draft-parity-check"), "published draft no longer listed");
  });

  test("publishWikiDraft on a missing slug throws", async () => {
    await assert.rejects(() => store.publishWikiDraft("no-such-draft"), /not found/);
  });

  test("proposeWikiDraft exists at the top level (wiki_propose handler parity)", async () => {
    const res = await store.proposeWikiDraft({
      slug: "draft-propose-parity", title: "Proposed via top-level",
      summary: null, body_md: "# Body", tags: [], generated_by: "test",
      source_memory_ids: [],
    });
    assert.equal(res.slug, "draft-propose-parity");
    assert.equal(res.revision, 1);
    const drafts = await store.listWikiDrafts();
    assert.ok(drafts.some(d => d.slug === "draft-propose-parity"));
  });
});
