// tests/lib/routes/settings-mask.test.js
// Secret settings (github.token, github.webhook_secret) must be write-only over
// the API: a GET reports only whether one is set, never the value. Boots a tiny
// express app with the real settings routes over an in-memory fake store.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { mountSettingsRoutes } from "../../../lib/routes/api-settings.js";

let server, base;

function fakeStore() {
  const m = new Map();
  return {
    async getSetting(k) { return m.has(k) ? m.get(k) : null; },
    async setSetting(k, v) { m.set(k, v); return v; },
    async getSettings() { return Object.fromEntries(m); },
    async deleteSetting(k) { return m.delete(k); },
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  const router = Router();
  mountSettingsRoutes(router, { store: fakeStore() });
  app.use("/api", router);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

const put = (k, value) => fetch(`${base}/api/settings/${k}`, {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }),
});
const getOne = (k) => fetch(`${base}/api/settings/${k}`).then(r => r.json());
const getAll = () => fetch(`${base}/api/settings`).then(r => r.json());

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
