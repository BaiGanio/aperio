// tests/lib/config-resolver.test.js
// Phase-1 config resolver — precedence DB > env > default, and the boot-time
// process.env injection that makes it work without touching consumer reads.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  applyConfigToEnv,
  configSettingKey,
  EDITABLE_KEYS,
} from "../../lib/config-resolver.js";
import { CONFIG } from "../../lib/config.js";

// Minimal store: just the getSettings() the resolver needs.
const storeWith = (settings = {}) => ({ async getSettings() { return { ...settings }; } });

// A Tier-1 key safe to mutate in tests, and a Tier-0 key that must NOT be touched.
const T1 = "OLLAMA_MODEL";       // tier 1, editable
const T0 = "PORT";               // tier 0, env-only

describe("config-resolver", () => {
  let saved;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  test("namespaces settings under config.", () => {
    assert.equal(configSettingKey("OLLAMA_MODEL"), "config.OLLAMA_MODEL");
  });

  test("EDITABLE_KEYS = exactly the Tier-1 vars", () => {
    const tier1 = CONFIG.filter((e) => e.tier === 1).map((e) => e.key);
    assert.deepEqual([...EDITABLE_KEYS].sort(), [...tier1].sort());
    assert.ok(!EDITABLE_KEYS.includes(T0), "Tier-0 must not be editable");
  });

  test("default precedence is env: a real .env value wins over the DB value", async () => {
    delete process.env.APERIO_CONFIG_PRECEDENCE;
    process.env[T1] = "from-env";
    const applied = await applyConfigToEnv(storeWith({ [configSettingKey(T1)]: "from-db" }));
    assert.equal(process.env[T1], "from-env");
    assert.deepEqual(applied, []);          // env kept, DB not injected
  });

  test("env value is kept when DB has none", async () => {
    process.env[T1] = "from-env";
    const applied = await applyConfigToEnv(storeWith({}));
    assert.equal(process.env[T1], "from-env");
    assert.deepEqual(applied, []);
  });

  test("neither set → key stays unset (code default applies downstream)", async () => {
    delete process.env[T1];
    await applyConfigToEnv(storeWith({}));
    assert.equal(process.env[T1], undefined);
  });

  test("blank DB value is treated as unset (does not clobber env)", async () => {
    process.env[T1] = "from-env";
    await applyConfigToEnv(storeWith({ [configSettingKey(T1)]: "" }));
    assert.equal(process.env[T1], "from-env");
  });

  test("Tier-0 keys are never injected, even if present in the settings store", async () => {
    process.env[T0] = "31337";
    await applyConfigToEnv(storeWith({ [configSettingKey(T0)]: "9999" }));
    assert.equal(process.env[T0], "31337");
  });

  test("unmanaged config.<KEY> (no registry entry) is injected too (Phase 2b)", async () => {
    delete process.env.MY_IMPORTED_VAR;
    const applied = await applyConfigToEnv(storeWith({ "config.MY_IMPORTED_VAR": "hello" }));
    assert.equal(process.env.MY_IMPORTED_VAR, "hello");
    assert.ok(applied.includes("MY_IMPORTED_VAR"));
  });

  test("non-config.* settings are ignored", async () => {
    const applied = await applyConfigToEnv(storeWith({ "triage.enabled": "yes", "some.other": "1" }));
    assert.deepEqual(applied, []);
    assert.equal(process.env["triage.enabled"], undefined);
  });

  test("non-string DB values are coerced to strings", async () => {
    const applied = await applyConfigToEnv(storeWith({ [configSettingKey("EMBEDDING_DIMS")]: 768 }));
    assert.equal(process.env.EMBEDDING_DIMS, "768");
    assert.ok(applied.includes("EMBEDDING_DIMS"));
  });

  describe("APERIO_CONFIG_PRECEDENCE=env", () => {
    beforeEach(() => { process.env.APERIO_CONFIG_PRECEDENCE = "env"; });

    test("a real env var wins over the DB value", async () => {
      process.env[T1] = "from-env";
      const applied = await applyConfigToEnv(storeWith({ [configSettingKey(T1)]: "from-db" }));
      assert.equal(process.env[T1], "from-env");
      assert.deepEqual(applied, []);          // not injected — env kept
    });

    test("DB-only var (absent from env) is still applied", async () => {
      delete process.env[T1];
      const applied = await applyConfigToEnv(storeWith({ [configSettingKey(T1)]: "from-db" }));
      assert.equal(process.env[T1], "from-db");
      assert.deepEqual(applied, [T1]);
    });

    test("a blank env var does not block the DB value", async () => {
      process.env[T1] = "   ";               // present but blank → not a real override
      await applyConfigToEnv(storeWith({ [configSettingKey(T1)]: "from-db" }));
      assert.equal(process.env[T1], "from-db");
    });
  });

  test("explicit APERIO_CONFIG_PRECEDENCE=db lets DB win over a real .env value", async () => {
    process.env.APERIO_CONFIG_PRECEDENCE = "db";
    process.env[T1] = "from-env";
    await applyConfigToEnv(storeWith({ [configSettingKey(T1)]: "from-db" }));
    assert.equal(process.env[T1], "from-db");
  });

  test("precedence saved in the DB (UI flip to db) makes DB win without an env var", async () => {
    delete process.env.APERIO_CONFIG_PRECEDENCE;     // not forced from .env
    process.env[T1] = "from-env";
    await applyConfigToEnv(storeWith({
      [configSettingKey("APERIO_CONFIG_PRECEDENCE")]: "db",
      [configSettingKey(T1)]: "from-db",
    }));
    assert.equal(process.env[T1], "from-db");
    assert.equal(process.env.APERIO_CONFIG_PRECEDENCE, "db");  // pinned for other consumers
  });

  test("an env var still overrides DB-saved precedence (.env can force it)", async () => {
    process.env.APERIO_CONFIG_PRECEDENCE = "env";     // .env forces env-wins
    process.env[T1] = "from-env";
    await applyConfigToEnv(storeWith({
      [configSettingKey("APERIO_CONFIG_PRECEDENCE")]: "db",   // UI said db…
      [configSettingKey(T1)]: "from-db",
    }));
    assert.equal(process.env[T1], "from-env");        // …but .env wins
  });

  test("missing / brokenstore is a safe no-op", async () => {
    assert.deepEqual(await applyConfigToEnv(undefined), []);
    assert.deepEqual(await applyConfigToEnv({ async getSettings() { throw new Error("db down"); } }), []);
  });
});
