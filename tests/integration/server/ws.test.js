// Tests for ws.js — createWsServer
//
// WebSocketServer is mocked on the CJS `ws` module (which ESM import reads
// from). isAuthorized is NOT mocked — auth is opt-in, so with no
// APERIO_AUTH_TOKEN configured it returns true by default. The verifyClient
// origin check is tested by providing allow/deny host patterns.
//
// Rather than trying to mock the ws WebSocketServer constructor (which doesn't
// work with mock.method on class constructors), we provide a real httpServer
// mock that the real WebSocketServer can attach to, and mock the ws.Server
// instance's `on` method and `clients` property after construction.

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal httpServer mock that ws.WebSocketServer can attach to. */
function mockHttpServer() {
  const listeners = {};
  return {
    listeners,
    on: mock.fn((event, handler) => { listeners[event] = handler; }),
    address: () => ({ port: 31337 }),
  };
}

/** Default options to pass to createWsServer. */
function defaultOpts(overrides = {}) {
  return {
    httpServer: mockHttpServer(),
    allowedHosts: new Set(["localhost"]),
    makeWsHandler: () => () => {},  // must return a handler function
    agent: {},
    primaryRoundtable: {},
    verifier: {},
    roundtableAvailable: true,
    store: {},
    isShuttingDown: false,
    ...overrides,
  };
}

// ─── Import SUT ───────────────────────────────────────────────────────────────

let createWsServer;

before(async () => {
  const mod = await import("../../../lib/server/ws.js");
  createWsServer = mod.createWsServer;
});

after(() => {
  mock.restoreAll();
});

// ═══════════════════════════════════════════════════════════════════════════════
// verifyClient — origin & auth
// ═══════════════════════════════════════════════════════════════════════════════

describe("verifyClient", () => {
  /**
   * Create a server and directly invoke the verifyClient callback that was
   * captured in the WebSocketServer constructor options.
   */
  function callVerifyClient({ origin, url, headers = {} }, hostOverrides) {
    const opts = defaultOpts(hostOverrides ?? {});
    const result = createWsServer(opts);
    const verifyClient = result._verifyClient; // saved during construction

    return new Promise((resolve) => {
      verifyClient(
        { origin, req: { url, headers } },
        (ok, code, msg) => resolve({ ok, code, msg }),
      );
    });
  }

  // ─── Origin validation ───────────────────────────────────────────────────

  test("allows requests from allowed origins", async () => {
    const result = await callVerifyClient({
      origin: "http://localhost:31337",
      url: "/",
    });
    assert.strictEqual(result.ok, true);
  });

  test("allows requests with no origin set", async () => {
    const result = await callVerifyClient({ origin: null, url: "/" });
    assert.strictEqual(result.ok, true);
  });

  test("rejects requests from disallowed origins with 403", async () => {
    const result = await callVerifyClient({
      origin: "http://evil.com",
      url: "/",
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 403);
    assert.strictEqual(result.msg, "Forbidden");
  });

  test("rejects requests from IP-origin without allowedHosts match", async () => {
    const result = await callVerifyClient({
      origin: "http://192.168.1.1:8080",
      url: "/",
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 403);
  });

  test("rejects malformed origins with 400", async () => {
    const result = await callVerifyClient({
      origin: "not-a-valid-url!!!",
      url: "/",
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 400);
    assert.strictEqual(result.msg, "Bad Request");
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  test("allows requests when no auth token is configured (opt-in)", async () => {
    delete process.env.APERIO_AUTH_TOKEN;
    const result = await callVerifyClient({
      origin: "http://localhost:31337",
      url: "/",
    });
    assert.strictEqual(result.ok, true);
  });

  // ─── origin is case-insensitive ──────────────────────────────────────────

  test("matches origins case-insensitively", async () => {
    const result = await callVerifyClient({
      origin: "HTTP://LOCALHOST:31337",
      url: "/",
    });
    assert.strictEqual(result.ok, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createWsServer shape
// ═══════════════════════════════════════════════════════════════════════════════

describe("createWsServer", () => {
  test("returns { wss, broadcastToClients }", () => {
    const result = createWsServer(defaultOpts());
    assert.ok(result.wss);
    assert.strictEqual(typeof result.broadcastToClients, "function");
  });

  test("exposes the verifyClient callback for testing", () => {
    const result = createWsServer(defaultOpts());
    assert.strictEqual(typeof result._verifyClient, "function");
  });

  test("creates WebSocketServer with the provided httpServer", () => {
    const httpServer = mockHttpServer();
    createWsServer(defaultOpts({ httpServer }));
    // The ws library adds listeners to our httpServer mock (upgrade + cleanup)
    const events = httpServer.on.mock.calls.map(c => c.arguments[0]);
    assert.ok(events.includes("upgrade"), "should register an 'upgrade' listener");
  });

  test("sets up connection handler via makeWsHandler", () => {
    const httpServer = mockHttpServer();
    const makeWsHandler = mock.fn(() => () => {}); // returns handler fn
    createWsServer(defaultOpts({ httpServer, makeWsHandler }));

    assert.strictEqual(makeWsHandler.mock.callCount(), 1);
    const args = makeWsHandler.mock.calls[0].arguments[0];
    assert.strictEqual(typeof args.agent, "object");
    assert.strictEqual(typeof args.store, "object");
    assert.strictEqual(typeof args.isShuttingDown, "boolean");
  });

  test("passes roundtable info through to makeWsHandler", () => {
    const makeWsHandler = mock.fn(() => () => {});
    createWsServer(defaultOpts({
      makeWsHandler,
      roundtableAvailable: false,
      roundtableUnavailableReason: "No verifier configured",
    }));
    const args = makeWsHandler.mock.calls[0].arguments[0];
    assert.strictEqual(args.roundtableAvailable, false);
    assert.strictEqual(args.roundtableUnavailableReason, "No verifier configured");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// broadcastToClients
// ═══════════════════════════════════════════════════════════════════════════════

describe("broadcastToClients", () => {
  test("sends JSON-stringified message to all open clients", () => {
    const sent = [[], []];
    const httpServer = mockHttpServer();
    const result = createWsServer(defaultOpts({ httpServer }));
    // Replace the real clients with our mock set
    result.wss.clients = new Set([
      { readyState: 1, send: (d) => sent[0].push(d) },
      { readyState: 1, send: (d) => sent[1].push(d) },
    ]);

    result.broadcastToClients({ type: "test", data: 42 });

    assert.strictEqual(sent[0].length, 1);
    assert.strictEqual(sent[1].length, 1);
    assert.strictEqual(sent[0][0], JSON.stringify({ type: "test", data: 42 }));
    assert.strictEqual(sent[1][0], JSON.stringify({ type: "test", data: 42 }));
  });

  test("skips clients with non-OPEN readyState", () => {
    const sent = [];
    const result = createWsServer(defaultOpts());
    result.wss.clients = new Set([
      { readyState: 2, send: (d) => sent.push(d) },  // CLOSING
      { readyState: 3, send: (d) => sent.push(d) },  // CLOSED
    ]);

    result.broadcastToClients({ type: "test" });

    assert.strictEqual(sent.length, 0);
  });

  test("handles a send that throws (dead socket)", () => {
    const result = createWsServer(defaultOpts());
    result.wss.clients = new Set([
      { readyState: 1, send: () => { throw new Error("closed"); } },
    ]);

    assert.doesNotThrow(() => result.broadcastToClients({ type: "test" }));
  });
});
