// tests/lib/routes/config-schema.test.js
// GET /api/config/schema (issue #167, Phase 2): the registry decorated with each
// var's effective value (DB > env > default). Secrets must report only
// { configured } and never their value; Tier-0 vars must be flagged read-only.
//
// Uses the invoke() helper to call the Express router directly — no live HTTP
// server, no real port binding on the user's machine.

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Router } from "express";
import { mountConfigRoutes } from "../../../lib/routes/api-config.js";
import { applyConfigToEnv, configSettingKey, configSourceOf } from "../../../lib/config-resolver.js";
import { CONFIG } from "../../../lib/config.js";

// ─── Invoke helper ────────────────────────────────────────────────────────────
// Calls the Express router directly with mock req/res, no HTTP server needed.

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

let store, envFile, tmp;

function fakeStore(settings = {}) {
  return { async getSettings() { return { ...settings }; } };
}

// Rewrite the fixture .env the route parses for unmanaged-var detection. Read at
// request time, so a rewrite takes effect without remounting.
const setEnvFile = (contents = "") => writeFileSync(envFile, contents);

const getSchema = () => invoke(router, "GET", "/config/schema").then(r => r.body);
const field = (schema, key) => schema.fields.find(f => f.key === key);

// A Tier-1 non-secret, a Tier-1 secret, and a Tier-0 key for assertions.
const T1   = "LLAMACPP_MODEL";
const SEC  = CONFIG.find(e => e.type === "secret" && e.tier === 1).key;
const T0   = "PORT";

// ─── Route setup ──────────────────────────────────────────────────────────────
// One router for the entire suite. store.current is swapped per-test to control
// getSettings() output, so mountConfigRoutes sees the latest store.

let router;
let savedEnv;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "aperio-cfg-"));
  envFile = join(tmp, ".env");
  setEnvFile("");

  // Boot env so applyConfigToEnv works (it needs DB_BACKEND set).
  if (!process.env.DB_BACKEND) process.env.DB_BACKEND = "sqlite";

  router = Router();
  store = { current: fakeStore() };
  // Indirect through a mutable holder so individual tests can swap settings.
  mountConfigRoutes(router, {
    store: { getSettings: () => store.current.getSettings() },
    envPath: envFile,
  });
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  savedEnv = { ...process.env };
  setEnvFile("");
});

afterEach(() => {
  process.env = savedEnv;
});

// =============================================================================

