// tests/lib/helpers/rateLimit.test.js
// NET-03 — per-IP throttle. Uses the invoke() helper to call the Express
// router directly — no live HTTP server. express-rate-limit tracks hits by
// req.ip in memory; sequential calls from the same IP correctly trigger 429.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";
import { makeRateLimiter } from "../../../lib/helpers/rateLimit.js";

// ─── Invoke helper ────────────────────────────────────────────────────────────

function invoke(router, method, url, { body = null, params = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url, path: url, params,
      body: body != null ? structuredClone(body) : undefined,
      headers: {},
      baseUrl: "", originalUrl: url,
      ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
      app: { get: () => undefined },
      get: () => undefined,
    };
    const res = {
      _status: 200,
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
      send(data)   { resolve({ status: this._status, body: data }); },
      setHeader()  { return this; },
      getHeader()  {},
      set()        { return this; },
      on()         { return this; },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

// ─── Route setup ──────────────────────────────────────────────────────────────

let router;

before(() => {
  router = Router();
  router.post("/limited", makeRateLimiter({ windowMs: 60_000, max: 2, name: "test" }), (_req, res) =>
    res.json({ ok: true })
  );
});

after(() => {});

// ─── Helper ───────────────────────────────────────────────────────────────────

const post = () => invoke(router, "POST", "/limited");

// =============================================================================

describe("makeRateLimiter", () => {
  test("allows up to max then returns 429", async () => {
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    const blocked = await post();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "rate_limited");
    assert.equal(blocked.body.endpoint, "test");
  });
});
