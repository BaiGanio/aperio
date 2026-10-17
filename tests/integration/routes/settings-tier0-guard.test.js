// tests/integration/routes/settings-tier0-guard.test.js
// Issue #530: PUT /api/settings/:key had no tier check, so a Tier-0
// secret/bootstrap key (POSTGRES_PASSWORD, APERIO_SESSION_KEY,
// APERIO_DB_ENCRYPT, ...) could be written into the DB even though
// config.js/AGENTS.md document those as env-only. Fix reuses
// config-resolver.js's EDITABLE_KEYS (Tier-1 only) to reject the write.

import { test, describe, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { mountSettingsRoutes } from "../../../lib/routes/api-settings.js";
import { configSettingKey } from "../../../lib/config-resolver.js";
import { CONFIG } from "../../../lib/config.js";

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

function fakeStore() {
  const m = new Map();
  return {
    async getSetting(k) { return m.has(k) ? m.get(k) : null; },
    async setSetting(k, v) { m.set(k, v); return v; },
    async getSettings() { return Object.fromEntries(m); },
    async deleteSetting(k) { return m.delete(k); },
  };
}

let router, store;

before(() => {
  mock.method(express, "json", () => (_req, _res, next) => next());
  store = fakeStore();
  router = Router();
  mountSettingsRoutes(router, { store });
});

after(() => {
  mock.restoreAll();
});

const put = (k, value) => invoke(router, "PUT", `/settings/${k}`, { body: { value }, params: { key: k } });
const getOne = (k) => invoke(router, "GET", `/settings/${k}`, { params: { key: k } }).then((r) => r.body);

describe("PUT /api/settings/:key — Tier-0 guard (#530)", () => {
  test("writing a Tier-0 secret key (POSTGRES_PASSWORD) is rejected with 400", async () => {
    const key = configSettingKey("POSTGRES_PASSWORD");
    const res = await put(key, "hax0red");
    assert.equal(res.status, 400);
    assert.match(res.body.error, /env-only/);

    // Confirm nothing was written to the store (masked GET reports unconfigured).
    const stored = await getOne(key);
    assert.deepEqual(stored.value, { configured: false });
  });

  test("writing other Tier-0 keys (APERIO_SESSION_KEY, APERIO_DB_ENCRYPT) is rejected", async () => {
    for (const bare of ["APERIO_SESSION_KEY", "APERIO_DB_ENCRYPT"]) {
      const key = configSettingKey(bare);
      const res = await put(key, "evil");
      assert.equal(res.status, 400, bare);
      assert.match(res.body.error, /env-only/, bare);
    }
  });

  test("every Tier-0 registry key is rejected, except a deliberate editable:true opt-out", async () => {
    const tier0Keys = CONFIG.filter((e) => e.tier === 0 && !e.editable).map((e) => configSettingKey(e.key));
    assert.ok(tier0Keys.length > 0, "expected at least one Tier-0 key in the registry");
    for (const key of tier0Keys) {
      const res = await put(key, "nope");
      assert.equal(res.status, 400, key);
    }
  });

  test("a Tier-0 var with editable:true (APERIO_CONFIG_PRECEDENCE) is still writable", async () => {
    // Schema/UI-documented exception: tier 0 but explicitly opted in via
    // `editable: true` in the registry. Must not be swept up by the guard.
    const entry = CONFIG.find((e) => e.key === "APERIO_CONFIG_PRECEDENCE");
    assert.equal(entry.tier, 0, "test assumption: still tier 0 in the registry");
    assert.equal(entry.editable, true, "test assumption: still opted in via editable:true");

    const key = configSettingKey("APERIO_CONFIG_PRECEDENCE");
    const res = await put(key, "env");
    assert.equal(res.status, 200);
    assert.equal(res.body.value, "env");
  });

  test("existing Tier-1 write behavior still works", async () => {
    const key = configSettingKey("LLAMACPP_MODEL");
    const res = await put(key, "qwen2.5-coder-7b");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const stored = await getOne(key);
    assert.equal(stored.value, "qwen2.5-coder-7b");
  });

  test("built-in (non-registry) keys are unaffected", async () => {
    const res = await put("triage.repos", ["octocat/hello"]);
    assert.equal(res.status, 200);
  });

  test("unmanaged config.* keys with no registry entry are unaffected", async () => {
    const res = await put("config.OLLAMA_MODEL", "qwen3:14b");
    assert.equal(res.status, 200);
  });
});
