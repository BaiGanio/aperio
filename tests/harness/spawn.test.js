// tests/harness/spawn.test.js
//
// WS2 — sub-agent spawn/delegation (agent-harness-epic, G2 group). Drives
// lib/agent/spawn.js's spawnChild/spawnParallel against the same mock
// provider + host-tool fixtures as the rest of tests/harness/, so every
// child runs the REAL runAgentLoop + middleware stack with zero network.
//
// G2-1..G2-3 are the acceptance-criterion IDs from the epic that built this;
// see README.md in this directory for the harness contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeAgentSpec } from "../../lib/agent/spec.js";
import { AgentBundleError } from "../../lib/agent/bundle.js";
import { spawnChild, spawnParallel, AgentSpawnError } from "../../lib/agent/spawn.js";
import { makeSinkEmitter } from "../../lib/emitters/sinkEmitter.js";
import { runWithPaths } from "../../lib/routes/paths.js";
import { createHarnessHostTools } from "./host-tools.js";

function stubMcpTransport(t) {
  t.mock.method(StdioClientTransport.prototype, "start", async () => {});
  t.mock.method(StdioClientTransport.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({ tools: [] }));
  t.mock.method(Client.prototype, "callTool", async () => {
    throw new Error("spawn test reached the real MCP boundary — every tool used must be a host tool");
  });
}

