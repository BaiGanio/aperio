// tests/harness/harness.test.js
//
// WS0 — deterministic loop-regression harness (agent-harness-epic, G0 group).
// Drives the REAL runAgentLoop, middleware stack, and tool hooks against a
// scripted mock provider (see mock-provider.js) — no network, no real MCP
// subprocess, no live model. Companion criteria:
// trash/plans/agent-harness-epic/agent-harness-epic-tests.md
// (test names below are plain-language for the dashboard; the G0-x IDs in
// comments are how each test maps back to that companion file.)
//
// G0-4 (regression teeth) is NOT automated here by design (per the test plan):
// it is a manual drill — temporarily rename the `tool_start` emission in
// lib/agent/tool-hooks.js and confirm the multi-step-task test below goes
// red, then revert. See README.md in this directory.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProvider } from "../../lib/providers/index.js";
import { evaluateBenchmarkCase } from "../../lib/helpers/modelTierBench.js";
import { runScenario } from "./run-scenario.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, "scenarios");

function loadScenario(id) {
  return JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, `${id}.json`), "utf8"));
}

describe("Safety checks — the test-only fake AI can't leak into a real deployment", () => {
  // G0-5
  test("the fake AI refuses to run outside the test suite", () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(() => resolveProvider({ name: "mock" }), /test-only/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  // G0-5
  test("the fake AI is available while the test suite is running", () => {
    assert.equal(process.env.NODE_ENV, "test");
    const provider = resolveProvider({ name: "mock", script: [{ text: "hi" }] });
    assert.equal(provider.name, "mock");
    assert.deepEqual(provider.script, [{ text: "hi" }]);
  });
});

describe("Behavior checks — does the assistant's conversation loop still work correctly?", () => {
  // G0-1 / G0-2
  test("a normal multi-step task (fetch data, analyze it, save a report, double-check it, send it) completes with every step recorded correctly", async (t) => {
    const scenario = loadScenario("happy-5-tool-chain");
    const { events, scratchDir } = await runScenario(t, scenario);

    // Real tool_start -> tool_result -> stream_end event contract.
    const starts = events.filter(e => e.type === "tool_start").map(e => e.name);
    assert.deepEqual(starts, scenario.expectedToolSequence);
    assert.ok(events.some(e => e.type === "stream_end"));
    assert.equal(events.filter(e => e.type === "tool_failure").length, 0);
    for (const file of scenario.expectFiles) {
      assert.ok(fs.existsSync(path.join(scratchDir, file)), `expected ${file} to exist in scratch`);
    }

    // Same scoring function the live model-tier exam uses (reused as-is, not
    // duplicated): lib/helpers/modelTierBench.js's evaluateBenchmarkCase().
    const verdict = evaluateBenchmarkCase(scenario, events);
    assert.equal(verdict.status, "pass", JSON.stringify(verdict, null, 2));
    assert.deepEqual(verdict.actualToolSequence, scenario.expectedToolSequence);

    // And the scorer genuinely tells a correct run apart from a wrong one.
    const wrongSequence = { ...scenario, expectedToolSequence: ["send_report", "fetch_data"] };
    const badVerdict = evaluateBenchmarkCase(wrongSequence, events);
    assert.equal(badVerdict.status, "fail");
  });

  // G0-3
  test("claiming to have saved a file that was never actually written triggers an immediate correction", async (t) => {
    const scenario = loadScenario("false-write-claim");
    const { events } = await runScenario(t, scenario);
    const streamEnds = events.filter(e => e.type === "stream_end");
    // One stream_end for the (false) claim itself, a second appended by
    // verifyFileClaims() (lib/agent/tool-hooks.js) once the loop returns.
    assert.ok(streamEnds.length >= 2, `expected an appended correction stream, got ${streamEnds.length}`);
    const correction = streamEnds.at(-1).text;
    assert.match(correction, /⚠️ \*\*Correction:\*\*/);
    assert.match(correction, /report\.pdf/);
  });

  // G0-3
  test("three broken tool requests in a row stop the assistant before it repeats the same mistake again", async (t) => {
    const scenario = loadScenario("bad-json-budget");
    const { events } = await runScenario(t, scenario);
    const failures = events.filter(e => e.type === "tool_failure");
    assert.equal(failures.length, 3);
    assert.ok(failures.every(f => f.kind === "parseArgs"), JSON.stringify(failures));
    assert.equal(events.filter(e => e.type === "tool_budget_exhausted").length, 1);
  });

  // G0-3
  test("a very large tool result is stored separately instead of flooding the conversation, and the assistant can still read it back in pieces", async (t) => {
    const scenario = loadScenario("oversized-offload");
    const { events } = await runScenario(t, scenario);
    const offloaded = events.find(e => e.type === "tool_result_offloaded");
    assert.ok(offloaded, "expected a tool_result_offloaded event");
    assert.equal(offloaded.name, "fetch_large_dataset");
    assert.ok(offloaded.artifactId);
    const readArtifactResult = events.find(e => e.type === "tool_result" && e.name === "read_artifact");
    assert.ok(readArtifactResult, "expected a read_artifact tool_result");
    assert.equal(readArtifactResult.ok, true);
  });

  // G0-3
  test("after reading content from an untrusted source, the assistant is blocked from writing a file in that same turn", async (t) => {
    const scenario = loadScenario("taint-gate");
    const { events } = await runScenario(t, scenario);
    const writeStart = events.find(e => e.type === "tool_start" && e.name === "write_file");
    assert.ok(writeStart, "expected a write_file tool_start");
    assert.equal(writeStart.arguments.__tainted, true, "write_file should have received the taint flag");
    const writeResult = events.find(e => e.type === "tool_result" && e.name === "write_file");
    assert.equal(writeResult.ok, false, "the tainted write should not report success");
  });

  // G0-3
  test("trying the exact same failing action three times in a row stops the assistant instead of letting it loop forever", async (t) => {
    const scenario = loadScenario("repeated-call-break");
    const { events } = await runScenario(t, scenario);
    const starts = events.filter(e => e.type === "tool_start" && e.name === "flaky_tool");
    assert.equal(starts.length, 3, "the break should fire on the 3rd identical failure, not a 4th attempt");
    assert.equal(events.filter(e => e.type === "tool_budget_exhausted").length, 1);
  });
});
