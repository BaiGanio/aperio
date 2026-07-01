// tests/lib/routes/config-schema.test.js
// GET /api/config/schema (issue #167, Phase 2): the registry decorated with each
// var's effective value (DB > env > default). Secrets must report only
// { configured } and never their value; Tier-0 vars must be flagged read-only.

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express, { Router } from "express";
import { mountConfigRoutes } from "../../../lib/routes/api-config.js";
import { applyConfigToEnv, configSettingKey, configSourceOf } from "../../../lib/config-resolver.js";
import { CONFIG } from "../../../lib/config.js";

let server, base, store, envFile;

function fakeStore(settings = {}) {
  return { async getSettings() { return { ...settings }; } };
}

// Rewrite the fixture .env the route parses for unmanaged-var detection. Read at
// request time, so a rewrite takes effect without remounting.
const setEnvFile = (contents = "") => writeFileSync(envFile, contents);

const getSchema = () => fetch(`${base}/api/config/schema`).then(r => r.json());
const field = (schema, key) => schema.fields.find(f => f.key === key);

// A Tier-1 non-secret, a Tier-1 secret, and a Tier-0 key for assertions.
const T1   = "OLLAMA_MODEL";
const SEC  = CONFIG.find(e => e.type === "secret" && e.tier === 1).key; // e.g. ANTHROPIC_API_KEY
const T0   = "PORT";

describe("GET /api/config/schema", () => {
  let savedEnv;
  afterEach(() => { process.env = savedEnv; });

  let tmp;
  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "aperio-cfg-"));
    envFile = join(tmp, ".env");
    setEnvFile("");
    const app = express();
    store = { current: fakeStore() };
    const router = Router();
    // Indirect through a mutable holder so individual tests can swap settings.
    mountConfigRoutes(router, { store: { getSettings: () => store.current.getSettings() }, envPath: envFile });
    app.use("/api", router);
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { rmSync(tmp, { recursive: true, force: true }); return new Promise((r) => server.close(r)); });

  beforeEach(() => { savedEnv = { ...process.env }; setEnvFile(""); });

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
    setEnvFile("MY_CUSTOM_VAR=hello\nOLLAMA_MODEL=ignored-managed\n");
    const schema = await getSchema();
    assert.ok(schema.sections.some((s) => s.id === "imported"));
    const f = field(schema, "MY_CUSTOM_VAR");
    assert.equal(f.section, "imported");
    assert.equal(f.editable, true);
    assert.equal(f.value, "hello");
    // A var already in the registry must NOT be duplicated into imported.
    assert.equal(schema.fields.filter((x) => x.key === "OLLAMA_MODEL").length, 1);
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
                                          
  // ── #182: cross-field warnings (OLLAMA_NUM_CTX vs OLLAMA_CONTEXT_LENGTH) ─────
  test("warns when OLLAMA_NUM_CTX exceeds OLLAMA_CONTEXT_LENGTH for ollama", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_NUM_CTX = "98304";
    process.env.OLLAMA_CONTEXT_LENGTH = "32768";
    store.current = fakeStore();
    const schema = await getSchema();
    assert.ok(Array.isArray(schema.warnings) && schema.warnings.length === 1);
    assert.match(schema.warnings[0].message, /98304.*32768/);
    assert.deepEqual(schema.warnings[0].keys, ["OLLAMA_NUM_CTX", "OLLAMA_CONTEXT_LENGTH"]);
  });

  test("no warning when the windows are consistent", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_NUM_CTX = "16384";
    process.env.OLLAMA_CONTEXT_LENGTH = "32768";
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
      delete process.env.APERIO_CONFIG_PRECEDENCE;
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
