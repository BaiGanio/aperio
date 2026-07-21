// tests/lib/routes/settings-mask.test.js
// Secret settings (github.token, github.webhook_secret) must be write-only over
// the API: a GET reports only whether one is set, never the value. Uses the
// invoke() helper to call the Express router directly — no live HTTP server.

import { test, describe, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { mountSettingsRoutes } from "../../../lib/routes/api-settings.js";

// ─── Invoke helper ────────────────────────────────────────────────────────────
// Calls the Express router directly with mock req/res. req.body is pre-set;
// express.json is mocked to pass-through since there's no real HTTP stream.

function invoke(router, method, url, { body = null, params = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url, path: url, params,
      body: body != null ? structuredClone(body) : undefined,
      headers: {},
      baseUrl: "", originalUrl: url,
      ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
      get: () => undefined,
    };
    const res = {
      _status: 200,
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
      setHeader()  { return this; },
      getHeader()  {},
      set()        { return this; },
      on()         { return this; },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

// ─── Fake store ───────────────────────────────────────────────────────────────

function fakeStore() {
  const m = new Map();
  return {
    async getSetting(k) { return m.has(k) ? m.get(k) : null; },
    async setSetting(k, v) { m.set(k, v); return v; },
    async getSettings() { return Object.fromEntries(m); },
    async deleteSetting(k) { return m.delete(k); },
  };
}

// ─── Route setup ──────────────────────────────────────────────────────────────
// Mock express.json before mountSettingsRoutes calls it, so the inline
// middleware on PUT /settings/:key becomes a no-op pass-through.

let router;

before(() => {
  mock.method(express, "json", () => (_req, _res, next) => next());
  router = Router();
  mountSettingsRoutes(router, { store: fakeStore() });
});

after(() => {
  mock.restoreAll();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const put = (k, value) => invoke(router, "PUT", `/settings/${k}`, { body: { value }, params: { key: k } });
const getOne = (k) => invoke(router, "GET", `/settings/${k}`, { params: { key: k } }).then(r => r.body);
const getAll = () => invoke(router, "GET", "/settings").then(r => r.body);

// =============================================================================

describe("settings secret masking", () => {
  test("a secret is stored but never returned in plaintext", async () => {
    await put("github.token", "ghp_supersecret");
    const one = await getOne("github.token");
    assert.deepEqual(one.value, { configured: true });
    assert.doesNotMatch(JSON.stringify(one), /supersecret/);

    const all = await getAll();
    assert.deepEqual(all["github.token"], { configured: true });
    assert.doesNotMatch(JSON.stringify(all), /supersecret/);
  });

  test("unset secret reports configured:false", async () => {
    const one = await getOne("github.webhook_secret");
    assert.deepEqual(one.value, { configured: false });
  });

  test("registry secret keys (config.*) are masked too", async () => {
    await put("config.ANTHROPIC_API_KEY", "sk-ant-supersecret");
    const one = await getOne("config.ANTHROPIC_API_KEY");
    assert.deepEqual(one.value, { configured: true });
    const all = await getAll();
    assert.deepEqual(all["config.ANTHROPIC_API_KEY"], { configured: true });
    assert.doesNotMatch(JSON.stringify({ one, all }), /supersecret/);
  });

  test("unmanaged secret-looking config.* key is masked (Phase 2b)", async () => {
    // No registry entry, but the name infers a secret — must not leak.
    await put("config.CUSTOM_API_KEY", "sk-imported-supersecret");
    const one = await getOne("config.CUSTOM_API_KEY");
    assert.deepEqual(one.value, { configured: true });
    const all = await getAll();
    assert.deepEqual(all["config.CUSTOM_API_KEY"], { configured: true });
    assert.doesNotMatch(JSON.stringify({ one, all }), /supersecret/);
  });

  test("non-secret config keys (config.*) are returned as-is", async () => {
    await put("config.OLLAMA_MODEL", "qwen3:14b");
    const one = await getOne("config.OLLAMA_MODEL");
    assert.equal(one.value, "qwen3:14b");
  });

  test("non-secret settings are returned as-is", async () => {
    await put("triage.repos", ["octocat/hello", "my-project"]);
    const one = await getOne("triage.repos");
    assert.deepEqual(one.value, ["octocat/hello", "my-project"]);
  });
});
