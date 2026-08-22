// Tests for shutdown.js — createGracefulShutdown
//
// Factory function with ALL dependencies injected via options object.
// No filesystem, no real servers, no real processes. Timers and
// process.exit are mocked.

import { describe, test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Timer / process mocks ───────────────────────────────────────────────────

let exitCode = null;
let capturedForceExitTimer = null;

mock.method(process, "exit", (code) => { exitCode = code; throw new Error("process.exit"); });
mock.method(globalThis, "setTimeout", (fn, ms) => {
  capturedForceExitTimer = { fn, ms, unref: mock.fn(() => {}) };
  return capturedForceExitTimer;
});

// ─── Import SUT ───────────────────────────────────────────────────────────────

import logger from "../../../lib/helpers/logger.js";

// logger.end is called in the shutdown sequence (wins ago). Mock it globally
// so the Promise.resolve pattern in shutdown.js doesn't hang.
mock.method(logger, "end", (cb) => cb?.());

let createGracefulShutdown;

before(async () => {
  const mod = await import("../../../lib/server/shutdown.js");
  createGracefulShutdown = mod.createGracefulShutdown;
});

after(() => {
  mock.restoreAll();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Build a default set of deps with mock.fn() for every callable. */
function mockDeps(overrides = {}) {
  return {
    markShuttingDown:    mock.fn(),
    watchdog:            { stop: mock.fn() },
    dedup:               { stop: mock.fn() },
    infer:               { stop: mock.fn() },
    pruner:              { stop: mock.fn() },
    logPruner:           { stop: mock.fn() },
    runPruner:           { stop: mock.fn() },
    scheduler:           { stop: mock.fn() },
    shutdownEmbeddings:  mock.fn(async () => {}),
    disposeEmbeddings:   mock.fn(async () => {}),
    stopLlamaCpp:        mock.fn(async () => {}),
    watcherRegistry:     { stopAll: mock.fn(async () => {}) },
    apiRoutes:           { dispose: mock.fn() },
    codegraphBoot:       Promise.resolve(),
    docgraphBoot:        Promise.resolve(),
    wss:                 { clients: new Set(), close: mock.fn(cb => cb()) },
    httpServer:          { closeAllConnections: mock.fn(), close: mock.fn(cb => cb()) },
    store:               { close: mock.fn(async () => {}) },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createGracefulShutdown
// ═══════════════════════════════════════════════════════════════════════════════

describe("createGracefulShutdown", () => {
  let deps;

  beforeEach(() => {
    deps = mockDeps();
    exitCode = null;
    capturedForceExitTimer = null;
  });

  // ─── Shape ───────────────────────────────────────────────────────────────

  test("returns a function", () => {
    const shutdown = createGracefulShutdown(deps);
    assert.strictEqual(typeof shutdown, "function");
  });

  test("returned function is async", () => {
    const shutdown = createGracefulShutdown(deps);
    const result = shutdown();
    assert.ok(result instanceof Promise);
  });

  // ─── Single call — graceful shutdown ───────────────────────────────────────

  test("calls markShuttingDown once", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(deps.markShuttingDown.mock.callCount(), 1);
  });

  test("stops all workers", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(deps.watchdog.stop.mock.callCount(), 1);
    assert.strictEqual(deps.dedup.stop.mock.callCount(), 1);
    assert.strictEqual(deps.infer.stop.mock.callCount(), 1);
    assert.strictEqual(deps.pruner.stop.mock.callCount(), 1);
    assert.strictEqual(deps.logPruner.stop.mock.callCount(), 1);
    assert.strictEqual(deps.runPruner.stop.mock.callCount(), 1);
    assert.strictEqual(deps.scheduler.stop.mock.callCount(), 1);
  });

  test("disposes apiRoutes", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(deps.apiRoutes.dispose.mock.callCount(), 1);
  });

  test("awaits codegraphBoot and docgraphBoot with timeout", async () => {
    let cgResolved = false;
    let dgResolved = false;
    deps.codegraphBoot = new Promise(r => { cgResolved = true; r(); });
    deps.docgraphBoot  = new Promise(r => { dgResolved = true; r(); });

    const shutdown = createGracefulShutdown(deps);
    await shutdown();

    assert.strictEqual(cgResolved, true);
    assert.strictEqual(dgResolved, true);
  });

  test("awaits docgraphBoot only when present", async () => {
    let called = false;
    deps.docgraphBoot = undefined; // absent
    deps.codegraphBoot = new Promise(r => { called = true; r(); });

    const shutdown = createGracefulShutdown(deps);
    await shutdown();

    assert.strictEqual(called, true);
  });

  test("stops watcher registry", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(deps.watcherRegistry.stopAll.mock.callCount(), 1);
  });

  test("calls shutdownEmbeddings with 1500ms timeout", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(deps.shutdownEmbeddings.mock.callCount(), 1);
    assert.strictEqual(deps.shutdownEmbeddings.mock.calls[0].arguments[0], 1500);
  });

  test("terminates all WS clients", async () => {
    const clients = [
      { terminate: mock.fn() },
      { terminate: mock.fn() },
    ];
    deps.wss.clients = new Set(clients);

    const shutdown = createGracefulShutdown(deps);
    await shutdown();

    assert.strictEqual(clients[0].terminate.mock.callCount(), 1);
    assert.strictEqual(clients[1].terminate.mock.callCount(), 1);
  });

  test("closes the WebSocket server", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(deps.wss.close.mock.callCount(), 1);
  });

  test("closes all HTTP connections and the HTTP server", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(deps.httpServer.closeAllConnections.mock.callCount(), 1);
    assert.strictEqual(deps.httpServer.close.mock.callCount(), 1);
  });

  test("stops llama.cpp", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(deps.stopLlamaCpp.mock.callCount(), 1);
  });

  test("disposes embeddings", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(deps.disposeEmbeddings.mock.callCount(), 1);
  });

  test("closes the store", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(deps.store.close.mock.callCount(), 1);
  });

  test("calls logger.end", async () => {
    const before = logger.end.mock.callCount();
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(logger.end.mock.callCount() - before, 1);
  });

  test("sets a force-exit timer with 750ms delay", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.ok(capturedForceExitTimer);
    assert.strictEqual(capturedForceExitTimer.ms, 750);
  });

  test("force-exit timer is unref'd", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    assert.strictEqual(capturedForceExitTimer.unref.mock.callCount(), 1);
  });

  // ─── Second call — force exit ──────────────────────────────────────────────

  test("second call calls process.exit(130)", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();

    try { await shutdown(); } catch { /* process.exit mock throws */ }

    assert.strictEqual(exitCode, 130);
  });

  test("second call does not repeat shutdown sequence", async () => {
    const shutdown = createGracefulShutdown(deps);
    await shutdown();

    try { await shutdown(); } catch { /* process.exit mock throws */ }

    // Workers should not be stopped again
    assert.strictEqual(deps.watchdog.stop.mock.callCount(), 1);
    assert.strictEqual(deps.dedup.stop.mock.callCount(), 1);
  });

  // ─── Error resilience ──────────────────────────────────────────────────────

  test("stopLlamaCpp error does not prevent subsequent steps", async () => {
    deps.stopLlamaCpp = mock.fn(async () => { throw new Error("llama crash"); });
    const shutdown = createGracefulShutdown(deps);
    await shutdown();
    // disposeEmbeddings and store.close should still run
    assert.strictEqual(deps.disposeEmbeddings.mock.callCount(), 1);
    assert.strictEqual(deps.store.close.mock.callCount(), 1);
  });

  test("watcherRegistry stopAll error does not crash", async () => {
    deps.watcherRegistry.stopAll = mock.fn(async () => { throw new Error("watcher fail"); });
    const shutdown = createGracefulShutdown(deps);
    // Should not throw
    await assert.doesNotReject(async () => await shutdown());
    assert.strictEqual(deps.shutdownEmbeddings.mock.callCount(), 1);
  });

  test("store has no close method — graceful no-op", async () => {
    deps.store = {}; // no close method
    const shutdown = createGracefulShutdown(deps);
    await assert.doesNotReject(async () => await shutdown());
  });

  test("apiRoutes without dispose is a no-op", async () => {
    deps.apiRoutes = {}; // no dispose method
    const shutdown = createGracefulShutdown(deps);
    await assert.doesNotReject(async () => await shutdown());
  });
});
