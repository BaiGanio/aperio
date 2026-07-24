import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "path";

// =============================================================================
// finishBootBeforeShutdown — coordinate teardown when boot is still in flight
// =============================================================================
describe("finishBootBeforeShutdown", () => {
  test("calls fullShutdown immediately when getFullShutdown returns a function", async () => {
    const { finishBootBeforeShutdown } = await import("../../../lib/server.js");
    const calls = [];
    const fullShutdown = async () => { calls.push("full"); };
    const result = await finishBootBeforeShutdown({
      bootAppPromise: null,
      getFullShutdown: () => fullShutdown,
      earlyShutdown: async () => { calls.push("early"); },
    });
    assert.deepEqual(calls, ["full"]);
  });

  test("waits for bootAppPromise when no fullShutdown yet, then uses fullShutdown", async () => {
    const { finishBootBeforeShutdown } = await import("../../../lib/server.js");
    const calls = [];
    let resolveBoot;
    const bootAppPromise = new Promise((resolve) => { resolveBoot = resolve; });
    let fullShutdown = null;

    const shutdownPromise = finishBootBeforeShutdown({
      bootAppPromise,
      getFullShutdown: () => fullShutdown,
      earlyShutdown: async () => { calls.push("early"); },
    });

    // Boot hasn't resolved yet — nothing should happen
    await Promise.resolve();
    assert.deepEqual(calls, [], "still waiting for boot");

    // Now boot finishes and sets fullShutdown
    fullShutdown = async () => { calls.push("full"); };
    resolveBoot();

    await shutdownPromise;
    assert.deepEqual(calls, ["full"]);
  });

  test("falls back to earlyShutdown when bootAppPromise resolves but fullShutdown is still null", async () => {
    const { finishBootBeforeShutdown } = await import("../../../lib/server.js");
    const calls = [];
    let resolveBoot;
    const bootAppPromise = new Promise((resolve) => { resolveBoot = resolve; });

    const shutdownPromise = finishBootBeforeShutdown({
      bootAppPromise,
      getFullShutdown: () => null,
      earlyShutdown: async () => { calls.push("early"); },
    });

    resolveBoot();
    await shutdownPromise;
    assert.deepEqual(calls, ["early"]);
  });

  test("falls back to earlyShutdown when bootAppPromise rejects", async () => {
    const { finishBootBeforeShutdown } = await import("../../../lib/server.js");
    const calls = [];
    const bootAppPromise = Promise.reject(new Error("boot failed"));

    const result = await finishBootBeforeShutdown({
      bootAppPromise,
      getFullShutdown: () => null,
      earlyShutdown: async () => { calls.push("early"); },
    });

    // Rejection is swallowed, early shutdown is used
    assert.deepEqual(calls, ["early"]);
  });

  test("falls back to earlyShutdown when both bootAppPromise and fullShutdown are absent", async () => {
    const { finishBootBeforeShutdown } = await import("../../../lib/server.js");
    const calls = [];
    const result = await finishBootBeforeShutdown({
      bootAppPromise: null,
      getFullShutdown: () => null,
      earlyShutdown: async () => { calls.push("early"); },
    });
    assert.deepEqual(calls, ["early"]);
  });
});

// =============================================================================
// createApp — minimal composition root tests (no listener, no boot)
// =============================================================================
describe("createApp", () => {
  // Use a high unique port so ensurePort doesn't interfere with a running dev server.
  const TEST_PORT = 39876;

  test("returns expected shape with skipBoot and no autoListen", async () => {
    const { createApp } = await import("../../../lib/server.js");
    const result = await createApp({
      root: resolve(process.cwd()),
      version: "0.0.0-test",
      port: TEST_PORT,
      skipBoot: true,
      autoListen: false,
    });

    assert.ok(result, "createApp returns a value");
    assert.ok(result.app, "has Express app");
    assert.equal(typeof result.app.use, "function", "app.use exists");
    assert.ok(result.httpServer, "has HTTP server");
    assert.equal(typeof result.httpServer.close, "function", "httpServer.close exists");
    assert.equal(typeof result.bootApp, "function", "has bootApp function");
    assert.equal(typeof result.bootAppOnce, "function", "has bootAppOnce function");
    assert.equal(typeof result.isShuttingDown, "function", "has isShuttingDown function");
  });

  test("isReady is false before boot", async () => {
    const { createApp } = await import("../../../lib/server.js");
    const result = await createApp({
      root: resolve(process.cwd()),
      version: "0.0.0-test",
      port: TEST_PORT + 1,
      skipBoot: true,
      autoListen: false,
    });

    assert.equal(result.isReady, false);
  });

  test("isShuttingDown returns false initially", async () => {
    const { createApp } = await import("../../../lib/server.js");
    const result = await createApp({
      root: resolve(process.cwd()),
      version: "0.0.0-test",
      port: TEST_PORT + 2,
      skipBoot: true,
      autoListen: false,
    });

    assert.equal(result.isShuttingDown(), false);
  });

  test("creates app with default options", async () => {
    const { createApp } = await import("../../../lib/server.js");
    const originalPort = process.env.PORT;
    process.env.PORT = String(TEST_PORT + 3);

    try {
      const result = await createApp({
        root: resolve(process.cwd()),
        version: "0.0.0-test",
        skipBoot: true,
        autoListen: false,
      });

      assert.ok(result.app);
      assert.ok(result.httpServer);
    } finally {
      if (originalPort === undefined) delete process.env.PORT;
      else process.env.PORT = originalPort;
    }
  });

  test("accepts injectAgent option", async () => {
    const { createApp } = await import("../../../lib/server.js");
    const fakeAgent = { name: "test-agent" };
    const result = await createApp({
      root: resolve(process.cwd()),
      version: "0.0.0-test",
      port: TEST_PORT + 4,
      skipBoot: true,
      autoListen: false,
      injectAgent: fakeAgent,
    });

    assert.ok(result.app);
  });
});
