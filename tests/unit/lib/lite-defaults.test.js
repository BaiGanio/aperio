// tests/lib/lite-defaults.test.js
// Lite profile defaults (issue #186, Phases 3+5): APERIO_LITE=on fills each
// registry entry's liteDefault for vars still unset, staged by tier — tier 0
// before the store opens (DB_BACKEND beats Docker auto-detect), tier 1 after
// applyConfigToEnv (so .env / UI-saved values still win).

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, isLite, applyLiteDefaults } from "../../../lib/config.js";
import { resolvePrecedence, applyConfigToEnv, configSettingKey } from "../../../lib/config-resolver.js";

describe("lite defaults", () => {
  let saved;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  test("isLite is true only for exactly 'on'", () => {
    for (const [v, want] of [["on", true], [" ON ", true], ["1", false], ["true", false], ["", false]]) {
      process.env.APERIO_LITE = v;
      assert.equal(isLite(), want, `APERIO_LITE=${JSON.stringify(v)}`);
    }
    delete process.env.APERIO_LITE;
    assert.equal(isLite(), false);
  });

  test("registry carries the lite profile: llamacpp + sqlite + docgraph on", () => {
    const liteOf = (key) => CONFIG.find((e) => e.key === key)?.liteDefault;
    assert.equal(liteOf("AI_PROVIDER"), "llamacpp");
    assert.equal(liteOf("DB_BACKEND"), "sqlite");
    assert.equal(liteOf("APERIO_DOCGRAPH"), "on");
    assert.equal(liteOf("APERIO_CODEGRAPH"), undefined, "codegraph stays off in lite");
  });

  test("no-op when lite is off", () => {
    delete process.env.APERIO_LITE;
    delete process.env.AI_PROVIDER;
    assert.deepEqual(applyLiteDefaults(1), []);
    assert.equal(process.env.AI_PROVIDER, undefined);
  });

  test("fills unset vars, staged by tier", () => {
    process.env.APERIO_LITE = "on";
    delete process.env.AI_PROVIDER;
    delete process.env.DB_BACKEND;
    delete process.env.APERIO_DOCGRAPH;

    const t0 = applyLiteDefaults(0);
    assert.ok(t0.includes("DB_BACKEND"));
    assert.ok(!t0.includes("AI_PROVIDER"), "tier-1 vars wait for stage 1");
    assert.equal(process.env.DB_BACKEND, "sqlite");

    const t1 = applyLiteDefaults(1);
    assert.ok(t1.includes("AI_PROVIDER"));
    assert.ok(t1.includes("APERIO_DOCGRAPH"));
    assert.equal(process.env.AI_PROVIDER, "llamacpp");
    assert.equal(process.env.APERIO_DOCGRAPH, "on");
  });

  test("never overrides a value that is already set", () => {
    process.env.APERIO_LITE = "on";
    process.env.AI_PROVIDER = "anthropic";
    process.env.APERIO_DOCGRAPH = "off";     // user turned it off in the UI/.env
    const applied = applyLiteDefaults(1);
    assert.ok(!applied.includes("AI_PROVIDER"));
    assert.ok(!applied.includes("APERIO_DOCGRAPH"));
    assert.equal(process.env.AI_PROVIDER, "anthropic");
    assert.equal(process.env.APERIO_DOCGRAPH, "off");
  });

  test("blank counts as unset", () => {
    process.env.APERIO_LITE = "on";
    process.env.AI_PROVIDER = "  ";
    const applied = applyLiteDefaults(1);
    assert.ok(applied.includes("AI_PROVIDER"));
    assert.equal(process.env.AI_PROVIDER, "llamacpp");
  });
});

// Lite users never edit .env — the launchers/wizard wrote it. The Settings UI
// is their only config surface, so lite must force db precedence regardless of
// what .env says.
describe("lite forces db precedence", () => {
  let saved;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  const storeWith = (settings = {}) => ({ async getSettings() { return { ...settings }; } });

  test("APERIO_LITE=on in env → db, even when .env demands env", () => {
    process.env.APERIO_LITE = "on";
    process.env.APERIO_CONFIG_PRECEDENCE = "env";
    assert.equal(resolvePrecedence({}), "db");
  });

  test("APERIO_LITE=on saved in the DB (no env flag) → db", () => {
    delete process.env.APERIO_LITE;
    delete process.env.APERIO_CONFIG_PRECEDENCE;
    assert.equal(resolvePrecedence({ [configSettingKey("APERIO_LITE")]: "on" }), "db");
  });

  test("lite off → normal resolution (db default, #252; =env still honored)", () => {
    delete process.env.APERIO_LITE;
    delete process.env.APERIO_CONFIG_PRECEDENCE;
    assert.equal(resolvePrecedence({}), "db");
    process.env.APERIO_CONFIG_PRECEDENCE = "env";
    assert.equal(resolvePrecedence({}), "env");
  });

  test("end to end: in lite, a UI-saved value beats the launcher env var", async () => {
    process.env.APERIO_LITE = "on";
    delete process.env.APERIO_CONFIG_PRECEDENCE;
    process.env.LLAMACPP_MODEL = "from-launcher";
    await applyConfigToEnv(storeWith({ [configSettingKey("LLAMACPP_MODEL")]: "from-ui" }));
    assert.equal(process.env.LLAMACPP_MODEL, "from-ui");
    assert.equal(process.env.APERIO_CONFIG_PRECEDENCE, "db"); // pinned for downstream readers
  });
});
