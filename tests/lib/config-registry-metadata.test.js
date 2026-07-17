// tests/lib/config-registry-metadata.test.js
// Test group A of the .env→DB settings plan (#252): every registry entry is
// classified for the Settings overlay (category), the slim .env.example
// (envTemplate), and the Simple↔Advanced toggle (advanced).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, UI_CATEGORIES } from "../../lib/config.js";

// Tier-1 keys allowed into the slim template's START-HERE provider block.
const START_HERE = /^(AI_PROVIDER|[A-Z_]+_API_KEY|[A-Z_]+_MODEL)$/;

describe("config registry metadata (#252 group A)", () => {
  test("A1: every entry has a category from UI_CATEGORIES", () => {
    const ids = new Set(UI_CATEGORIES.map((c) => c.id));
    for (const e of CONFIG) {
      assert.ok(typeof e.category === "string" && e.category.length,
        `${e.key} has no category`);
      assert.ok(ids.has(e.category),
        `${e.key} has unknown category "${e.category}"`);
    }
  });

  test("A1: envTemplate/advanced are booleans on every entry", () => {
    for (const e of CONFIG) {
      assert.equal(typeof e.envTemplate, "boolean", `${e.key} envTemplate not boolean`);
      assert.equal(typeof e.advanced, "boolean", `${e.key} advanced not boolean`);
    }
  });

  test("A1: every tier-0 entry is in the template", () => {
    for (const e of CONFIG.filter((e) => e.tier === 0)) {
      assert.equal(e.envTemplate, true, `tier-0 ${e.key} missing envTemplate`);
    }
  });

  test("A1: template key budget ≤ 30", () => {
    const n = CONFIG.filter((e) => e.envTemplate).length;
    assert.ok(n <= 30, `envTemplate keys = ${n}, budget is 30`);
  });

  test("A1 edge: tier-1 template keys are START-HERE provider lines only", () => {
    for (const e of CONFIG.filter((e) => e.envTemplate && e.tier === 1)) {
      assert.match(e.key, START_HERE,
        `tier-1 ${e.key} is in the template but not a START-HERE provider line`);
    }
  });

  test("A2: simple view budget — editable non-advanced entries ≤ 15", () => {
    const editable = (e) => e.editable ?? e.tier === 1;
    const simple = CONFIG.filter((e) => editable(e) && !e.advanced);
    assert.ok(simple.length <= 15,
      `simple view has ${simple.length} controls (${simple.map((e) => e.key).join(", ")}), budget is 15`);
  });

  test("A2 edge: secrets in the simple view are provider API keys only", () => {
    const editable = (e) => e.editable ?? e.tier === 1;
    for (const e of CONFIG.filter((e) => editable(e) && !e.advanced && e.type === "secret")) {
      assert.match(e.key, /_API_KEY$/,
        `secret ${e.key} is in the simple view but is not a provider API key`);
    }
  });
});
