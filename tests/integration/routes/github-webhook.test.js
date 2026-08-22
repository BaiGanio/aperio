// tests/lib/routes/github-webhook.test.js
// Tests HMAC verification + ledger upsert end-to-end. Uses the invoke() helper
// to call the Express router directly — no live HTTP server. req.rawBody and
// req.body are pre-set on the mock request to simulate express.json's verify hook.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express, { Router } from "express";
import { mountGithubWebhookRoutes } from "../../../lib/routes/api-github-webhook.js";
import { createNetGuard, buildAllowedHosts } from "../../../lib/helpers/netGuard.js";
import { createAuthGuard } from "../../../lib/helpers/authGuard.js";

// ─── Invoke helper ────────────────────────────────────────────────────────────

function invoke(router, method, url, { body = null, headers = {}, params = {}, rawBody = null } = {}) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url, path: url, params,
      body: body != null ? structuredClone(body) : undefined,
      rawBody: rawBody,
      headers: { ...headers },
      baseUrl: "", originalUrl: url,
      ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
      get: (name) => {
        const key = name.toLowerCase();
        return req.headers[key];
      },
    };
    const res = {
      _status: 200,
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
      end()        { resolve({ status: this._status, body: null }); },
      setHeader()  { return this; },
      getHeader()  {},
      set()        { return this; },
      on()         { return this; },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SECRET = "test-webhook-secret";

function sign(body) {
  return "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

let router, upserts;

function post(body, { signature, event = "issues" } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const rawBuf = Buffer.from(raw);
  const headers = { "x-github-event": event };
  if (signature !== null) headers["x-hub-signature-256"] = signature ?? sign(raw);

  return invoke(router, "POST", "/github/webhook", {
    body: typeof body === "string" ? JSON.parse(body) : body,
    headers,
    rawBody: rawBuf,
  });
}

const ISSUE_EVENT = {
  action: "opened",
  issue: { number: 7, title: "Hello", state: "open", updated_at: "2026-06-10T00:00:00Z" },
  repository: { full_name: "octocat/hello" },
};

// ─── Route setup ──────────────────────────────────────────────────────────────

before(() => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  upserts = [];
  const store = {
    async upsertIssue(row) { upserts.push(row); },
    async getSetting() { return null; },
  };
  router = Router();
  mountGithubWebhookRoutes(router, { store });
});

after(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
});

// =============================================================================

describe("github webhook", () => {
  test("valid signature on issues/opened upserts a pending row", async () => {
    const res = await post(ISSUE_EVENT);
    assert.equal(res.status, 204);
    assert.equal(upserts.length, 1);
    assert.deepEqual(upserts[0], {
      repo: "octocat/hello", number: 7, title: "Hello", state: "open", updatedAt: "2026-06-10T00:00:00Z",
    });
  });

  test("bad signature → 401, no upsert", async () => {
    upserts.length = 0;
    const res = await post(ISSUE_EVENT, { signature: "sha256=deadbeef" });
    assert.equal(res.status, 401);
    assert.equal(upserts.length, 0);
  });

  test("non-issue event → 204 no-op", async () => {
    upserts.length = 0;
    const res = await post({ zen: "hi" }, { event: "ping" });
    assert.equal(res.status, 204);
    assert.equal(upserts.length, 0);
  });

  test("issues event with a non-capture action → 204 no-op", async () => {
    upserts.length = 0;
    const res = await post({ ...ISSUE_EVENT, action: "labeled" });
    assert.equal(res.status, 204);
    assert.equal(upserts.length, 0);
  });
});

// ─── Full middleware chain (netGuard → authGuard → route) ─────────────────────
// F-R2-05: netGuard's X-Aperio-Client requirement previously blocked every real
// GitHub webhook delivery before the route's own HMAC check ran, since GitHub
// has no way to set that header. Runs a real HTTP request through the actual
// chain server.js wires up, not just the isolated router.

describe("github webhook — full middleware chain", () => {
  let server, baseUrl, chainUpserts;

  before(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    chainUpserts = [];
    const store = {
      async upsertIssue(row) { chainUpserts.push(row); },
      async getSetting() { return null; },
    };

    const app = express();
    app.use(createNetGuard({ allowedHosts: buildAllowedHosts("127.0.0.1") }));
    app.use(createAuthGuard());
    app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
    const apiRouter = Router();
    mountGithubWebhookRoutes(apiRouter, { store });
    app.use("/api", apiRouter);

    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    await new Promise((resolve) => server.close(resolve));
  });

  test("valid-HMAC delivery with no X-Aperio-Client header reaches and is accepted by the route", async () => {
    const raw = JSON.stringify(ISSUE_EVENT);
    const res = await fetch(`${baseUrl}/api/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": sign(raw),
        // deliberately no X-Aperio-Client — GitHub can never send it
      },
      body: raw,
    });
    assert.equal(res.status, 204);
    assert.equal(chainUpserts.length, 1);
    assert.deepEqual(chainUpserts[0], {
      repo: "octocat/hello", number: 7, title: "Hello", state: "open", updatedAt: "2026-06-10T00:00:00Z",
    });
  });

  test("other state-changing /api/* routes still require X-Aperio-Client (exemption is scoped to the webhook path only)", async () => {
    const res = await fetch(`${baseUrl}/api/some-other-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "client_header_required");
  });
});
