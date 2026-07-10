// tests/e2e/config-provenance.test.js
// Mock-e2e test for config provenance (issue #203, Phase 2a).
// Uses the Express Router directly with mock req/res — no HTTP server, no filesystem,
// no real SQLite database, and no child processes. All state lives in memory.
//
// Tests the round-trip: store.setSetting → boot restart → config source labels
// accurately reflect where values came from ("db", "env", "default").

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";
import { mountConfigRoutes } from "../../lib/routes/api-config.js";
import { mountSettingsRoutes } from "../../lib/routes/api-settings.js";
import { applyConfigToEnv, configSettingKey, configSourceOf } from "../../lib/config-resolver.js";
import { CONFIG } from "../../lib/config.js";

// ─── Well-known vars ──────────────────────────────────────────────────────
const T1         = "LLAMACPP_MODEL";
const T0         = "PORT";
const T1_DEFAULT = CONFIG.find((e) => e.key === T1).default;

// ─── Helpers ──────────────────────────────────────────────────────────────
// invoke() calls the Express Router directly with mock req/res —
// no HTTP server, no port binding, no supertest.

function invoke(router, method, url) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url, path: url,
      headers: {}, baseUrl: "", originalUrl: url,
      ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
    };
    const res = {
      _status: 200, headersSent: false, _headers: {},
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
      getHeader(k)    { return this._headers[String(k).toLowerCase()]; },
      set()           { return this; },
      on()            { return this; },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

// createMockStore() returns an in-memory store that mirrors the real
// SqliteStore/PgStore surface. No files, no SQL, no I/O.
function createMockStore(initial = {}) {
  const data = { ...initial };
  return {
    async getSettings()  { return { ...data }; },
    async getSetting(k)  { return data[k] ?? null; },
    async setSetting(k, v) { data[k] = v; return v; },
    async deleteSetting(k) { delete data[k]; return true; },
  };
}

// Mount the config + settings routes on a fresh router.
function buildRouter(store) {
  const router = Router();
  // envPath="" prevents parseEnvFile from reaching the real project .env.
  // readFileSync("") throws ENOENT → parseEnvFile catches it → returns {}.
  mountConfigRoutes(router,   { store, envPath: "" });
  mountSettingsRoutes(router, { store });
  return router;
}

// ─── Bootstrap helper ─────────────────────────────────────────────────────
// Simulates a cold boot: runs applyConfigToEnv with the given store, which
// populates the global _sources provenance map from the store's persisted
// settings + current process.env.
async function simulateBoot(store) {
  // Clear the provenance map so the boot writes fresh labels
  await applyConfigToEnv(store);
}

// ─── Suite ────────────────────────────────────────────────────────────────
describe("Config provenance (mocked — no filesystem, no SQLite, no ports)", () => {
  let store, router, savedEnv;

  // Explicitly manage env changes: each test clears config-relevant env vars
  // before running, then sets only what it needs.  This avoids the Node.js
  // limitation where 'process.env = savedEnv' doesn't cleanly delete keys
  // that were added during the test.
  const CONFIG_KEYS = new Set(CONFIG.map((e) => e.key));

  /** Remove every config-related env var so the test starts clean. */
  function clearConfigEnv() {
    for (const k of CONFIG_KEYS) delete process.env[k];
  }

  beforeEach(() => {
    savedEnv = { ...process.env };
    clearConfigEnv();
  });

  afterEach(() => {
    // Restore the original env the way Node.js can handle it:
    // delete everything we might have touched, then copy back.
    clearConfigEnv();
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  });

  // ── 1. Default source ────────────────────────────────────────────────
  test("unset vars report source='default' with correct default value", async () => {
    store  = createMockStore();
    router = buildRouter(store);
    await simulateBoot(store);

    const { status, body } = await invoke(router, "GET", "/config/schema");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.fields) && body.fields.length > 0);

    // Unset Tier-1 var
    const f = body.fields.find((x) => x.key === T1);
    assert.ok(f, `field "${T1}" not found`);
    assert.equal(f.source, "default", `${T1}: expected source=default`);
    assert.equal(f.value, T1_DEFAULT, `${T1}: expected "${T1_DEFAULT}"`);
    assert.equal(f.editable, true, `${T1}: expected editable=true (Tier-1)`);

    // Unset Tier-0 var
    const t0 = body.fields.find((x) => x.key === T0);
    assert.ok(t0, `field "${T0}" not found`);
    assert.equal(t0.source, "default", `${T0}: expected source=default`);
    assert.equal(t0.editable, false, `${T0}: expected editable=false (Tier-0)`);
  });

  // ── 2. DB source via settings API + simulated restart ────────────────
  test("set DB value via settings API then re-boot → source='db' with new value", async () => {
    const DB_VAL = "llama3.1";
    store  = createMockStore();
    router = buildRouter(store);

    // Store a setting as if the user clicked Save in the Config panel
    await store.setSetting(configSettingKey(T1), DB_VAL);

    // Simulate restart: re-run the boot resolver with the updated store
    await simulateBoot(store);

    const { status, body } = await invoke(router, "GET", "/config/schema");
    assert.equal(status, 200);
    assert.equal(body.fields.find((x) => x.key === T1).source, "db",
      `${T1}: expected source=db`);
    assert.equal(body.fields.find((x) => x.key === T1).value, DB_VAL,
      `${T1}: expected "${DB_VAL}"`);
  });

  // ── 3. Env source (no DB) ───────────────────────────────────────────
  test("env var only (no DB) → source='env' with value from env", async () => {
    const ENV_VAL = "env-model";
    process.env[T1] = ENV_VAL;

    store  = createMockStore();
    router = buildRouter(store);
    await simulateBoot(store);

    const { status, body } = await invoke(router, "GET", "/config/schema");
    assert.equal(status, 200);

    const f = body.fields.find((x) => x.key === T1);
    assert.ok(f, `field "${T1}" not found`);
    assert.equal(f.source, "env", `${T1}: expected source=env`);
    assert.equal(f.value, ENV_VAL, `${T1}: expected "${ENV_VAL}"`);
  });

  // ── 4. Tier-0 immunity ──────────────────────────────────────────────
  test("Tier-0 var never reports source='db' even when set in store", async () => {
    store  = createMockStore({ [configSettingKey(T0)]: "9999" });
    router = buildRouter(store);
    await simulateBoot(store);

    const { body } = await invoke(router, "GET", "/config/schema");
    const f = body.fields.find((x) => x.key === T0);
    assert.ok(f, `field "${T0}" not found`);
    assert.notEqual(f.source, "db", `${T0}: Tier-0 must never be source=db`);
    assert.ok(f.source === "default" || f.source === "env",
      `${T0}: expected source=default or env, got ${f.source}`);
  });

  // ── 5. Delete a DB setting → falls back to default ───────────────────
  test("delete DB-saved setting restores source='default'", async () => {
    store  = createMockStore({ [configSettingKey(T1)]: "to-delete" });
    router = buildRouter(store);
    await simulateBoot(store);

    // Verify DB value is present
    let body = (await invoke(router, "GET", "/config/schema")).body;
    assert.equal(body.fields.find((x) => x.key === T1).source, "db");

    // Delete the setting and clear the injected env var from the first boot
    await store.deleteSetting(configSettingKey(T1));
    delete process.env[T1];  // applyConfigToEnv injected this during first boot

    // Re-boot to re-resolve provenance
    await simulateBoot(store);

    body = (await invoke(router, "GET", "/config/schema")).body;
    assert.equal(body.fields.find((x) => x.key === T1).source, "default",
      `${T1}: expected source=default after delete`);
    assert.equal(body.fields.find((x) => x.key === T1).value, T1_DEFAULT,
      `${T1}: expected default value after delete`);
  });
});
