// tests/lib/routes/api-docgraph.test.js
// Tests for document graph REST endpoints: status, index, repos, search, context.
//
// Several routes use the cgRoute wrapper which returns { enabled: false } when
// store has no pool/db. The docgraph handlers (dgSearch, dgContext, dgRepos,
// dgDeleteRepo) are module-level imports that do real work — we test the route
// layer's validation, enabled/disabled gating, and error handling.

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Router } from "express";

import logger from "../../../lib/helpers/logger.js";
import { mountDocgraphRoutes } from "../../../lib/routes/api-docgraph.js";

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
// The docgraph routes check `if (!store?.pool && !store?.db)`. When the store
// has neither, cgRoute returns { enabled: false }. When it has db, the route
// accepts the request and passes it through to the docgraph handlers.

function makeStore(withDb = false) {
  return {
    pool: undefined,
    db: withDb ? {} : undefined,
    counts: async () => ({ total: 0, embedded: 0 }),
    listAll: async () => [],
    getSetting: async () => null,
    setSetting: async () => {},
  };
}

// =============================================================================
// GET /docgraph/status
// =============================================================================

describe("GET /docgraph/status", () => {
  test("returns status JSON", async () => {
    const store = makeStore();
    const router = Router();
    mountDocgraphRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/docgraph/status");
    assert.strictEqual(status, 200);
    // Status should at least be an object (might be empty or have root field)
    assert.ok(typeof body === "object");
  });
});

// =============================================================================
// GET /docgraph/repos
// =============================================================================

describe("GET /docgraph/repos", () => {
  test("returns enabled: false when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/docgraph/repos");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.enabled, false);
  });

  test("returns 400 when database is present but handler throws userFacing error", async () => {
    const store = makeStore(true);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    // cgRoute catches userFacing errors as 400
    const { status } = await invoke(router, "GET", "/docgraph/repos");
    assert.ok(status === 400 || status === 500);
  });
});

// =============================================================================
// GET /docgraph/search
// =============================================================================

describe("GET /docgraph/search", () => {
  test("returns enabled: false when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/docgraph/search", {
      query: { q: "test" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.enabled, false);
  });
});

// =============================================================================
// GET /docgraph/context
// =============================================================================

describe("GET /docgraph/context", () => {
  test("returns enabled: false when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/docgraph/context", {
      query: { path: "/some/file.md" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.enabled, false);
  });
});

// =============================================================================
// POST /docgraph/index
// =============================================================================

describe("POST /docgraph/index", () => {
  test("returns 400 when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/docgraph/index", {
      body: { path: "/some/dir" },
    });
    // Without pool/db, the route returns 400 directly
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("SQLite") || body.error.includes("Postgres"));
  });

  test("returns 400 when path is missing", async () => {
    const store = makeStore(true);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/docgraph/index", {
      body: {},
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("path is required"));
  });

  test("returns 400 when path is empty", async () => {
    const store = makeStore(true);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/docgraph/index", {
      body: { path: "" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("path is required"));
  });

  test("returns 400 when path is not a directory", async () => {
    const store = makeStore(true);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    // Use a path that definitely isn't a directory (the test file itself)
    const { status, body } = await invoke(router, "POST", "/docgraph/index", {
      body: { path: __filename },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("Not a directory") || body.error.includes("not a directory"));
  });

  test("returns 403 when path is outside allowed read paths", async () => {
    const store = makeStore(true);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    // Use a tmp path outside the project floor
    const { status, body } = await invoke(router, "POST", "/docgraph/index", {
      body: { path: "/tmp" },
    });
    assert.strictEqual(status, 403);
    assert.ok(body.error.includes("read ceiling") || body.error.includes("APERIO_ALLOWED_PATHS_TO_READ"));
  });

  test("valid directory inside floor paths hits validation then errors (no real db)", async () => {
    const store = makeStore(true);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    // The project root passes the directory + allowlist checks but the
    // underlying handler (dgRepos) fails because there's no real database.
    const { status, body } = await invoke(router, "POST", "/docgraph/index", {
      body: { path: process.cwd() },
    });
    // Should get past validation — the error is from the handler, not validation.
    // Could be 202 (started indexing) or 400/500 (handler error).
    assert.ok(status === 202 || status === 400 || status === 500);
    if (status === 202) {
      assert.strictEqual(body.ok, true);
    }
  });
});

// =============================================================================
// DELETE /docgraph/repos
// =============================================================================

describe("DELETE /docgraph/repos", () => {
  test("returns enabled: false when no database backend", async () => {
    const store = makeStore(false);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    const { status, body } = await invoke(router, "DELETE", "/docgraph/repos", {
      body: { path: "/some/repo" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.enabled, false);
  });

  test("missing path triggers userFacing error (400)", async () => {
    const store = makeStore(true);
    const router = Router();
    mountDocgraphRoutes(router, { store });

    // The DELETE route's cgRoute fn validates path and throws userFacing
    const { status, body } = await invoke(router, "DELETE", "/docgraph/repos", {
      body: {},
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("path is required"));
  });
});