function makeSandbox(t) {
  stubMcpTransport(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-spawn-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratchDir = path.join(root, "scratch");
  fs.mkdirSync(scratchDir, { recursive: true });
  const hostTools = createHarnessHostTools({ scratchDir });
  return { root, scratchDir, hostTools };
}

function withPaths(root, scratchDir, fn) {
  return runWithPaths([root], [root], scratchDir, fn);
}

test("G2-1 parallel-3-reads: 3 scripted children merge into the parent conversation, each tagged with a distinct agent_id", async (t) => {
  const { root, scratchDir, hostTools } = makeSandbox(t);
  const parentSpec = normalizeAgentSpec({ id: "parent-agent", recursionDepth: 2, concurrency: 4, toolAllowlist: null });
  const parentSink = makeSinkEmitter();

  const children = [
    { name: "reader-a", prompt: "fetch the data", tools: ["fetch_data"], providerConfig: { name: "mock", script: [{ tool: "fetch_data", args: {} }, { text: "a done" }] } },
    { name: "reader-b", prompt: "fetch the data", tools: ["fetch_data"], providerConfig: { name: "mock", script: [{ tool: "fetch_data", args: {} }, { text: "b done" }] } },
    { name: "reader-c", prompt: "fetch the data", tools: ["fetch_data"], providerConfig: { name: "mock", script: [{ tool: "fetch_data", args: {} }, { text: "c done" }] } },
  ];

  const results = await withPaths(root, scratchDir, () =>
    spawnParallel({ spec: parentSpec, root, version: "1.0.0-harness", hostTools, emitter: parentSink.emitter, children }));

  assert.equal(results.length, 3);
  assert.deepEqual(results.map(r => r.ok), [true, true, true]);
  assert.deepEqual(results.map(r => r.finalText), ["a done", "b done", "c done"]);

  const agentIds = new Set(results.map(r => r.agentId));
  assert.equal(agentIds.size, 3, "expected 3 distinct agent_ids");

  // Every child event landed in the parent's own event stream, tagged.
  const taggedEvents = parentSink.events.filter(e => e.agent_id);
  assert.ok(taggedEvents.length > 0, "expected child events to be forwarded into the parent emitter");
  for (const id of agentIds) {
    assert.ok(taggedEvents.some(e => e.agent_id === id), `expected at least one event tagged agent_id=${id}`);
  }
  // No cross-contamination: a tool_start for reader-a's fetch_data is tagged
  // with reader-a's own agent_id, not another child's.
  const toolStarts = taggedEvents.filter(e => e.type === "tool_start" && e.name === "fetch_data");
  assert.equal(toolStarts.length, 3);
  assert.equal(new Set(toolStarts.map(e => e.agent_id)).size, 3);
});

test("G2-2 child-failure-isolation: one child trips its failure budget without killing the parent turn or the other children's results", async (t) => {
  const { root, scratchDir, hostTools } = makeSandbox(t);
  const parentSpec = normalizeAgentSpec({ id: "parent-agent", recursionDepth: 2, concurrency: 4 });
  const parentSink = makeSinkEmitter();

  const children = [
    { name: "good-a", prompt: "fetch", providerConfig: { name: "mock", script: [{ tool: "fetch_data", args: {} }, { text: "good-a done" }] } },
    {
      name: "flaky",
      prompt: "try the flaky tool",
      providerConfig: {
        name: "mock",
        script: [
          { tool: "flaky_tool", args: { attempt: 1 } },
          { tool: "flaky_tool", args: { attempt: 1 } },
          { tool: "flaky_tool", args: { attempt: 1 } },
          { text: "flaky gave up" },
        ],
      },
    },
    { name: "good-b", prompt: "fetch", providerConfig: { name: "mock", script: [{ tool: "fetch_data", args: {} }, { text: "good-b done" }] } },
  ];

  const results = await withPaths(root, scratchDir, () =>
    spawnParallel({ spec: parentSpec, root, version: "1.0.0-harness", hostTools, emitter: parentSink.emitter, children }));

  assert.equal(results.length, 3, "parent turn must complete with all 3 results, not throw");
  const byName = Object.fromEntries(results.map(r => [r.name, r]));

  assert.equal(byName["good-a"].ok, true);
  assert.equal(byName["good-a"].finalText, "good-a done");
  assert.equal(byName["good-b"].ok, true);
  assert.equal(byName["good-b"].finalText, "good-b done");

  assert.equal(byName.flaky.ok, false, "the budget-exhausted child must surface as failed");
  assert.equal(byName.flaky.budgetExhausted, true);

  const flakyBudgetEvent = parentSink.events.find(e => e.agent_id === byName.flaky.agentId && e.type === "tool_budget_exhausted");
  assert.ok(flakyBudgetEvent, "expected tool_budget_exhausted to surface to the parent, tagged with the flaky child's agent_id");
});

test("G2-3 depth-limit: a spec at its recursion-depth limit refuses to spawn further, without throwing", async (t) => {
  const { root, scratchDir, hostTools } = makeSandbox(t);
  const exhaustedParent = normalizeAgentSpec({ id: "leaf-agent", recursionDepth: 0 });

  const result = await withPaths(root, scratchDir, () =>
    spawnChild({
      spec: exhaustedParent, root, version: "1.0.0-harness", hostTools,
      name: "should-not-exist", prompt: "do work",
      providerConfig: { name: "mock", script: [{ text: "should never run" }] },
    }));

  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
  assert.equal(result.code, "recursion-depth-exceeded");

  // A spec with budget remaining narrows the child's depth by exactly one.
  const parentWithBudget = normalizeAgentSpec({ id: "mid-agent", recursionDepth: 1 });
  const child = await withPaths(root, scratchDir, () =>
    spawnChild({
      spec: parentWithBudget, root, version: "1.0.0-harness", hostTools,
      name: "only-child", prompt: "do work",
      providerConfig: { name: "mock", script: [{ text: "ran once" }] },
    }));
  assert.equal(child.ok, true);
  assert.equal(child.childSpec.recursionDepth, 0);
});

test("G2-3 tool-allowlist narrowing: a child spec can never widen the parent's tool allowlist", async (t) => {
  const { root, scratchDir, hostTools } = makeSandbox(t);
  const parentSpec = normalizeAgentSpec({ id: "narrow-parent", recursionDepth: 2, toolAllowlist: ["fetch_data"] });

  await assert.rejects(
    () => withPaths(root, scratchDir, () =>
      spawnChild({
        spec: parentSpec, root, version: "1.0.0-harness", hostTools,
        name: "widener", prompt: "do work", tools: ["fetch_data", "write_file"],
        providerConfig: { name: "mock", script: [{ text: "should never run" }] },
      })),
    AgentBundleError,
  );

  // A narrower or equal allowlist is fine.
  const ok = await withPaths(root, scratchDir, () =>
    spawnChild({
      spec: parentSpec, root, version: "1.0.0-harness", hostTools,
      name: "narrower", prompt: "fetch", tools: ["fetch_data"],
      providerConfig: { name: "mock", script: [{ tool: "fetch_data", args: {} }, { text: "ok" }] },
    }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.childSpec.toolAllowlist, ["fetch_data"]);
});

test("spawnChild rejects a missing name", async (t) => {
  const { root, scratchDir, hostTools } = makeSandbox(t);
  const parentSpec = normalizeAgentSpec({ id: "parent-agent", recursionDepth: 1 });
  await assert.rejects(
    () => withPaths(root, scratchDir, () =>
      spawnChild({ spec: parentSpec, root, version: "1.0.0-harness", hostTools, prompt: "x" })),
    AgentSpawnError,
  );
});
