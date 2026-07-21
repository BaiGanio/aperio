// tests/lib/helpers/ssrfGuard.test.js
// EGRESS-01 — SSRF guard. Uses IP-literal URLs so no DNS/network is needed.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { assertPublicUrl, isBlockedAddress, makePinnedLookup } from "../../../lib/helpers/ssrfGuard.js";

afterEach(() => {
  delete process.env.APERIO_ALLOW_INTERNAL_FETCH;
  delete process.env.APERIO_EGRESS_ALLOWLIST;
});

async function rejects(url) {
  await assert.rejects(() => assertPublicUrl(url), /SSRF guard/);
}

describe("isBlockedAddress", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.17.0.2", "192.168.0.5", "169.254.169.254", "100.64.0.1"])
    test(`blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));

  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"])
    test(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));

  test("blocks IPv6 loopback and link-local", () => {
    assert.equal(isBlockedAddress("::1"), true);
    assert.equal(isBlockedAddress("fe80::1"), true);
    assert.equal(isBlockedAddress("fd00::1"), true);
  });

  test("blocks IPv4-mapped IPv6 loopback", () =>
    assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true));
});

describe("assertPublicUrl", () => {
  test("rejects loopback", () => rejects("http://127.0.0.1/"));
  test("rejects cloud metadata endpoint", () => rejects("http://169.254.169.254/latest/meta-data/"));
  test("rejects private range", () => rejects("http://10.0.0.5:8080/admin"));
  test("rejects Docker bridge", () => rejects("http://172.17.0.1/"));
  test("rejects IPv6 loopback", () => rejects("http://[::1]:3000/"));
  test("rejects non-HTTP scheme", () => rejects("file:///etc/passwd"));

  test("allows a public IP literal", async () =>
    await assert.doesNotReject(() => assertPublicUrl("http://8.8.8.8/")));

  test("allows an unresolvable host (fetch fails naturally)", async () =>
    await assert.doesNotReject(() => assertPublicUrl("http://nonexistent.invalid/")));

  test("APERIO_ALLOW_INTERNAL_FETCH=1 disables the guard", async () => {
    process.env.APERIO_ALLOW_INTERNAL_FETCH = "1";
    await assert.doesNotReject(() => assertPublicUrl("http://127.0.0.1/"));
  });

  test("egress allowlist refuses hosts not listed", async () => {
    process.env.APERIO_EGRESS_ALLOWLIST = "example.com,api.github.com";
    await rejects("http://8.8.8.8/");
  });

  test("egress allowlist permits a listed host", async () => {
    process.env.APERIO_EGRESS_ALLOWLIST = "8.8.8.8";
    await assert.doesNotReject(() => assertPublicUrl("http://8.8.8.8/"));
  });
});

describe("makePinnedLookup", () => {
  test("answers the scalar form when all is not requested", (t, done) => {
    makePinnedLookup("93.184.216.34", 4)("example.com", {}, (err, address, family) => {
      assert.equal(err, null);
      assert.equal(address, "93.184.216.34");
      assert.equal(family, 4);
      done();
    });
  });

  test("answers the array form when called with { all: true }", (t, done) => {
    makePinnedLookup("93.184.216.34", 4)("example.com", { all: true }, (err, addresses) => {
      assert.equal(err, null);
      assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
      done();
    });
  });

  // Regression for "Invalid IP address: undefined": Node ≥20 sockets default to
  // autoSelectFamily, which calls the custom lookup with { all: true } and
  // expects an array — the old scalar-only callback broke every pinned fetch.
  // Drive a real socket through http.request with the pinned lookup and assert
  // the connection succeeds under the runtime's default socket options.
  test("http.request connects through the pinned lookup (autoSelectFamily)", async () => {
    const server = http.createServer((req, res) => res.end("ok"));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const body = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: "pinned-host.invalid", // never resolved: the lookup answers
          port,
          path: "/",
          lookup: makePinnedLookup("127.0.0.1", 4),
        }, (res) => {
          const chunks = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(body, "ok");
    } finally {
      server.close();
    }
  });
});
