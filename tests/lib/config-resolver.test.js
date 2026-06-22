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

  test("DB value wins over a real .env value", async () => {
    process.env[T1] = "from-env";
    const applied = await applyConfigToEnv(storeWith({ [configSettingKey(T1)]: "from-db" }));
    assert.equal(process.env[T1], "from-db");
    assert.deepEqual(applied, [T1]);
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

  test("non-string DB values are coerced to strings", async () => {
    const applied = await applyConfigToEnv(storeWith({ [configSettingKey("EMBEDDING_DIMS")]: 768 }));
    assert.equal(process.env.EMBEDDING_DIMS, "768");
    assert.ok(applied.includes("EMBEDDING_DIMS"));
  });

  test("missing / brokenstore is a safe no-op", async () => {
    assert.deepEqual(await applyConfigToEnv(undefined), []);
    assert.deepEqual(await applyConfigToEnv({ async getSettings() { throw new Error("db down"); } }), []);
  });
});
