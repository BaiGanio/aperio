// tests/lib/helpers/netGuard.test.js
// REBIND-01 — Host allowlist + Origin check + X-Aperio-Client gate.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseHostHeader,
  parseOriginHost,
  buildAllowedHosts,
  createNetGuard,
} from "../../lib/helpers/netGuard.js";

afterEach(() => {
  delete process.env.APERIO_ALLOWED_HOSTS;
});

// Minimal req/res doubles. res.json/status record the outcome; next() flips a flag.
function run(guard, { method = "GET", path = "/", host, origin, client } = {}) {
  const headers = {};
  if (host !== undefined) headers.host = host;
  if (origin !== undefined) headers.origin = origin;
  if (client !== undefined) headers["x-aperio-client"] = client;
  const req = { method, path, headers };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  let nexted = false;
  guard(req, res, () => { nexted = true; });
  return { nexted, statusCode: res.statusCode, body: res.body };
}

describe("parseHostHeader", () => {
  test("strips port", () => assert.equal(parseHostHeader("localhost:3000"), "localhost"));
  test("ipv4", () => assert.equal(parseHostHeader("127.0.0.1:3000"), "127.0.0.1"));
  test("ipv6 bracketed", () => assert.equal(parseHostHeader("[::1]:3000"), "[::1]"));
  test("null on garbage", () => assert.equal(parseHostHeader(""), null));
});

describe("parseOriginHost", () => {
  test("full url", () => assert.equal(parseOriginHost("http://localhost:3000"), "localhost"));
  test("null literal rejected", () => assert.equal(parseOriginHost("null"), null));
  test("empty", () => assert.equal(parseOriginHost(""), null));
});

describe("buildAllowedHosts", () => {
  test("defaults include loopback", () => {
    const set = buildAllowedHosts("127.0.0.1");
    assert.ok(set.has("localhost") && set.has("127.0.0.1") && set.has("[::1]"));
  });
  test("normalizes bare ipv6 bind host", () => {
    assert.ok(buildAllowedHosts("::1").has("[::1]"));
  });
  test("APERIO_ALLOWED_HOSTS extends", () => {
    const set = buildAllowedHosts("127.0.0.1", "aperio.example.com, 192.168.1.5");
    assert.ok(set.has("aperio.example.com") && set.has("192.168.1.5"));
  });
});

describe("createNetGuard", () => {
  const guard = createNetGuard({ allowedHosts: buildAllowedHosts("127.0.0.1") });

  test("allows known host GET", () => {
    const r = run(guard, { host: "127.0.0.1:3000" });
    assert.equal(r.nexted, true);
  });

  test("rejects unknown Host (rebinding)", () => {
    const r = run(guard, { host: "evil.example.com" });
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.error, "host_not_allowed");
    assert.equal(r.nexted, false);
  });

  test("rejects missing Host", () => {
    assert.equal(run(guard, {}).statusCode, 403);
  });

  test("state-changing /api needs X-Aperio-Client", () => {
    const r = run(guard, { method: "POST", path: "/api/settings/foo", host: "localhost:3000" });
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.error, "client_header_required");
  });

  test("state-changing /api passes with client header + same-origin", () => {
    const r = run(guard, {
      method: "POST", path: "/api/settings/foo", host: "localhost:3000",
      origin: "http://localhost:3000", client: "1",
    });
    assert.equal(r.nexted, true);
  });

  test("state-changing /api rejects cross-site Origin", () => {
    const r = run(guard, {
      method: "POST", path: "/api/settings/foo", host: "localhost:3000",
      origin: "http://evil.example.com", client: "1",
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.error, "origin_not_allowed");
  });

  test("GET /api does not require client header", () => {
    const r = run(guard, { method: "GET", path: "/api/version", host: "localhost:3000" });
    assert.equal(r.nexted, true);
  });

  test("non-/api POST does not require client header", () => {
    const r = run(guard, { method: "POST", path: "/whatever", host: "localhost:3000" });
    assert.equal(r.nexted, true);
  });
});
