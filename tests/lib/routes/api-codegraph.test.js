// tests/lib/routes/api-codegraph.test.js
// Tests for code graph REST endpoints: status, index, repos, search,
// outline, context, callers, callees.
//
// Follows the same pattern as api-docgraph.test.js — cgRoute returns
// { enabled: false } when store has no pool/db, and handler errors
// surface as userFacing (400) or internal (500).

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Router } from "express";

import logger from "../../../lib/helpers/logger.js";
import { mountCodegraphRoutes } from "../../../lib/routes/api-codegraph.js";

const __filename = fileURLToPath(import.meta.url);

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

function makeStore(withDb = false) {
  return {
    pool: undefined,
    db: withDb ? {} : undefined,
    getSetting: async () => null,
    setSetting: async () => {},
    counts: async () => ({ total: 0, embedded: 0 }),
    listAll: async () => [],
  };
}

// =============================================================================
// GET /codegraph/status
// =============================================================================

describe("GET /codegraph/status", () => {
  test("returns status JSON", async () => {
    const store = makeStore();
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/codegraph/status");
    assert.strictEqual(status, 200);
    assert.ok(typeof body === "object");
  });
});

// =============================================================================
// GET /codegraph/repos
// =============================================================================

describe("GET /codegraph/repos", () => {
  test("returns enabled: false when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/codegraph/repos");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.enabled, false);
  });

  test("returns error when database is present but handler throws", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status } = await invoke(router, "GET", "/codegraph/repos");
    // cgRoute catches userFacing errors as 400, internal errors as 500
    assert.ok(status === 400 || status === 500);
  });
});

// =============================================================================
// GET /codegraph/search
// =============================================================================

describe("GET /codegraph/search", () => {
  test("returns enabled: false when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/codegraph/search", {
      query: { q: "test" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.enabled, false);
  });

  test("returns error when database is present but handler throws", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status } = await invoke(router, "GET", "/codegraph/search", {
      query: { q: "foo" },
    });
    assert.ok(status === 400 || status === 500);
  });
});

// =============================================================================
// GET /codegraph/outline
// =============================================================================

describe("GET /codegraph/outline", () => {
  test("returns enabled: false when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/codegraph/outline", {
      query: { path: "/some/file.ts" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.enabled, false);
  });

  test("returns error when database is present but handler throws", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status } = await invoke(router, "GET", "/codegraph/outline", {
      query: { path: "/no/such/file.ts" },
    });
    assert.ok(status === 400 || status === 500);
  });
});

// =============================================================================
// GET /codegraph/context
// =============================================================================

describe("GET /codegraph/context", () => {
  test("returns enabled: false when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/codegraph/context", {
      query: { qualified: "Foo.bar" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.enabled, false);
  });

  test("returns error when database is present but handler throws", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status } = await invoke(router, "GET", "/codegraph/context", {
      query: { qualified: "Missing.Symbol" },
    });
    assert.ok(status === 400 || status === 500);
  });
});

// =============================================================================
// GET /codegraph/callers
// =============================================================================

describe("GET /codegraph/callers", () => {
  test("returns enabled: false when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/codegraph/callers", {
      query: { qualified: "Foo.call" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.enabled, false);
  });

  test("returns error when database is present but handler throws", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status } = await invoke(router, "GET", "/codegraph/callers", {
      query: { qualified: "No.callers" },
    });
    assert.ok(status === 400 || status === 500);
  });
});

// =============================================================================
// GET /codegraph/callees
// =============================================================================

describe("GET /codegraph/callees", () => {
  test("returns enabled: false when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/codegraph/callees", {
      query: { qualified: "Foo.util" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.enabled, false);
  });

  test("returns error when database is present but handler throws", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status } = await invoke(router, "GET", "/codegraph/callees", {
      query: { qualified: "No.callees" },
    });
    assert.ok(status === 400 || status === 500);
  });
});

// =============================================================================
// POST /codegraph/index
// =============================================================================

describe("POST /codegraph/index", () => {
  test("returns 400 when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/codegraph/index", {
      body: { path: "/some/repo" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("SQLite") || body.error.includes("Postgres"));
  });

  test("returns 400 when path is missing", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/codegraph/index", {
      body: {},
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("path is required"));
  });

  test("returns 400 when path is empty", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/codegraph/index", {
      body: { path: "" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("path is required"));
  });

  test("returns 400 when path is not a directory", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/codegraph/index", {
      body: { path: __filename },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("Not a directory") || body.error.includes("not a directory"));
  });

  test("returns 403 when path is outside allowed read paths", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/codegraph/index", {
      body: { path: "/tmp" },
    });
    assert.strictEqual(status, 403);
    assert.ok(body.error.includes("read ceiling") || body.error.includes("APERIO_ALLOWED_PATHS_TO_READ"));
  });

  test("valid directory inside floor paths passes validation then hits handler error (no real db)", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status } = await invoke(router, "POST", "/codegraph/index", {
      body: { path: process.cwd() },
    });
    // The directory + allowlist checks pass, but cgRepos (called next) fails
    assert.ok(status === 202 || status === 400 || status === 500);
  });
});

// =============================================================================
// DELETE /codegraph/repos
// =============================================================================

describe("DELETE /codegraph/repos", () => {
  test("returns enabled: false when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "DELETE", "/codegraph/repos", {
      body: { path: "/some/repo" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.enabled, false);
  });

  test("missing path triggers userFacing error (400)", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status, body } = await invoke(router, "DELETE", "/codegraph/repos", {
      body: {},
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("path is required"));
  });

  test("returns error when handler throws", async () => {
    const store = makeStore(true);
    const router = Router();
    mountCodegraphRoutes(router, { store });

    const { status } = await invoke(router, "DELETE", "/codegraph/repos", {
      body: { path: "/nonexistent/repo" },
    });
    assert.ok(status === 400 || status === 500);
  });
});
