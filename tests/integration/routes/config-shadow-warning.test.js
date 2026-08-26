// tests/lib/routes/config-shadow-warning.test.js
// Test group E of the .env→DB settings plan (#252): in db mode, a .env line
// whose value differs from the effective DB value gets a per-key courtesy
// warning (schema API + boot log). Never under =env, never for tier-0 keys,
// never when the values agree or only one side is set.

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Router } from "express";
import { mountConfigRoutes } from "../../../lib/routes/api-config.js";
import { applyConfigToEnv, configSettingKey } from "../../../lib/config-resolver.js";
import { shadowedEnvKeys } from "../../../lib/config-sync.js";
import logger from "../../../lib/helpers/logger.js";

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

const fakeStore = (settings = {}) => ({ async getSettings() { return { ...settings }; } });

let tmp, envFile, router, savedEnv;
const store = { current: fakeStore() };
const setEnvFile = (contents = "") => writeFileSync(envFile, contents);
const getSchema = () => invoke(router, "GET", "/config/schema").then((r) => r.body);
const shadowWarnings = (schema) =>
  (schema.warnings || []).filter((w) => (w.keys || []).length && w.shadowed);

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "aperio-shadow-"));
  envFile = join(tmp, ".env");
  setEnvFile("");
  if (!process.env.DB_BACKEND) process.env.DB_BACKEND = "sqlite";
  router = Router();
  mountConfigRoutes(router, {
    store: { getSettings: () => store.current.getSettings() },
    envPath: envFile,
  });
});

after(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("shadow warning — db mode only (#252 group E)", () => {
  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.APERIO_CONFIG_PRECEDENCE;   // db default
    delete process.env.APERIO_LITE;
    setEnvFile("");
    store.current = fakeStore();
  });
  afterEach(() => { process.env = savedEnv; });

  test("E1: fires when a .env line is shadowed by a differing DB value", async () => {
    setEnvFile("EMBEDDING_DIMS=768\n");
    store.current = fakeStore({ [configSettingKey("EMBEDDING_DIMS")]: "1024" });
    const schema = await getSchema();
    const w = shadowWarnings(schema).find((w) => w.keys.includes("EMBEDDING_DIMS"));
    assert.ok(w, "expected a shadow warning for EMBEDDING_DIMS");
    assert.match(w.message, /768/, "names the .env value");
    assert.match(w.message, /1024/, "names the winning DB value");
    assert.match(w.message, /APERIO_CONFIG_PRECEDENCE=env/, "offers the =env remedy");
  });

  test("E1: boot log line is emitted by the resolver", async () => {
    setEnvFile("EMBEDDING_DIMS=768\n");
    const logs = [];
    const orig = logger.info;
    logger.info = (...a) => { logs.push(a.join(" ")); };
    try {
      await applyConfigToEnv(
        fakeStore({ [configSettingKey("EMBEDDING_DIMS")]: "1024" }),
        { envPath: envFile },
      );
    } finally { logger.info = orig; }
    const line = logs.find((l) => l.includes("EMBEDDING_DIMS") && l.includes("shadow"));
    assert.ok(line, `expected a shadow boot-log line, got: ${logs.join(" | ")}`);
  });

  test("E2a: silent when values are equal", async () => {
    setEnvFile("EMBEDDING_DIMS=1024\n");
    store.current = fakeStore({ [configSettingKey("EMBEDDING_DIMS")]: "1024" });
    assert.equal(shadowWarnings(await getSchema()).length, 0);
  });

  test("E2b: silent when the key is only in .env", async () => {
    setEnvFile("EMBEDDING_DIMS=768\n");
    store.current = fakeStore();
    assert.equal(shadowWarnings(await getSchema()).length, 0);
  });

  test("E2c: silent when the key is only in the DB", async () => {
    store.current = fakeStore({ [configSettingKey("EMBEDDING_DIMS")]: "1024" });
    assert.equal(shadowWarnings(await getSchema()).length, 0);
  });

  test("E2d: silent under =env (the file wins, nothing is shadowed)", async () => {
    process.env.APERIO_CONFIG_PRECEDENCE = "env";
    setEnvFile("EMBEDDING_DIMS=768\n");
    store.current = fakeStore({ [configSettingKey("EMBEDDING_DIMS")]: "1024" });
    assert.equal(shadowWarnings(await getSchema()).length, 0);
  });

  test("E2e: silent for tier-0 keys (env-only, DB value never applies)", async () => {
    setEnvFile("PORT=31337\n");
    store.current = fakeStore({ [configSettingKey("PORT")]: "9999" });
    assert.equal(shadowWarnings(await getSchema()).length, 0);
  });

  test("secrets warn without leaking either value", async () => {
    setEnvFile("GITHUB_TOKEN=ghp_env_secret\n");
    store.current = fakeStore({ [configSettingKey("GITHUB_TOKEN")]: "ghp_db_secret" });
    const w = shadowWarnings(await getSchema()).find((w) => w.keys.includes("GITHUB_TOKEN"));
    assert.ok(w, "expected a shadow warning for the secret");
    assert.ok(!w.message.includes("ghp_env_secret"), "must not leak the .env value");
    assert.ok(!w.message.includes("ghp_db_secret"), "must not leak the DB value");
  });

  test("shadowedEnvKeys is pure and empty in env mode", () => {
    const args = {
      fileEnv: { EMBEDDING_DIMS: "768" },
      settings: { [configSettingKey("EMBEDDING_DIMS")]: "1024" },
    };
    assert.equal(shadowedEnvKeys({ ...args, envWins: false }).length, 1);
    assert.equal(shadowedEnvKeys({ ...args, envWins: true }).length, 0);
  });
});
