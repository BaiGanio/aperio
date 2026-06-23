// tests/lib/routes/api-database.test.js
// Tests for database connection CRUD endpoints.
//
// Connections are stored in the settings store. The real registry.js functions
// (listConnections, saveConnections) read/write through the store's getSetting
// / setSetting. We provide a mock store to control the persisted state.
// Test/sample/browser routes that need actual DB connections via getDriver
// are excluded from this file.

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";

import logger from "../../../lib/helpers/logger.js";
import { mountDatabaseRoutes } from "../../../lib/routes/api-database.js";

const SETTINGS_KEY = "db.connections";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

before(() => {
  mock.method(logger, "error", () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "info",  () => {});
  mock.method(logger, "debug", () => {});
});

after(() => mock.restoreAll());

// ─── Invoke helper ────────────────────────────────────────────────────────────

function invoke(router, method, url, { body = {}, query = {}, params = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url, body, query, params,
      path: url,
      headers: {}, baseUrl: "", originalUrl: url,
      ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
    };
    const res = {
      _status: 200, headersSent: false, _headers: {},
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
      getHeader(k)    { return this._headers[String(k).toLowerCase()]; },
      set()           { return this; },
      on()            { return this; },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

// ─── Mock store factory ──────────────────────────────────────────────────────
// The registry functions (listConnections, saveConnections) read/write
// settings.key = "db.connections" where the value is an array of connection
// objects. The mock store stores this in a plain object.

function makeStore(initialConnections = []) {
  const store = { [SETTINGS_KEY]: initialConnections };
  return {
    async getSetting(key) {
      return key === SETTINGS_KEY ? store[SETTINGS_KEY] : null;
    },
    async setSetting(key, value) {
      if (key === SETTINGS_KEY) store[SETTINGS_KEY] = value;
    },
    _store: store,
  };
}

// =============================================================================
// GET /database/connections
// =============================================================================

describe("GET /database/connections", () => {
  test("returns connections list from store", async () => {
    const store = makeStore([
      { name: "my-pg", engine: "postgres", host: "localhost" },
    ]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/database/connections");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.connections));
    // Should include the built-in aperio connection plus the stored one
    const names = body.connections.map(c => c.name);
    assert.ok(names.includes("my-pg"));
  });

  test("returns empty list when no connections saved", async () => {
    const store = makeStore([]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/database/connections");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.connections));
    // Built-in aperio connection is always listed
    assert.ok(body.connections.some(c => c.builtin));
  });

  test("returns 500 when store throws", async () => {
    const store = {
      getSetting: async () => { throw new Error("db down"); },
    };
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/database/connections");
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("db down"));
  });
});

// =============================================================================
// POST /database/connections  (upsert)
// =============================================================================

describe("POST /database/connections", () => {
  function makeStoreWithOne() {
    return makeStore([
      { name: "existing-pg", engine: "postgres", host: "pg.example.com", port: 5432, database: "test", user: "admin", password: "encrypted-secret" },
    ]);
  }

  // ── Validation tests ────────────────────────────────────────────────────────

  test("rejects missing name", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { engine: "postgres", host: "localhost" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("name"));
  });

  test("rejects invalid name characters", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "has space!", engine: "postgres", host: "localhost" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("name"));
  });

  test("rejects built-in reserved name", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "aperio", engine: "postgres", host: "localhost" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("reserved") || body.error.includes("built-in"));
  });

  test("rejects unknown engine", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "test", engine: "mongo", host: "localhost" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("engine"));
  });

  test("rejects SQLite without file path", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "test-sqlite", engine: "sqlite" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("file"));
  });

  test("rejects server engine without host", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "test-pg", engine: "postgres" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("host"));
  });

  // ── Add / update tests ──────────────────────────────────────────────────────

  test("adds a new connection", async () => {
    const store = makeStore([]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "my-db", engine: "postgres", host: "db.example.com", port: 5432, database: "test", user: "app", password: "secret" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    const names = body.connections.filter(c => !c.builtin).map(c => c.name);
    assert.ok(names.includes("my-db"));
  });

  test("updates existing connection preserving blank password", async () => {
    const store = makeStoreWithOne();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    // Update with blank password → preserve the stored encrypted one
    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "existing-pg", engine: "postgres", host: "new-host.example.com", password: "" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    // The stored connection's host should be updated
    const saved = await store.getSetting("db.connections");
    const conn = saved.find(c => c.name === "existing-pg");
    assert.strictEqual(conn.host, "new-host.example.com");
    // Password should be preserved and re-encrypted from previous entry
    assert.ok(conn.password.startsWith("enc:v1:"), "password was re-encrypted");
  });

  test("returns 500 when saveConnections throws", async () => {
    // A store whose setSetting throws
    const store = {
      getSetting: async () => [],
      setSetting: async () => { throw new Error("save failed"); },
    };
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "new-conn", engine: "sqlite", file: "/tmp/test.db" },
    });
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("save failed"));
  });
});

// =============================================================================
// DELETE /database/connections/:name
// =============================================================================

describe("DELETE /database/connections/:name", () => {
  test("deletes an existing connection", async () => {
    const store = makeStore([
      { name: "to-delete", engine: "sqlite", file: "/tmp/test.db" },
    ]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "DELETE", "/database/connections/to-delete");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    const saved = await store.getSetting("db.connections");
    assert.strictEqual(saved.length, 0);
  });

  test("blocks deleting the built-in aperio connection", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "DELETE", "/database/connections/aperio");
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("built-in") || body.error.includes("cannot be deleted"));
  });

  test("returns 404 for non-existent connection", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "DELETE", "/database/connections/nonexistent");
    assert.strictEqual(status, 404);
    assert.ok(body.error.includes("not found"));
  });

  test("returns 500 when store throws", async () => {
    const store = {
      getSetting: async () => { throw new Error("db error"); },
    };
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "DELETE", "/database/connections/anything");
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("db error"));
  });
});
