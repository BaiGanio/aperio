// tests/harness/planning.test.js
//
// WS1 — planning middleware (agent-harness-epic, G1 group). Drives the same
// mock-provider harness as harness.test.js (see its header for the general
// architecture) but exercises lib/agent/planning-middleware.js: plan
// extraction/validation, drift tracking, and fail-safe fallback. Config-gated
// via APERIO_AGENT_PLANNING — each test sets/restores it around its own run
// so the suite is order-independent regardless of node --test's scheduling.
//
// G1-1..G1-4 are the acceptance-criterion IDs from the epic that built this;
// see README.md in this directory for the harness contract.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./run-scenario.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, "scenarios");
const G0_SCENARIO_IDS = [
  "happy-5-tool-chain", "false-write-claim", "bad-json-budget",
  "oversized-offload", "taint-gate", "repeated-call-break",
];

function loadScenario(id) {
  return JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, `${id}.json`), "utf8"));
}

async function withPlanningEnabled(fn) {
  const saved = process.env.APERIO_AGENT_PLANNING;
  process.env.APERIO_AGENT_PLANNING = "on";
  try { return await fn(); }
  finally {
    if (saved === undefined) delete process.env.APERIO_AGENT_PLANNING;
    else process.env.APERIO_AGENT_PLANNING = saved;
  }
}

describe("Planning middleware — a valid plan is extracted and tracked", () => {
  // G1-1
  test("a well-formed plan produces plan_created, ordered plan_step events, and no drift", async (t) => {
    const scenario = loadScenario("plan-valid-execution");
    const { events } = await withPlanningEnabled(() => runScenario(t, scenario));

    const created = events.filter(e => e.type === "plan_created");
    assert.equal(created.length, 1, "expected exactly one plan_created event");
    assert.equal(created[0].valid, true);
    assert.deepEqual(created[0].steps.map(s => s.tool), ["fetch_data", "analyze_data"]);

    const steps = events.filter(e => e.type === "plan_step");
    assert.deepEqual(steps.map(s => s.tool), ["fetch_data", "analyze_data"]);
    assert.deepEqual(steps.map(s => s.index), [0, 1]);

    assert.equal(events.filter(e => e.type === "plan_drift").length, 0);
  });
});

describe("Planning middleware — an unknown tool in a plan is caught 100% of the time", () => {
  // G1-2
  test("a plan naming a nonexistent tool never becomes active, and the turn still completes", async (t) => {
    const scenario = loadScenario("plan-unknown-tool");
    const { events, finalText } = await withPlanningEnabled(() => runScenario(t, scenario));

    const created = events.filter(e => e.type === "plan_created");
    assert.equal(created.length, 1, "expected exactly one plan_created event");
    assert.equal(created[0].valid, false);
    assert.deepEqual(created[0].invalidTools, ["frobnicate_file"]);

    // Fail-safe: no active plan means no step tracking or drift bookkeeping.
    assert.equal(events.filter(e => e.type === "plan_step").length, 0);
    assert.equal(events.filter(e => e.type === "plan_drift").length, 0);

    // The turn proceeds normally despite the invalid plan.
    const starts = events.filter(e => e.type === "tool_start").map(e => e.name);
    assert.deepEqual(starts, scenario.expectedToolSequence);
    assert.match(finalText, /data/);
  });

  // Extra coverage beyond the minimum G1-2 criterion: a real (not just
  // unknown-tool) mismatch between the plan and actual execution is recorded
  // as drift, never blocked.
  test("calling a different tool than the plan's next step is recorded as drift, not blocked", async (t) => {
    const scenario = loadScenario("plan-drift");
    const { events, finalText } = await withPlanningEnabled(() => runScenario(t, scenario));

    const drift = events.filter(e => e.type === "plan_drift");
    assert.equal(drift.length, 1);
    assert.equal(drift[0].expectedTool, "fetch_data");
    assert.equal(drift[0].actualTool, "analyze_data");

    // Drift is observational only — the mismatched call still ran and the
    // turn still completed.
    const result = events.find(e => e.type === "tool_result" && e.name === "analyze_data");
    assert.ok(result, "the drifted tool call should still have executed");
    assert.equal(finalText, "Done.");
  });
});

describe("Planning middleware — no plan means the loop behaves exactly as it does today", () => {
  // G1-3
  test("a script with no plan marker produces zero plan_* events even with planning on", async (t) => {
    const scenario = loadScenario("happy-5-tool-chain");
    const { events } = await withPlanningEnabled(() => runScenario(t, scenario));
    assert.equal(events.filter(e => e.type.startsWith("plan_")).length, 0);
  });
});

describe("Planning middleware — G0 parity with the gate on and off", () => {
  // G1-4
  for (const id of G0_SCENARIO_IDS) {
    test(`${id} produces the same observable event sequence with planning on and off`, async (t) => {
      const scenario = loadScenario(id);

      const off = await runScenario(t, scenario);
      const on = await withPlanningEnabled(() => runScenario(t, scenario));

      const relevant = events => events
        .filter(e => ["tool_start", "tool_result", "tool_failure", "tool_budget_exhausted", "tool_result_offloaded"].includes(e.type))
        .map(({ type, name, ok }) => ({ type, name, ok }));

      assert.deepEqual(relevant(on.events), relevant(off.events));
      assert.equal(on.finalText, off.finalText);
    });
  }

  // G1-4: lifecycle-trace ordering — safety's afterTool hook must run before
  // planning's, regardless of whether this specific scenario carries a plan.
  test("lifecycle trace shows tool-safety middleware ordered before planning's afterTool hook", async (t) => {
    const scenario = loadScenario("plan-valid-execution");
    const { agent } = await withPlanningEnabled(() => runScenario(t, scenario));
    const entries = agent.getLifecycleTrace().entries;

    const firstSafetyAfterTool = entries.find(e => e.hook === "afterTool" && e.middleware.startsWith("tool-"));
    const firstPlanningAfterTool = entries.find(e => e.hook === "afterTool" && e.middleware === "agent-planning-drift");

    assert.ok(firstSafetyAfterTool, "expected at least one tool-safety afterTool trace entry");
    assert.ok(firstPlanningAfterTool, "expected at least one planning afterTool trace entry");
    assert.ok(
      firstSafetyAfterTool.sequence < firstPlanningAfterTool.sequence,
      `expected safety (seq ${firstSafetyAfterTool.sequence}) before planning (seq ${firstPlanningAfterTool.sequence})`,
    );
  });
});
