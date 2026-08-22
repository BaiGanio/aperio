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
 * Wires the scenario's optional `abortAfterTools: N` into a real AbortController,
 * tripped from inside the event stream after the Nth tool_result — the closest
 * deterministic stand-in for a user pressing "stop" mid-chain. Production's
 * controller comes from the per-connection turn lock (lib/emitters/handlers/ws/
 * turnLock.js: getAbort() returns it, "stop" calls .abort()), and every provider
 * loop checks `getAbort()?.signal?.aborted` at the top of each iteration — so
 * aborting here lets the in-flight tool finish and stops the *next* turn, exactly
 * as it does against a real model.
 *
 * The sink's own `send` is patched in place rather than wrapped in a new object:
 * tool-hooks.js sets `emitter._confirmPending` on the emitter it was handed, and
 * the provider loop reads it back off the same reference.
 */
function installAbortTrigger(sink, abortAfterTools) {
  if (!(abortAfterTools > 0)) return { getAbort: () => null, aborted: () => false };
  const controller = new AbortController();
  const originalSend = sink.emitter.send.bind(sink.emitter);
  let toolResults = 0;
  sink.emitter.send = (obj) => {
    originalSend(obj);
    if (obj?.type === "tool_result" && ++toolResults === abortAfterTools) controller.abort();
  };
  return { getAbort: () => controller, aborted: () => controller.signal.aborted };
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
  const abort = installAbortTrigger(sink, Number(scenario.abortAfterTools) || 0);
  const messages = [{ role: "user", content: scenario.userMessage ?? "" }];

  const finalText = await runWithPaths([root], [root], scratchDir, () =>
    agent.runAgentLoop(messages, sink.emitter, {}, abort.getAbort, () => {}));

  // runAgentLoop itself never emits turn_complete — that's wsHandler's job in
  // production (lib/emitters/handlers/wsHandler.js). The scorer
  // (evaluateBenchmarkCase, lib/helpers/modelTierBench.js) requires it, so the
  // harness driver emits it itself once the turn is done, same as a real turn —
  // including wsHandler's own interrupted/completed distinction (wsHandler.js:304).
  sink.emitter.send({ type: "turn_complete", status: abort.aborted() ? "interrupted" : "completed" });

  return { events: sink.events, finalText, scratchDir, root, agent };
}
