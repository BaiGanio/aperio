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
import { configSettingKey } from "../../../lib/config-resolver.js";
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
});
