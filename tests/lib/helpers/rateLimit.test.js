// tests/lib/helpers/rateLimit.test.js
// NET-03 — per-IP throttle. Boots a tiny express app on an ephemeral port and
// fires real requests so the limiter runs end-to-end.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { makeRateLimiter } from "../../../lib/helpers/rateLimit.js";

let server, base;

before(async () => {
  const app = express();
  app.post("/limited", makeRateLimiter({ windowMs: 60_000, max: 2, name: "test" }), (_req, res) =>
    res.json({ ok: true })
  );
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

describe("makeRateLimiter", () => {
  test("allows up to max then returns 429", async () => {
    const post = () => fetch(`${base}/limited`, { method: "POST" });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    const blocked = await post();
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error, "rate_limited");
    assert.equal(body.endpoint, "test");
  });
});
