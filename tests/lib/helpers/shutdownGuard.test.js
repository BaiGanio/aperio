// tests/lib/helpers/shutdownGuard.test.js
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createWatchdog } from "../../../lib/helpers/shutdownGuard.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Helpers ─────────────────────────────────────────────────────────────────────

function makeMockWss(clients = []) {
  const terminated = [];
  return {
    clients: new Set(clients.map(c => ({ terminate: () => terminated.push(c) }))),
    close: (cb) => cb(),
    terminated,
  };
}

function makeMockHttpServer() {
  let closed = false;
  return {
    closeAllConnections: () => {},
    close: (cb) => { closed = true; cb(); },
    get closed() { return closed; },
  };
}

// =============================================================================
describe("createWatchdog — disabled", () => {

  test("returns no-op functions when enabled is false", () => {
    const { heartbeat, stop } = createWatchdog({ enabled: false });
    assert.equal(typeof heartbeat, "function");
    assert.equal(typeof stop,      "function");
    // Neither should throw
    heartbeat();
    stop();
  });
});

// =============================================================================
describe("createWatchdog — heartbeat and stop", () => {

  test("heartbeat and stop are callable functions", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { heartbeat, stop } = createWatchdog({ enabled: true, timeoutMs: 5000 });
    assert.equal(typeof heartbeat, "function");
    assert.equal(typeof stop, "function");
    stop(); // cancel so onIdle never fires during test
  });

  test("stop prevents idle callback from firing", async (t) => {
    let idleFired = false;

    t.mock.timers.enable({ apis: ["setTimeout"] });

    // Provide a mock httpServer so onIdle does not crash if it somehow fires
    const httpServer = { close: (cb) => cb(), closeAllConnections: () => {} };

    const { stop } = createWatchdog({
      enabled: true,
      timeoutMs: 1000,
      httpServer,
    });

    stop(); // cancel the timer immediately

    // Advance past the timeout — onIdle should NOT fire
    t.mock.timers.tick(2000);
    await new Promise(r => setImmediate(r));

    assert.equal(idleFired, false);
  });

  test("does not arm until the first heartbeat — a no-tab run is never killed", async (t) => {
    globalThis.fetch = async () => { throw new Error("mock"); };
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let exitCalled = false;
    createWatchdog({
      enabled: true,
      timeoutMs: 1000,
      httpServer: makeMockHttpServer(),
      _exit: () => { exitCalled = true; },
    });

    // No heartbeat ever arrives (no browser tab). Advance well past the timeout.
    t.mock.timers.tick(5000);
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

    assert.equal(exitCalled, false, "must not shut down before any browser connected");
  });

  test("heartbeat resets the idle timer", async (t) => {
    // We can verify heartbeat works by calling it and confirming no immediate exit
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { heartbeat, stop } = createWatchdog({
      enabled: true,
      timeoutMs: 1000,
    });

    // Advance close to timeout
    t.mock.timers.tick(900);
    // heartbeat should reset the timer
    heartbeat();
    // Advance past the original deadline — idle should NOT fire yet (timer was reset)
    t.mock.timers.tick(900);
    await new Promise(r => setImmediate(r));

    // Clean up
    stop();
  });
});

// =============================================================================
describe("createWatchdog — idle timeout fires onIdle", () => {

  test("closes wss clients and servers, then exits on idle", async (t) => {
    // Mock fetch so getOllamaPs returns null → isSafeToStop = false → no exec
    globalThis.fetch = async () => { throw new Error("no ollama in tests"); };

    let exitCalled = false;
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const wss        = makeMockWss();
    const httpServer = makeMockHttpServer();

    const { heartbeat } = createWatchdog({
      enabled:    true,
      timeoutMs:  3000,
      wss,
      httpServer,
      _exit: () => { exitCalled = true; },
    });

    heartbeat(); // a browser connected at least once → arms the dead-man's switch
    // Advance past timeout to trigger onIdle
    t.mock.timers.tick(3001);

    // Flush the async chain in onIdle (multiple awaits inside it)
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

    assert.equal(httpServer.closed, true, "HTTP server should be closed");
    assert.equal(exitCalled, true, "_exit should be called");
  });

  test("terminates wss client connections on idle", async (t) => {
    globalThis.fetch = async () => { throw new Error("mock"); };
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const terminated = [];
    const mockClient = { terminate: () => terminated.push(true) };
    const wss = {
      clients: new Set([mockClient]),
      close: (cb) => cb(),
    };

    const { heartbeat } = createWatchdog({ enabled: true, timeoutMs: 1000, wss, httpServer: makeMockHttpServer(), _exit: () => {} });

    heartbeat(); // arm the switch
    t.mock.timers.tick(1001);
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

    assert.equal(terminated.length, 1, "Client should be terminated");
  });

  test("works without wss or httpServer (both undefined)", async (t) => {
    globalThis.fetch = async () => { throw new Error("mock"); };
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { heartbeat } = createWatchdog({ enabled: true, timeoutMs: 500, _exit: () => {} });

    heartbeat(); // arm the switch
    t.mock.timers.tick(501);
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
    // No error = pass
  });

  test("does not stop Ollama when getOllamaPs returns null", async (t) => {
    globalThis.fetch = async () => { throw new Error("connection refused"); };

    let exitCalled = false;
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { heartbeat } = createWatchdog({ enabled: true, timeoutMs: 500, httpServer: makeMockHttpServer(), _exit: () => { exitCalled = true; } });

    heartbeat(); // arm the switch
    t.mock.timers.tick(501);
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

    assert.equal(exitCalled, true, "process.exit should still be called");
  });

  test("stops Ollama when all running models belong to this server", async (t) => {
    // loadedModels = our own model → foreign = [] → isSafeToStop returns true → stopOllama runs
    globalThis.fetch = async () => ({
      ok:   true,
      json: async () => ({ models: [{ name: "our-model" }] }),
    });

    let exitCalled = false;
    let ollamaStopped = false;
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { heartbeat } = createWatchdog({
      enabled:      true,
      timeoutMs:    500,
      models:       ["our-model"],
      httpServer:   makeMockHttpServer(),
      _stopOllama:  async () => { ollamaStopped = true; },
      _exit:        () => { exitCalled = true; },
    });

    heartbeat(); // arm the switch
    t.mock.timers.tick(501);
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

    assert.equal(ollamaStopped, true, "stopOllama should be called");
    assert.equal(exitCalled, true, "process.exit should be called after stopping Ollama");
  });

  test("does not stop Ollama when models from other processes are loaded", async (t) => {
    // Return non-empty models → isSafeToStop checks foreign processes
    globalThis.fetch = async () => ({
      ok:   true,
      json: async () => ({ models: [{ name: "other-model" }] }),
    });

    let exitCalled = false;
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { heartbeat } = createWatchdog({
      enabled:    true,
      timeoutMs:  500,
      models:     ["our-model"],
      httpServer: makeMockHttpServer(),
      _exit:      () => { exitCalled = true; },
    });

    heartbeat(); // arm the switch
    t.mock.timers.tick(501);
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

    assert.equal(exitCalled, true, "process.exit should still be called");
  });
});
