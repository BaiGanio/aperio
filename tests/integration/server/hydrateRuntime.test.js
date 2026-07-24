// Tests for hydrateRuntime.js — DB/config hydration, allowlist load + codegraph
// repo sync, and embeddings init.
//
// Strategy: use a real in-memory SQLite store (:memory:) and disable embeddings
// (EMBEDDING_PROVIDER=none) so the full real module chain runs with no I/O
// side effects. This tests actual wiring, not mock behavior.
//
// Integration test: mock logger methods, provide env config, and let the real
// store/migration/embeddings modules execute against a throwaway DB.

import { describe, test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Env setup — must run before any module loads ─────────────────────────

before(() => {
  process.env.SQLITE_PATH        = ":memory:";
  process.env.EMBEDDING_PROVIDER = "none";
  // Keep the codegraph indexer quiet about backend selection
  process.env.DB_BACKEND         = "sqlite";
});

// ─── Logger — mock early so output stays clean ────────────────────────────

import logger from "../../../lib/helpers/logger.js";

before(() => {
  mock.method(logger, "info",  () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "error", () => {});
  mock.method(logger, "debug", () => {});
});

after(() => {
  mock.restoreAll();
  delete process.env.SQLITE_PATH;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.DB_BACKEND;
});

// ═══════════════════════════════════════════════════════════════════════════
// Import SUT
// ═══════════════════════════════════════════════════════════════════════════

let hydrateRuntime;

before(async () => {
  const mod = await import("../../../lib/server/hydrateRuntime.js");
  hydrateRuntime = mod.hydrateRuntime;
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("hydrateRuntime (in-memory SQLite)", () => {
  // The store singleton is cached — first call creates it, subsequent calls
  // return the same instance. Tests in this block share the store.

  // ─── Return shape ───────────────────────────────────────────────────────

  test("returns expected shape with all 8 fields", async () => {
    const result = await hydrateRuntime();

    assert.ok(result, "result is defined");
    // 1. store
    assert.ok(result.store, ".store — SqliteStore instance");
    assert.ok(typeof result.store.getSetting   === "function", ".store.getSetting");
    assert.ok(typeof result.store.setSetting   === "function", ".store.setSetting");
    assert.ok(typeof result.store.recall       === "function", ".store.recall");
    assert.ok(typeof result.store.close        === "function", ".store.close");
    // 2. generateEmbedding
    assert.ok(typeof result.generateEmbedding  === "function", ".generateEmbedding");
    // 3. disposeEmbeddings
    assert.ok(typeof result.disposeEmbeddings  === "function", ".disposeEmbeddings");
    // 4. shutdownEmbeddings
    assert.ok(typeof result.shutdownEmbeddings === "function", ".shutdownEmbeddings");
    // 5. getAllowlist
    assert.ok(typeof result.getAllowlist === "function", ".getAllowlist");
    const allowlist = result.getAllowlist();
    assert.ok(Array.isArray(allowlist), ".getAllowlist() returns array");
    // 6. watcherEvents
    assert.ok(result.watcherEvents, ".watcherEvents");
    assert.ok(typeof result.watcherEvents.on === "function", ".watcherEvents has EventEmitter API");
    assert.ok(typeof result.watcherEvents.emit === "function", ".watcherEvents has EventEmitter API");
    // 7. watcherRegistry
    assert.ok(result.watcherRegistry, ".watcherRegistry");
    assert.ok(typeof result.watcherRegistry.register === "function", ".watcherRegistry.register");
    assert.ok(typeof result.watcherRegistry.stopAll  === "function", ".watcherRegistry.stopAll");
    assert.ok(typeof result.watcherRegistry.has      === "function", ".watcherRegistry.has");
    // 8. folderIndexer
    assert.ok(result.folderIndexer, ".folderIndexer");
    assert.ok(typeof result.folderIndexer.start === "function", ".folderIndexer.start");
  });

  // ─── Store is a real SqliteStore ────────────────────────────────────────

  test("store is a real SqliteStore (has .db)", async () => {
    const result = await hydrateRuntime();
    // The real SqliteStore has a .db property (better-sqlite3 instance)
    assert.ok(result.store.db, ".store.db — better-sqlite3 Database");
    assert.ok(typeof result.store.db.prepare === "function", ".store.db.prepare");
  });

  // ─── getAllowlist returns the project base dir in the list ──────────────

  test("getAllowlist includes project root as floor path", async () => {
    const result = await hydrateRuntime();
    const paths = result.getAllowlist();
    // The hard floor in paths.js always includes process.cwd()
    assert.ok(paths.some(p => process.cwd().startsWith(p) || p.startsWith(process.cwd())),
      `allowlist ${JSON.stringify(paths)} includes cwd ${process.cwd()}`);
  });

  // ─── Watcher events ────────────────────────────────────────────────────

  test("watcherEvents can emit and listen to events", async () => {
    const result = await hydrateRuntime();
    const received = [];
    result.watcherEvents.on("test-event", (arg) => received.push(arg));
    result.watcherEvents.emit("test-event", "hello");
    assert.deepStrictEqual(received, ["hello"]);
  });

  // ─── Watcher registry — registration lifecycle ─────────────────────────

  test("watcherRegistry can register and check handles", async () => {
    const result = await hydrateRuntime();
    const handle = { stop: mock.fn(async () => {}) };
    await result.watcherRegistry.register("codegraph", "/tmp/test-root", handle);
    assert.ok(result.watcherRegistry.has("codegraph", "/tmp/test-root"));
    const stopped = await result.watcherRegistry.stop("codegraph", "/tmp/test-root");
    assert.strictEqual(stopped, true);
    assert.strictEqual(handle.stop.mock.callCount(), 1);
  });

  test("watcherRegistry.stopAll stops all registered handles", async () => {
    const result = await hydrateRuntime();
    const h1 = { stop: mock.fn(async () => {}) };
    const h2 = { stop: mock.fn(async () => {}) };
    await result.watcherRegistry.register("codegraph", "/r1", h1);
    await result.watcherRegistry.register("codegraph", "/r2", h2);
    await result.watcherRegistry.stopAll();
    assert.strictEqual(h1.stop.mock.callCount(), 1);
    assert.strictEqual(h2.stop.mock.callCount(), 1);
  });

  // ─── Folder indexer shape ──────────────────────────────────────────────

  test("folderIndexer has .start method for triggering index jobs", async () => {
    const result = await hydrateRuntime();
    assert.ok(typeof result.folderIndexer.start === "function", ".folderIndexer.start");
  });

  // ─── generateEmbedding function delegating to embeddings module ─────────

  test("generateEmbedding is a function (provider=none returns passthrough)", async () => {
    const result = await hydrateRuntime();
    // With EMBEDDING_PROVIDER=none, generateEmbedding returns null
    const emb = await result.generateEmbedding("test text");
    assert.strictEqual(emb, null);
  });

  // ─── shutdownEmbeddings works ───────────────────────────────────────────

  test("shutdownEmbeddings resolves without error", async () => {
    const result = await hydrateRuntime();
    await result.shutdownEmbeddings();
  });
});
