import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { planFirstRun } from "../../../lib/server/firstRun.js";

describe("first-run startup planning", () => {
  test("start:local bootstraps without requiring an existing .env", () => {
    assert.deepEqual(planFirstRun({
      hasEnv: false,
      provider: "llamacpp",
      model: undefined,
      defaultLocalModel: "org/default-model:Q4",
    }), {
      mode: "bootstrap",
      engine: "llamacpp",
      model: "org/default-model:Q4",
      pullModel: true,
      stashLauncherChoice: true,
    });
  });

  test("plain npm start with no provider still opens the setup wizard", () => {
    assert.deepEqual(planFirstRun({
      hasEnv: false,
      provider: "",
      defaultLocalModel: "org/default-model:Q4",
    }), { mode: "wizard" });
  });

  test("a copied local .env downloads a missing model on first boot", () => {
    const plan = planFirstRun({
      hasEnv: true,
      provider: "llamacpp",
      model: "org/chosen-model:Q5",
      defaultLocalModel: "org/default-model:Q4",
    });

    assert.equal(plan.mode, "bootstrap");
    assert.equal(plan.model, "org/chosen-model:Q5");
    assert.equal(plan.pullModel, true);
    assert.equal(plan.stashLauncherChoice, false);
  });

  test("an existing cloud configuration skips local engine setup", () => {
    assert.deepEqual(planFirstRun({
      hasEnv: true,
      provider: "anthropic",
      model: undefined,
      defaultLocalModel: "org/default-model:Q4",
    }), {
      mode: "bootstrap",
      engine: null,
      model: undefined,
      pullModel: false,
      stashLauncherChoice: false,
    });
  });
});
