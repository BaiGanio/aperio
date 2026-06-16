// tests/lib/helpers/ssrfGuard.test.js
// EGRESS-01 — SSRF guard. Uses IP-literal URLs so no DNS/network is needed.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, isBlockedAddress } from "../../../lib/helpers/ssrfGuard.js";

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
