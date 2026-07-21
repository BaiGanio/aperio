// tests/lib/helpers/setupPending.test.js
// Test group D2 of the .env→DB settings plan (#252): wizard choices are stashed
// at POST /api/setup/config time and flushed into DB settings once the store
// opens — tier-1 values never land in .env.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { stashWizardConfig, flushWizardConfig } from "../../lib/helpers/setupPending.js";
import { configSettingKey } from "../../lib/config-resolver.js";

const fakeStore = () => {
  const settings = {};
  return {
    settings,
    async setSetting(k, v) { settings[k] = v; return v; },
    async getSettings() { return { ...settings }; },
  };
};

describe("setup wizard pending config (#252 D2)", () => {
  let saved;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  test("stash sets process.env for the current boot", () => {
    delete process.env.AI_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    stashWizardConfig({ provider: "anthropic", apiKey: "sk-wiz", model: "claude-sonnet-4-6" });
    assert.equal(process.env.AI_PROVIDER, "anthropic");
    assert.equal(process.env.ANTHROPIC_API_KEY, "sk-wiz");
    assert.equal(process.env.ANTHROPIC_MODEL, "claude-sonnet-4-6");
  });

  test("flush writes config.* settings to the store and clears the stash", async () => {
    stashWizardConfig({ provider: "anthropic", apiKey: "sk-wiz", model: "claude-sonnet-4-6" });
    const store = fakeStore();
    const applied = await flushWizardConfig(store);
    assert.deepEqual(applied.sort(), ["AI_PROVIDER", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]);
    assert.equal(store.settings[configSettingKey("AI_PROVIDER")], "anthropic");
    assert.equal(store.settings[configSettingKey("ANTHROPIC_API_KEY")], "sk-wiz");
    assert.equal(store.settings[configSettingKey("ANTHROPIC_MODEL")], "claude-sonnet-4-6");

    // second flush is a no-op (stash cleared)
    const again = await flushWizardConfig(fakeStore());
    assert.deepEqual(again, []);
  });

  test("llamacpp choice maps model to LLAMACPP_MODEL and needs no key", async () => {
    stashWizardConfig({ provider: "llamacpp", model: "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M" });
    const store = fakeStore();
    const applied = await flushWizardConfig(store);
    assert.deepEqual(applied.sort(), ["AI_PROVIDER", "LLAMACPP_MODEL"]);
    assert.equal(store.settings[configSettingKey("LLAMACPP_MODEL")], "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M");
  });

  test("flush without a stash or store is a safe no-op", async () => {
    assert.deepEqual(await flushWizardConfig(fakeStore()), []);
    stashWizardConfig({ provider: "llamacpp", model: "m" });
    assert.deepEqual(await flushWizardConfig(null), []);
  });
});
