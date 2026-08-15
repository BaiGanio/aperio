// T2.2 — audit/scripts/routes-contract.js (aperio-continuous-audit-tests.md, T2.2).
//
// This codebase's auth model is one global createAuthGuard() middleware
// (lib/server.js) in front of the whole /api router, not a per-route matrix —
// so the drift this gate catches is scoped to the one route family that opts
// out of it: an undeclared exemption, a declared-but-unimplemented one, or a
// registry entry that no longer matches the code (T2.2's "manual
// classification required" case, applied to auth exemptions instead of a
// generic policy-metadata field).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mutatingRoutes, checkRouteFile, checkRoutesContract, REVIEWED_AUTH_EXEMPTIONS } from "../scripts/routes-contract.js";

describe("audit/scripts/routes-contract.js", () => {
  test("mutatingRoutes classifies state-changing verbs and leaves GET alone", () => {
    const src = `
router.get("/things", h1);
router.post("/things", h2);
router.delete("/things/:id", h3);
`;
    const routes = mutatingRoutes(src);
    assert.deepStrictEqual(routes.map((r) => [r.method, r.mutating]), [
      ["get", false], ["post", true], ["delete", true],
    ]);
  });

  test("T2.2 — a route file that self-declares an auth exemption but isn't reviewed fails, " +
    "naming it as needing manual classification", () => {
    const src = `
// this path is exempt
// from createAuthGuard entirely
router.post("/new-unreviewed-hook", h);
`;
    const result = checkRouteFile("api-new-unreviewed.js", src, {});
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("manual classification required")));
  });

  test("T2.2 — a reviewed exemption with its verification marker present passes", () => {
    const src = `
// exempt from createAuthGuard, verified via HMAC below.
function h() { crypto.timingSafeEqual(a, b); }
`;
    const result = checkRouteFile("api-reviewed.js", src, {
      "api-reviewed.js": { verifyMarker: "timingSafeEqual" },
    });
    assert.strictEqual(result.ok, true);
  });

  test("T2.2 — a reviewed exemption whose verification step was removed fails " +
    "(exemption without real verification is an open auth bypass)", () => {
    const src = `
// exempt from createAuthGuard.
function h() { /* verification code deleted */ }
`;
    const result = checkRouteFile("api-reviewed.js", src, {
      "api-reviewed.js": { verifyMarker: "timingSafeEqual" },
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("verification step")));
  });

  test("T2.2 — a stale registry entry (code no longer declares the exemption) fails", () => {
    const src = `router.post("/normal-route", h); // ordinary route, guard applies`;
    const result = checkRouteFile("api-reviewed.js", src, {
      "api-reviewed.js": { verifyMarker: "timingSafeEqual" },
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("stale")));
  });

  test("T5.1 red/green proof — declaring the same route without registering it fails; " +
    "adding it to the exemption registry with its verifier present flips it to passing", () => {
    const src = `
// exempt from createAuthGuard
function h() { crypto.timingSafeEqual(a, b); }
`;
    const red = checkRouteFile("api-fixture.js", src, {});
    assert.strictEqual(red.ok, false);
    const green = checkRouteFile("api-fixture.js", src, {
      "api-fixture.js": { verifyMarker: "timingSafeEqual" },
    });
    assert.strictEqual(green.ok, true);
  });

  test("current real state — the real route tree reconciles clean, and the webhook route " +
    "is the only reviewed auth exemption", () => {
    const result = checkRoutesContract();
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.deepStrictEqual(Object.keys(REVIEWED_AUTH_EXEMPTIONS), ["api-github-webhook.js"]);
    assert.ok(Object.values(result.inventory).some((routes) => routes.some((r) => r.mutating)),
      "expected at least one real mutating route to be found");
  });
});
