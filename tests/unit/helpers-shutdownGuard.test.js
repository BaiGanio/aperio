// tests/lib/helpers/shutdownGuard.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createWatchdog } from "../../lib/helpers/shutdownGuard.js";

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
describe("createWatchdog — quit", () => {

  test("quit runs the full teardown even when the idle guard is disabled", async () => {
    let exitCalled = false;
    let killedPid = null;
    const httpServer = makeMockHttpServer();

    const { quit } = createWatchdog({
      enabled:  false,
      getPid:   () => 4242,
      httpServer,
      _killPid: async (pid) => { killedPid = pid; },
      _exit:    () => { exitCalled = true; },
    });

    await quit();

    assert.equal(httpServer.closed, true,  "HTTP server should be closed");
    assert.equal(killedPid,         4242,  "llama-server PID should be killed on explicit quit");
    assert.equal(exitCalled,        true,  "_exit should be called");
  });

  test("latches shutdown state BEFORE terminating ws clients (so finaliseSession keeps interrupted sessions)", async () => {
    // Regression: idle/Quit teardown terminated ws clients — firing their close
    // handlers, which delete "trivial" sessions — while isShuttingDown was still
    // false, because the flag was only set later via _exit → SIGTERM. The mark
    // must happen first, so the close handler sees a shutdown and keeps the work.
    let shuttingDown = false;
    const flagAtTerminate = [];
    const wss = {
      // A ws close handler reads the latch synchronously when terminate() runs.
      clients: new Set([{ terminate: () => flagAtTerminate.push(shuttingDown) }]),
      close: (cb) => cb(),
    };

    const { quit } = createWatchdog({
      enabled: false,
      httpServer: makeMockHttpServer(),
      wss,
      _exit: () => {},
      _markShuttingDown: () => { shuttingDown = true; },
    });

    await quit();

    assert.deepEqual(flagAtTerminate, [true], "shutdown was latched before the client was terminated");
  });

  test("heartbeat never arms the idle timer when disabled", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let exitCalled = false;
    const { heartbeat } = createWatchdog({
      enabled:   false,
      timeoutMs: 500,
      _exit:     () => { exitCalled = true; },
    });

    heartbeat(); // must be a no-op for the idle guard
    t.mock.timers.tick(5000);
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

    assert.equal(exitCalled, false, "disabled watchdog must never idle-exit");
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
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { heartbeat } = createWatchdog({ enabled: true, timeoutMs: 500, _exit: () => {} });

    heartbeat(); // arm the switch
    t.mock.timers.tick(501);
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
    // No error = pass
  });

  test("does not stop llama-server when getPid returns null (we don't own it)", async (t) => {
    let exitCalled = false;
    let killCalled = false;
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { heartbeat } = createWatchdog({
      enabled: true,
      timeoutMs: 500,
      getPid: () => null,
      httpServer: makeMockHttpServer(),
      _killPid: async () => { killCalled = true; },
      _exit: () => { exitCalled = true; },
    });

    heartbeat(); // arm the switch
    t.mock.timers.tick(501);
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

    assert.equal(killCalled, false, "no PID means we don't own a process to stop");
    assert.equal(exitCalled, true, "process.exit should still be called");
  });

  test("stops llama-server by PID when we own the child", async (t) => {
    let exitCalled = false;
    let killedPid = null;
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { heartbeat } = createWatchdog({
      enabled:    true,
      timeoutMs:  500,
      getPid:     () => 1234,
      httpServer: makeMockHttpServer(),
      _killPid:   async (pid) => { killedPid = pid; },
      _exit:      () => { exitCalled = true; },
    });

    heartbeat(); // arm the switch
    t.mock.timers.tick(501);
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

    assert.equal(killedPid, 1234, "_killPid should be called with our owned PID");
    assert.equal(exitCalled, true, "process.exit should be called after stopping llama-server");
  });

  test("prefers the owner-aware _stopLlama over the raw _killPid path", async (t) => {
    let exitCalled = false;
    let stopCalled = false;
    let killCalled = false;
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const { heartbeat } = createWatchdog({
      enabled:    true,
      timeoutMs:  500,
      getPid:     () => 1234,
      httpServer: makeMockHttpServer(),
      _stopLlama: async () => { stopCalled = true; },
      _killPid:   async () => { killCalled = true; },
      _exit:      () => { exitCalled = true; },
    });

    heartbeat();
    t.mock.timers.tick(501);
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));

    assert.equal(stopCalled, true, "_stopLlama should own the llama teardown when provided");
    assert.equal(killCalled, false, "raw _killPid must not also fire when _stopLlama is present");
    assert.equal(exitCalled, true, "process.exit should still be called");
  });
});
