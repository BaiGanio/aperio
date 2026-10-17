// tests/lib/helpers/staticAuth.test.js
// PATH-02 — cookie gate on /uploads and /scratch static mounts.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createStaticGuard, STATIC_COOKIE } from "../../../lib/helpers/staticAuth.js";

afterEach(() => { delete process.env.APERIO_AUTH_TOKEN; });

function run(guard, { cookie, headers = {}, url = "/scratch/x.png" } = {}) {
  const req = { headers: { ...headers, ...(cookie ? { cookie } : {}) }, url };
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
  let nexted = false;
  guard(req, res, () => { nexted = true; });
  return { nexted, statusCode: res.statusCode, body: res.body };
}

describe("createStaticGuard", () => {
  const TOKEN = "tok-abc";
  const guard = createStaticGuard(TOKEN);

  test("allows request carrying the correct cookie", () => {
    assert.equal(run(guard, { cookie: `${STATIC_COOKIE}=${TOKEN}` }).nexted, true);
  });

  test("allows when other cookies are also present", () => {
    assert.equal(run(guard, { cookie: `aperio_lang=en; ${STATIC_COOKIE}=${TOKEN}; foo=bar` }).nexted, true);
  });

  test("403 with no cookie", () => {
    const r = run(guard, {});
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.error, "forbidden");
  });

  test("403 with wrong cookie value", () => {
    assert.equal(run(guard, { cookie: `${STATIC_COOKIE}=nope` }).statusCode, 403);
  });

  test("API token grants access when APERIO_AUTH_TOKEN is configured", () => {
    process.env.APERIO_AUTH_TOKEN = "s3cret";
    assert.equal(run(guard, { headers: { authorization: "Bearer s3cret" } }).nexted, true);
  });

  test("API token path is inert unless APERIO_AUTH_TOKEN is set", () => {
    // No env token configured → a bearer header must NOT grant static access.
    assert.equal(run(guard, { headers: { authorization: "Bearer anything" } }).statusCode, 403);
  });
});
