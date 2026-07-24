// tests/harness/run-scenario.js
//
// Shared driver for the WS0 loop-regression harness. Stubs the MCP transport
// exactly like tests/integration/agent.test.js's stubMcpTransport (no real
// subprocess, no network), wires the scenario's own host tools, and drives a
// single real runAgentLoop turn against the mock provider inside an isolated
// scratch workdir. No stray state: everything lives under one mkdtemp'd root,
// removed in t.after().

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgent } from "../../lib/agent.js";
import { makeSinkEmitter } from "../../lib/emitters/sinkEmitter.js";
import { runWithPaths } from "../../lib/routes/paths.js";
import { createHarnessHostTools } from "./host-tools.js";

function stubMcpTransport(t) {
  t.mock.method(StdioClientTransport.prototype, "start", async () => {});
  t.mock.method(StdioClientTransport.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({ tools: [] }));
  t.mock.method(Client.prototype, "callTool", async () => {
    throw new Error("harness scenario reached the real MCP boundary — every tool this scenario uses must be a host tool");
  });
}

/**
 * @param {import("node:test").TestContext} t
 * @param {object} scenario — parsed scenario JSON (providerScript + userMessage)
 * @returns {Promise<{ events: object[], finalText: string, scratchDir: string }>}
 */
export async function runScenario(t, scenario) {
  stubMcpTransport(t);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-harness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratchDir = path.join(root, "scratch");
  fs.mkdirSync(scratchDir, { recursive: true });

  const agent = await createAgent({
    // A real (not fake) root: artifactStore/createArtifactStore writes real
    // files under `${root}/var/agent-artifacts` for the oversized-offload
    // scenario, so root must be a writable directory inside our own mkdtemp
    // sandbox — never a fake path that could resolve outside it.
    root,
    version: "1.0.0-harness",
    providerConfig: { name: "mock", script: scenario.providerScript },
    hostTools: createHarnessHostTools({ scratchDir }),
  });

  const sink = makeSinkEmitter();
  const messages = [{ role: "user", content: scenario.userMessage ?? "" }];

  const finalText = await runWithPaths([root], [root], scratchDir, () =>
    agent.runAgentLoop(messages, sink.emitter, {}, () => null, () => {}));

  // runAgentLoop itself never emits turn_complete — that's wsHandler's job in
  // production (lib/emitters/handlers/wsHandler.js). The scorer
  // (evaluateBenchmarkCase, lib/helpers/modelTierBench.js) requires it, so the
  // harness driver emits it itself once the turn is done, same as a real turn.
  sink.emitter.send({ type: "turn_complete", status: "completed" });

  return { events: sink.events, finalText, scratchDir, root, agent };
}
