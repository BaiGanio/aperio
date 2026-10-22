// tests/harness/harness.test.js
//
// WS0 — deterministic loop-regression harness (agent-harness-epic, G0 group).
// Drives the REAL runAgentLoop, middleware stack, and tool hooks against a
// scripted mock provider (see mock-provider.js) — no network, no real MCP
// subprocess, no live model. See README.md in this directory for what the
// harness covers, when to run it, and how to add a scenario.
// (Test names below are plain-language for the dashboard; the G0-x IDs in
// comments are the acceptance-criterion IDs from the epic that built this.)
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

  // Exercises tool-safety-middleware.js's repeated-call guard on a call that
  // SUCCEEDS every time — the gap the middleware used to have (it only
  // counted repeated failures) before this scenario existed. The mock
  // provider's own loop has no step cap of its own (unlike llamacpp/deepseek,
  // which additionally force a tool-free pass — see tool-safety-middleware.js
  // for how the two compose), so this is the one place a shared-middleware
  // guardrail like this can be proven without a real provider loop.
  test("trying the exact same succeeding action three times in a row also stops the assistant", async (t) => {
    const scenario = loadScenario("repeated-call-break-success");
    const { events, finalText } = await runScenario(t, scenario);
    const starts = events.filter(e => e.type === "tool_start" && e.name === "fetch_data");
    assert.equal(starts.length, 3, "the break should fire on the 3rd identical success, not a 4th attempt");
    const exhausted = events.filter(e => e.type === "tool_budget_exhausted");
    assert.equal(exhausted.length, 1);
    assert.deepEqual(exhausted[0].kinds, ["repeatedCall"]);
    assert.equal(finalText, scenario.providerScript.at(-1).text);
  });
});

describe("Confirmation checks — does a confirm-before-act tool stop the turn and ask?", () => {
  // The emit side of the confirm protocol (lib/agent/tool-hooks.js): a result
  // carrying a `Token:` line from a CONFIRM_TOOLS tool must become an
  // action_confirm_pending event AND end the turn, because nothing has been
  // done yet — the action runs only after the user's confirm round-trip
  // (lib/emitters/handlers/ws/interrupts.js, outside this harness).
  test("a destructive action stops and asks, running nothing else in the turn, even though more steps were queued", async (t) => {
    const scenario = loadScenario("confirm-pending-delete");
    const { events, finalText } = await runScenario(t, scenario);

    const pending = events.find(e => e.type === "action_confirm_pending");
    assert.ok(pending, "expected an action_confirm_pending event");
    assert.equal(pending.tool, "delete_file");
    assert.equal(pending.token, "del_h4rn3s");
    assert.equal(pending.destructive, true, "delete_file must be styled destructive");
    // Label is derived from the path's basename, summary from the Target: line.
    assert.equal(pending.label, "Delete q1-draft.txt");
    assert.match(pending.summary, /reports\/q1-draft\.txt/);

    // The turn must END here: the script had a second tool call and a final
    // answer queued, and neither may run while the user hasn't decided.
    const toolNames = events.filter(e => e.type === "tool_start").map(e => e.name);
    assert.deepEqual(toolNames, ["delete_file"], "no tool may run after a confirm is pending");
    assert.equal(finalText, "", "a pending confirm must not produce a final answer");

    // The card still gets its tool_result — the model still gets told to stop.
    const toolResult = events.find(e => e.type === "tool_result" && e.name === "delete_file");
    assert.ok(toolResult, "expected a tool_result for the pending delete");
  });

  test("a non-destructive action needing permission is labelled from its own Action line", async (t) => {
    const scenario = loadScenario("confirm-pending-index-folder");
    const { events } = await runScenario(t, scenario);

    const pending = events.find(e => e.type === "action_confirm_pending");
    assert.ok(pending, "expected an action_confirm_pending event");
    assert.equal(pending.tool, "index_folder");
    assert.equal(pending.token, "idx_h4rn3s");
    assert.equal(pending.destructive, false, "only delete_file and db_execute are destructive");
    assert.equal(pending.label, "Authorize and index /home/dev/notes");
    // The 📋 header line is stripped; everything above the Action: line remains.
    assert.match(pending.summary, /^Target: \/home\/dev\/notes/);
    assert.doesNotMatch(pending.summary, /📋/);
    assert.equal(events.filter(e => e.type === "tool_start").length, 1);
  });
});

describe("Interruption checks — does pressing stop mid-task end the turn cleanly?", () => {
  test("stopping after the first step runs nothing further, writes no files, and closes the stream", async (t) => {
    const scenario = loadScenario("abort-mid-chain");
    const { events, finalText, scratchDir } = await runScenario(t, scenario);

    const toolNames = events.filter(e => e.type === "tool_start").map(e => e.name);
    assert.deepEqual(toolNames, ["fetch_data"], "no tool may start after the abort");
    assert.equal(finalText, "", "an aborted turn returns no answer");

    // The stream must be closed, not left hanging — the UI ends its typing
    // state on stream_end, so a missing one leaves a permanently "thinking" turn.
    assert.ok(events.some(e => e.type === "stream_end"), "expected a closing stream_end");

    // Side effects of the steps that never ran must not exist.
    assert.equal(fs.existsSync(path.join(scratchDir, "should-never-exist.txt")), false);

    // No guardrail should misread a user abort as a model failure.
    assert.equal(events.filter(e => e.type === "tool_failure").length, 0);
    assert.equal(events.filter(e => e.type === "tool_budget_exhausted").length, 0);

    // Same interrupted/completed distinction wsHandler draws (wsHandler.js:304).
    assert.equal(events.at(-1).type, "turn_complete");
    assert.equal(events.at(-1).status, "interrupted");
  });
});

describe("Envelope checks — does the tool result card carry a structured artifact pointer instead of a raw-text leak?", () => {
  // G3-1
  test("an offloaded result's tool_result event carries {ok, summary, artifact: {id, tokenCount, byteCount}}", async (t) => {
    const scenario = loadScenario("oversized-offload");
    const { events } = await runScenario(t, scenario);
    const offloaded = events.find(e => e.type === "tool_result_offloaded");
    const toolResult = events.find(e => e.type === "tool_result" && e.name === "fetch_large_dataset");
    assert.ok(toolResult, "expected a tool_result event for fetch_large_dataset");
    assert.equal(toolResult.ok, true);
    assert.equal(typeof toolResult.summary, "string");
    assert.ok(toolResult.artifact, "expected the tool_result event to carry an artifact pointer");
    assert.equal(toolResult.artifact.id, offloaded.artifactId);
    assert.equal(toolResult.artifact.tokenCount, offloaded.tokenCount);
    assert.equal(toolResult.artifact.byteCount, offloaded.byteCount);
    // The raw (pre-redaction) result must never also ship over this event once
    // it has an artifact pointer — that would leak un-redacted content the
    // offload step exists specifically to keep out of the socket.
    assert.equal(Object.hasOwn(toolResult, "detail"), false, "an offloaded result must not also carry a raw detail blob");
  });
});
