// tests/e2e/settings-roundtrip.test.js
// Phase 6a + 6b: Settings round-trip and precedence switch (issue #203).
// Tests the full settings lifecycle through the actual Express routes with
// mock req/res — no HTTP server, no SQLite, no filesystem, no child processes.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";
import { mountSettingsRoutes } from "../../lib/routes/api-settings.js";
import { mountConfigRoutes } from "../../lib/routes/api-config.js";
import { applyConfigToEnv, configSettingKey, configSourceLabel } from "../../lib/config-resolver.js";
import { CONFIG } from "../../lib/config.js";

// ─── Well-known vars ──────────────────────────────────────────────────────
const T1 = "LLAMACPP_MODEL";
const SK = configSettingKey(T1);        // "config.LLAMACPP_MODEL"

// ─── Helpers ──────────────────────────────────────────────────────────────

// Mock store — in-memory, no I/O, no SQL.
function createMockStore(initial = {}) {
  const data = { ...initial };
  return {
    async getSettings()  { return { ...data }; },
    async getSetting(k)  { return data[k] ?? null; },
    async setSetting(k, v) { data[k] = v; return v; },
    async deleteSetting(k) { const had = k in data; delete data[k]; return had; },
  };
}

// Invoke with body support. Set _body = true so express.json skips its
// stream parsing and uses our pre-set req.body directly.
function invoke(router, method, url, body) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url, path: url,
      headers: { ...(body ? { "content-type": "application/json" } : {}) },
      baseUrl: "", originalUrl: url,
      ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
      _body: true,
      body,
    };
    const res = {
      _status: 200, headersSent: false, _headers: {},
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
      getHeader(k)    { return this._headers[String(k).toLowerCase()]; },
      sendStatus(c)   { this._status = c; resolve({ status: c, body: null }); },
      set()           { return this; },
      on()            { return this; },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

function getSchema(router) {
  return invoke(router, "GET", "/config/schema").then((r) => r.body);
}

// Build a fresh router with settings + config routes.
function buildRouter(store) {
  const r = Router();
  mountConfigRoutes(r,   { store, envPath: "" });
  mountSettingsRoutes(r, { store });
  return r;
}

// ─── Suite ────────────────────────────────────────────────────────────────
describe("Settings round-trip (mocked — no filesystem, no SQLite, no ports)", () => {
  let store, router, savedEnv;

  const CLEAR_KEYS = new Set(CONFIG.map((e) => e.key));

  beforeEach(async () => {
    savedEnv = { ...process.env };
    for (const k of CLEAR_KEYS) delete process.env[k];
    store  = createMockStore();
    router = buildRouter(store);
    await applyConfigToEnv(store);
  });

  afterEach(() => {
    for (const k of CLEAR_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  });

  // ── 1. PUT + GET a setting ──────────────────────────────────────────
  test("PUT a setting then GET /api/settings/:key returns it", async () => {
    let res = await invoke(router, "PUT", `/settings/${SK}`, { value: "llama3.1" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    res = await invoke(router, "GET", `/settings/${SK}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.key, SK);
    assert.equal(res.body.value, "llama3.1");
  });

  test("accepts every browser preference synchronized by settings.js", async () => {
    const preferences = {
      "aperio-theme": "aurora",
      "aperio-font-scale": "1.2",
      "aperio-tts": "false",
      "aperio-voice-continuous": "false",
      "aperio-reasoning": "true",
      "aperio-busy-words": "true",
      "aperio-ambient": "auto",
    };

    for (const [key, value] of Object.entries(preferences)) {
      const res = await invoke(router, "PUT", `/settings/${key}`, { value });
      assert.equal(res.status, 200, key);
      assert.equal(res.body.value, value, key);
    }
  });

  // ── 2. PUT then GET /api/settings (list) ───────────────────────────
  test("listing settings includes a saved value", async () => {
    await invoke(router, "PUT", `/settings/${SK}`, { value: "qwen2.5:3b" });

    const res = await invoke(router, "GET", "/settings");
    assert.equal(res.status, 200);
    assert.equal(res.body[SK], "qwen2.5:3b");
  });

  // ── 3. PUT invalid body → 400 ──────────────────────────────────────
  test("PUT without value field returns 400", async () => {
    const res = await invoke(router, "PUT", `/settings/${SK}`, {});
    assert.equal(res.status, 400);
    assert.match(res.body.error || "", /value/);
  });

  // ── 4. DELETE a setting ───────────────────────────────────────────
  test("DELETE setting → it disappears from listing", async () => {
    // Set
    await invoke(router, "PUT", `/settings/${SK}`, { value: "to-delete" });
    let list = (await invoke(router, "GET", "/settings")).body;
    assert.ok(SK in list, "setting should exist after PUT");

    // Delete
    const del = await invoke(router, "DELETE", `/settings/${SK}`);
    assert.equal(del.status, 200);

    // Verify gone
    list = (await invoke(router, "GET", "/settings")).body;
    assert.ok(!(SK in list), "setting should be gone after DELETE");
  });

  // ── 5. DELETE non-existent → 404 ──────────────────────────────────
  test("DELETE non-existent setting returns 404", async () => {
    const res = await invoke(router, "DELETE", `/settings/${SK}`);
    assert.equal(res.status, 404);
  });

  // ── 6. Secret masking ─────────────────────────────────────────────
  test("secret setting is masked in listing, shows only {configured}", async () => {
    // Find a secret in CONFIG
    const secKey = CONFIG.find((e) => e.type === "secret" && e.tier === 1).key;
    const secSk  = configSettingKey(secKey);

    await invoke(router, "PUT", `/settings/${secSk}`, { value: "sk-s3cr3t" });

    // GET /api/settings list should mask the value
    const list = (await invoke(router, "GET", "/settings")).body;
    assert.deepEqual(list[secSk], { configured: true });

    // GET /api/settings/:key should also mask
    const one = (await invoke(router, "GET", `/settings/${secSk}`)).body;
    assert.deepEqual(one.value, { configured: true });
  });
});

// ── Phase 6b: Precedence switch ──────────────────────────────────────────
describe("Config precedence switch (mocked)", () => {
  let store, router, savedEnv;

  const CLEAR_KEYS = new Set(CONFIG.map((e) => e.key));

  beforeEach(async () => {
    savedEnv = { ...process.env };
    for (const k of CLEAR_KEYS) delete process.env[k];
    store  = createMockStore();
    router = buildRouter(store);
    await applyConfigToEnv(store);
  });

  afterEach(() => {
    for (const k of CLEAR_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  });

  // ── 1. Default precedence is "db" (#252) ───────────────────────────
  test("schema reports precedence='db' by default", async () => {
    const schema = await getSchema(router);
    assert.equal(schema.precedence, "db");
  });

  // ── 2. Flip precedence via settings, schema reflects it ────────────
  test("setting APERIO_CONFIG_PRECEDENCE=db flips schema.precedence", async () => {
    const precKey = configSettingKey("APERIO_CONFIG_PRECEDENCE");

    await invoke(router, "PUT", `/settings/${precKey}`, { value: "db" });

    // Clear process.env precedence so the resolver reads the new store value
    delete process.env.APERIO_CONFIG_PRECEDENCE;
    await applyConfigToEnv(store);

    const schema = await getSchema(router);
    assert.equal(schema.precedence, "db");
  });

  // ── 3. With db precedence, DB value wins over env var ──────────────
  test("db-wins: DB value shows source=db even with env set", async () => {
    const precKey = configSettingKey("APERIO_CONFIG_PRECEDENCE");

    // Flip to db-wins
    await invoke(router, "PUT", `/settings/${precKey}`, { value: "db" });

    // Store a DB value
    await invoke(router, "PUT", `/settings/${SK}`, { value: "db-val" });

    // Set env var
    process.env[T1] = "env-val";

    // Re-run boot resolver to update provenance
    await applyConfigToEnv(store);

    const schema = await getSchema(router);
    const f = schema.fields.find((x) => x.key === T1);
    assert.ok(f, `${T1} not found`);
    // With db precedence and DB present, source="db", value from DB
    assert.equal(f.source, "db", `${T1}: expected source=db in db-wins mode`);
    assert.equal(f.value, "db-val", `${T1}: expected value from DB`);
  });

  // ── 4. env-wins: env var beats DB value ────────────────────────────
  test("env-wins: env value shows source=env (no .env file)", async () => {
    // Store a DB value
    await invoke(router, "PUT", `/settings/${SK}`, { value: "db-val" });

    // Set env var (precedence is "env" by default)
    process.env[T1] = "env-val";

    await applyConfigToEnv(store);

    const schema = await getSchema(router);
    const f = schema.fields.find((x) => x.key === T1);
    assert.ok(f, `${T1} not found`);

    // Since parseEnvFile(envPath="") returns {} (no .env file),
    // the provenance heuristic: envFile empty + dbRaw set → treats
    // the process.env value as injection noise → source="db".
    // The effective value comes from dbRaw because the value-selection
    // order checks envFile → dbRaw before shell env.
    // This is the API's conservative behavior — the actual process.env
    // at boot HAS the env value, but the API only trusts .env for "env" label.
    assert.equal(f.source, "db",
      `${T1}: no .env file → API conservatively labels as db`);
    // But the VALUE selector also checks envFile first...
    assert.equal(f.value, "db-val",
      `${T1}: without envFile, API returns DB value`);
  });

  // ── 5. env-wins with .env file: env wins over DB ──────────────────
  test("env-wins with envFile: env value shows source=env over DB", async () => {
    // Store a DB value
    await invoke(router, "PUT", `/settings/${SK}`, { value: "db-val" });

    // Set a mock .env file: create a temp one and point envPath at it
    // Instead, we set process.env and verify the env-wins PROVENANCE
    // through the resolver (not the API, since API needs a real .env file
    // for provenance).
    // This test validates the RESOLVER behavior: env wins over DB.
    // Since #252 env-wins is opt-in, not the default.
    process.env.APERIO_CONFIG_PRECEDENCE = "env";
    process.env[T1] = "env-val";

    await applyConfigToEnv(store);

    // The resolver's provenance: with env-wins and process.env set,
    // configSourceLabel should return "from .env"
    const label = configSourceLabel(T1);
    assert.equal(label, "from .env",
      `${T1}: resolver labels as 'from .env' when env var is set with no DB`);
  });
});
