// tests/e2e/real-app-http.test.js
//
// Group D: Real HTTP and middleware behavior (plan Step 4)
// Also covers T1 (port-0 readiness) and T2 (runtime root isolation) from
// the companion tests file.
//
// NOTE: skipBoot=true means some /api/* endpoints (version, config,
// memories) are NOT available — they're mounted inside bootApp().
// Use /api/bootstrap/* and /api/locale for pre-boot API surface tests.
//
// Full API tests that need bootApp use the dedicated test file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startRealApp, request } from "./helpers/real-app-helper.js";

// ─── T1: Port-0 readiness ─────────────────────────────────────────────────

test("T1: port-0 assigns an OS port different from 0", async (t) => {
  const app = await startRealApp(t);
  assert.ok(app.port > 0, `OS-assigned port is positive: ${app.port}`);
  assert.ok(app.port < 65536, `Port is in valid range: ${app.port}`);
  assert.notEqual(app.port, 0, "Port is not 0 (the configured fallback)");
  assert.ok(app.readyData?.port === app.port,
    `Ready data reports same port: ${app.readyData?.port} === ${app.port}`);
});

// ─── T2: Concurrent fixtures get distinct ports ────────────────────────────

test("T2: two concurrent fixtures get different ports", async (t) => {
  const app1 = await startRealApp(t);
  const app2 = await startRealApp(t);
  assert.notEqual(app1.port, app2.port,
    `Concurrent fixtures on distinct ports: ${app1.port} vs ${app2.port}`);
});

// ─── T16: App shell is served at / ──────────────────────────────────────────

test("T16: / serves the app shell (or setup redirect)", async (t) => {
  const app = await startRealApp(t);
  const res = await request(app, "/");

  // Since the repo IS bootstrapped, / should return the index HTML.
  assert.ok(
    res.status === 200 || res.status === 302,
    `Root returns 200 or 302, got ${res.status}`
  );

  if (res.status === 200) {
    assert.ok(
      res.headers["content-type"]?.includes("text/html"),
      `Content-Type is HTML: ${res.headers["content-type"]}`
    );
    assert.ok(
      res.body.includes("<!DOCTYPE html") || res.body.includes("<html"),
      "Body contains HTML markup"
    );
  }
});

// ─── Pre-boot API endpoints ───────────────────────────────────────────────

test("pre-boot: /api/locale returns locale info", async (t) => {
  const app = await startRealApp(t);
  const res = await request(app, "/api/locale");
  assert.equal(res.status, 200, "Locale endpoint is 200");
  assert.ok(res.json, "Response is JSON");
  assert.ok(typeof res.json.lang === "string", "lang is a string");
  assert.ok(Array.isArray(res.json.supported), "supported is an array");
});

test("pre-boot: /api/bootstrap/state returns bootstrapped state", async (t) => {
  const app = await startRealApp(t);
  const res = await request(app, "/api/bootstrap/state");
  assert.equal(res.status, 200, "Bootstrap state endpoint is 200");
  assert.ok(res.json, "Response is JSON");
  // Should have bootstrapped info
  assert.ok("bootstrapped" in res.json, "Has bootstrapped field");
});

// ─── T19: Security headers are present on known-good endpoints ─────────────

test("T19: Helmet security headers are present", async (t) => {
  const app = await startRealApp(t);
  const res = await request(app, "/api/locale");
  assert.equal(res.status, 200);

  // Helmet headers
  assert.ok(res.headers["x-content-type-options"], "X-Content-Type-Options present");
  assert.ok(res.headers["x-frame-options"], "X-Frame-Options present");
  assert.ok(
    res.headers["content-type"]?.includes("application/json"),
    "API response is JSON"
  );
  // No permissive CORS
  assert.ok(
    !res.headers["access-control-allow-origin"] ||
    res.headers["access-control-allow-origin"] === "null",
    "No permissive CORS header"
  );
});

// ─── T20: Unknown Host rejection ───────────────────────────────────────────

test("T20: unknown Host is rejected", async (t) => {
  const app = await startRealApp(t);
  const res = await request(app, "/api/locale", {
    headers: { Host: "attacker.example" },
  });
  assert.equal(res.status, 403, "Unknown host gets 403");
});

// ─── T23: Body limits — oversized JSON is rejected ──────────────────────────

test("T23: oversized JSON body is rejected", async (t) => {
  const app = await startRealApp(t);
  const bigBody = JSON.stringify({ data: "x".repeat(300_000) });
  const res = await request(app, "/api/setup/specs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Host": "127.0.0.1",
      "X-Aperio-Client": "e2e",
    },
    body: bigBody,
  });
  // Should return 4xx (too large)
  assert.ok(
    res.status >= 400 && res.status < 500,
    `Oversized body rejected with 4xx: ${res.status}`
  );
});

// ─── T21: Client header required for mutations ─────────────────────────────

test("T21: PUT settings without client header is rejected", async (t) => {
  const app = await startRealApp(t);
  const res = await request(app, "/api/settings/test.key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "test" }),
  });
  assert.ok(
    res.status === 401 || res.status === 403,
    `Missing client header returns 401/403: ${res.status}`
  );
});
