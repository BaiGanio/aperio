// tests/lib/helpers/authGuard.test.js
// AUTH-01 — opt-in shared-secret gate on /api/* (and WS via isAuthorized).

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { extractToken, isAuthorized, createAuthGuard } from "../../../lib/helpers/authGuard.js";

afterEach(() => {
  delete process.env.APERIO_AUTH_TOKEN;
});

function run(guard, { path = "/api/version", headers = {}, url } = {}) {
  const req = { path, headers, url: url ?? path };
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
  let nexted = false;
  guard(req, res, () => { nexted = true; });
  return { nexted, statusCode: res.statusCode, body: res.body };
}

describe("extractToken", () => {
  test("bearer header", () =>
    assert.equal(extractToken({ headers: { authorization: "Bearer abc123" } }), "abc123"));
  test("x-aperio-token header", () =>
    assert.equal(extractToken({ headers: { "x-aperio-token": "abc123" } }), "abc123"));
  test("query param", () =>
    assert.equal(extractToken({ headers: {}, url: "/api/x?token=abc123" }), "abc123"));
  test("none", () =>
    assert.equal(extractToken({ headers: {} }), null));
});

describe("isAuthorized", () => {
  test("opt-in: passes when no token configured", () => {
    assert.equal(isAuthorized({ headers: {} }), true);
  });
  test("rejects when token configured but absent", () => {
    process.env.APERIO_AUTH_TOKEN = "s3cret";
    assert.equal(isAuthorized({ headers: {} }), false);
  });
  test("accepts matching token", () => {
    process.env.APERIO_AUTH_TOKEN = "s3cret";
    assert.equal(isAuthorized({ headers: { authorization: "Bearer s3cret" } }), true);
  });
  test("rejects wrong token", () => {
    process.env.APERIO_AUTH_TOKEN = "s3cret";
    assert.equal(isAuthorized({ headers: { authorization: "Bearer nope" } }), false);
  });
  test("rejects token of different length (no length-leak crash)", () => {
    process.env.APERIO_AUTH_TOKEN = "s3cret";
    assert.equal(isAuthorized({ headers: { "x-aperio-token": "x" } }), false);
  });
});

describe("createAuthGuard", () => {
  test("non-/api paths bypass even when token set", () => {
    process.env.APERIO_AUTH_TOKEN = "s3cret";
    assert.equal(run(createAuthGuard(), { path: "/" }).nexted, true);
  });
  test("opt-in off → /api passes", () => {
    assert.equal(run(createAuthGuard(), {}).nexted, true);
  });
  test("401 when token required and missing", () => {
    process.env.APERIO_AUTH_TOKEN = "s3cret";
    const r = run(createAuthGuard(), {});
    assert.equal(r.statusCode, 401);
    assert.equal(r.body.error, "unauthorized");
  });
  test("passes with correct token", () => {
    process.env.APERIO_AUTH_TOKEN = "s3cret";
    const r = run(createAuthGuard(), { headers: { authorization: "Bearer s3cret" } });
    assert.equal(r.nexted, true);
  });
});
