// tests/lib/helpers/errorHandler.test.js
// LOG-01 — terminal error handler scrubs messages in production.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createErrorHandler } from "../../../lib/helpers/errorHandler.js";

function mockReqRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
  return { req: { method: "GET", path: "/api/secret/42" }, res };
}

describe("createErrorHandler", () => {
  test("production hides the message and returns a correlation id", () => {
    const handler = createErrorHandler({ isProd: true });
    const { req, res } = mockReqRes();
    handler(new Error("connect ECONNREFUSED 10.0.0.5:5432"), req, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, "internal_error");
    assert.match(res.body.errorId, /^[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(res.body).includes("ECONNREFUSED"));
  });

  test("non-production surfaces the real message for debugging", () => {
    const handler = createErrorHandler({ isProd: false });
    const { req, res } = mockReqRes();
    handler(new Error("boom"), req, res, () => {});
    assert.equal(res.body.error, "boom");
  });

  test("honours an explicit err.status", () => {
    const handler = createErrorHandler({ isProd: true });
    const { req, res } = mockReqRes();
    const err = Object.assign(new Error("nope"), { status: 403 });
    handler(err, req, res, () => {});
    assert.equal(res.statusCode, 403);
  });

  test("does nothing once the response has started streaming", () => {
    const handler = createErrorHandler({ isProd: true });
    const { req, res } = mockReqRes();
    res.headersSent = true;
    handler(new Error("late"), req, res, () => {});
    assert.equal(res.body, null);          // never wrote a body
    assert.equal(res.statusCode, 200);     // never touched status
  });
});