describe("GET /api/config/schema", () => {
  test("returns sections and one field per registry entry", async () => {
    store.current = fakeStore();
    const schema = await getSchema();
    assert.ok(Array.isArray(schema.sections) && schema.sections.length);
    assert.equal(schema.fields.length, CONFIG.length);
    assert.ok(!schema.sections.some((s) => s.id === "imported"), "no imported section when .env is clean");
  });

  test("DB value wins over env and default", async () => {
    process.env[T1] = "from-env";
    store.current = fakeStore({ [configSettingKey(T1)]: "from-db" });
    const f = field(await getSchema(), T1);
    assert.equal(f.value, "from-db");
    assert.equal(f.source, "db");
  });

  test("env value used when DB unset", async () => {
    process.env[T1] = "from-env";
    store.current = fakeStore();
    const f = field(await getSchema(), T1);
    assert.equal(f.value, "from-env");
    assert.equal(f.source, "env");
  });

  test("default used when neither DB nor env set", async () => {
    delete process.env[T1];
    store.current = fakeStore();
    const f = field(await getSchema(), T1);
    assert.equal(f.source, "default");
    assert.equal(f.value, CONFIG.find(e => e.key === T1).default);
  });

  test("secret never returns a value, only { configured }", async () => {
    process.env[SEC] = "sk-supersecret";
    store.current = fakeStore({ [configSettingKey(SEC)]: "sk-fromdb-secret" });
    const schema = await getSchema();
    const f = field(schema, SEC);
    assert.equal(f.secret, true);
    assert.equal(f.configured, true);
    assert.equal(f.value, undefined);
    assert.doesNotMatch(JSON.stringify(schema), /supersecret|fromdb-secret/);
  });

  test("unset secret reports configured:false", async () => {
    delete process.env[SEC];
    store.current = fakeStore();
    assert.equal(field(await getSchema(), SEC).configured, false);
  });

  test("Tier-0 vars are flagged read-only", async () => {
    store.current = fakeStore();
    const schema = await getSchema();
    assert.equal(field(schema, T0).editable, false);
    assert.equal(field(schema, T1).editable, true);
  });

  // ── Phase 2b: unmanaged .env vars → "Imported" section ─────────────────────
  test("unmanaged .env var appears as an editable imported field", async () => {
    store.current = fakeStore();
    setEnvFile("MY_CUSTOM_VAR=hello\nLLAMACPP_MODEL=ignored-managed\n");
    const schema = await getSchema();
    assert.ok(schema.sections.some((s) => s.id === "imported"));
    const f = field(schema, "MY_CUSTOM_VAR");
    assert.equal(f.section, "imported");
    assert.equal(f.editable, true);
    assert.equal(f.value, "hello");
    // A var already in the registry must NOT be duplicated into imported.
    assert.equal(schema.fields.filter((x) => x.key === "LLAMACPP_MODEL").length, 1);
  });

  test("unmanaged secret-looking var is masked, value never echoed", async () => {
    store.current = fakeStore();
    setEnvFile("CUSTOM_API_KEY=sk-do-not-leak\n");
    const schema = await getSchema();
    const f = field(schema, "CUSTOM_API_KEY");
    assert.equal(f.secret, true);
    assert.equal(f.configured, true);
    assert.equal(f.value, undefined);
    assert.doesNotMatch(JSON.stringify(schema), /do-not-leak/);
  });

  test("a saved imported var reflects the DB value (DB > env)", async () => {
    setEnvFile("MY_CUSTOM_VAR=from-env\n");
    store.current = fakeStore({ [configSettingKey("MY_CUSTOM_VAR")]: "from-db" });
    const f = field(await getSchema(), "MY_CUSTOM_VAR");
    assert.equal(f.value, "from-db");
    assert.equal(f.source, "db");
  });
                                          
  // ── #182: cross-field warnings (LLAMACPP_CTX vs LLAMACPP_SERVE_CTX) ─────
  test("warns when LLAMACPP_CTX exceeds LLAMACPP_SERVE_CTX for llamacpp", async () => {
    process.env.AI_PROVIDER = "llamacpp";
    process.env.LLAMACPP_CTX = "98304";
    process.env.LLAMACPP_SERVE_CTX = "32768";
    store.current = fakeStore();
    const schema = await getSchema();
    assert.ok(Array.isArray(schema.warnings) && schema.warnings.length === 1);
    assert.match(schema.warnings[0].message, /98304.*32768/);
    assert.deepEqual(schema.warnings[0].keys, ["LLAMACPP_CTX", "LLAMACPP_SERVE_CTX"]);
  });

  test("no warning when the windows are consistent", async () => {
    process.env.AI_PROVIDER = "llamacpp";
    process.env.LLAMACPP_CTX = "16384";
    process.env.LLAMACPP_SERVE_CTX = "32768";
    store.current = fakeStore();
    assert.deepEqual((await getSchema()).warnings, []);
  });

  // ── #182 follow-up: CLI ↔ API source-label cross-consistency ─────────────────
  // The CLI's boot provenance snapshot (configSourceOf) and the web Settings
  // panel's request-time source labels (field.source) must agree for the same
  // var under the same precedence mode. These tests guard against drift when
  // the two sites are refactored to share a single precedence-decision function.
  describe("provenance cross-consistency (CLI vs API)", () => {
    // Align process.env with the .env file contents so both the resolver's
    // pre-injection snapshot and the API's live .env parse see the same state.
    function envAlign(key, value) {
      if (value == null) { delete process.env[key]; setEnvFile(""); }
      else               { process.env[key] = value; setEnvFile(`${key}=${value}\n`); }
    }

    // Run the boot resolver (what the CLI does at startup) and compare
    // configSourceOf(key) against the API's field.source for the same key.
    async function assertSourceMatch(key, expectedSource) {
      await applyConfigToEnv(store.current);
      const cliSource = configSourceOf(key);
      const schema = await getSchema();
      const f = schema.fields.find((x) => x.key === key);
      assert.ok(f, `field ${key} not found in schema`);
      assert.equal(cliSource, expectedSource,
        `CLI source for ${key}: expected ${expectedSource}, got ${cliSource}`);
      assert.equal(f.source, expectedSource,
        `API source for ${key}: expected ${expectedSource}, got ${f.source}`);
    }

    test("env-wins: .env value present, no DB → both report 'env'", async () => {
      delete process.env.APERIO_CONFIG_PRECEDENCE;
      envAlign(T1, "from-env");
      store.current = fakeStore();
      await assertSourceMatch(T1, "env");
    });

    test("env-wins: no .env, DB value present → both report 'db'", async () => {
      delete process.env.APERIO_CONFIG_PRECEDENCE;
      envAlign(T1, null);
      store.current = fakeStore({ [configSettingKey(T1)]: "from-db" });
      await assertSourceMatch(T1, "db");
    });

    test("env-wins: neither env nor DB set → both report 'default'", async () => {
      delete process.env.APERIO_CONFIG_PRECEDENCE;
      envAlign(T1, null);
      store.current = fakeStore();
      await assertSourceMatch(T1, "default");
    });

    test("env-wins: Tier-0 var (.env present, DB present) → both 'env', never 'db'", async () => {
      delete process.env.APERIO_CONFIG_PRECEDENCE;
      envAlign(T0, "31337");
      store.current = fakeStore({ [configSettingKey(T0)]: "9999" });
      await assertSourceMatch(T0, "env");
    });

    test("db-wins: DB value present → both report 'db' even when .env is set", async () => {
      process.env.APERIO_CONFIG_PRECEDENCE = "db";
      envAlign(T1, "from-env");
      store.current = fakeStore({ [configSettingKey(T1)]: "from-db" });
      await assertSourceMatch(T1, "db");
    });

    test("db-wins: no DB value → falls through to env → both report 'env'", async () => {
      process.env.APERIO_CONFIG_PRECEDENCE = "db";
      envAlign(T1, "from-env");
      store.current = fakeStore();
      await assertSourceMatch(T1, "env");
    });

    test("secret (env-wins, .env present, DB present) → both report 'env'", async () => {
      process.env.APERIO_CONFIG_PRECEDENCE = "env";   // opt-in since #252
      envAlign(SEC, "sk-from-env");
      store.current = fakeStore({ [configSettingKey(SEC)]: "sk-from-db" });
      await assertSourceMatch(SEC, "env");
    });

    test("secret (env-wins, no .env, DB present) → both report 'db'", async () => {
      delete process.env.APERIO_CONFIG_PRECEDENCE;
      envAlign(SEC, null);
      store.current = fakeStore({ [configSettingKey(SEC)]: "sk-from-db" });
      await assertSourceMatch(SEC, "db");
    });
  });
});
