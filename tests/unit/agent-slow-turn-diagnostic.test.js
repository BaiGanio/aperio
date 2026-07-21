// tests/lib/agent/slow-turn-diagnostic.test.js
//
// llamacpp.md Phase 5: evidence-gated slow-turn diagnostic. Drives a full
// runAgentLoop (through the real llamacpp provider loop, not a mock of it) so
// this exercises the actual state.lastTimings → lib/agent/index.js wiring,
// not just the pure recommendPerfFix() helper (covered separately in
// tests/lib/providers.test.js). Mocks fetch and the MCP transport — no live
// llama-server or child process involved.

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgent } from "../../../lib/agent.js";

const FAKE_ROOT = "/fake/project";

const stubMcpTransport = (t) => {
  t.mock.method(StdioClientTransport.prototype, "start", async () => {});
  t.mock.method(StdioClientTransport.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({ tools: [] }));
  t.mock.method(Client.prototype, "callTool", async () => ({
    content: [{ type: "text", text: "No memories found." }],
  }));
};

/** SSE body for a plain-text (no tool call) llama.cpp turn with a given gen tok/s. */
function sseTurn(genTps) {
  const enc = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}],"usage":null}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}],"usage":null}\n\n',
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],`
      + `"usage":{"input_tokens":10,"output_tokens":2},`
      + `"timings":{"predicted_per_second":${genTps},"prompt_per_second":50}}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new ReadableStream({
    start(ctrl) { for (const c of chunks) ctrl.enqueue(enc.encode(c)); ctrl.close(); },
  });
}

/** Queue-driven fetch mock: /health always ok; each /chat/completions call
 *  consumes the next tok/s value from `queue` (in order). */
function makeFetchMock(queue) {
  let i = 0;
  return async (url) => {
    const tag = String(url);
    if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
    if (tag.includes("/chat/completions")) {
      const genTps = queue[i++];
      return { ok: true, status: 200, body: sseTurn(genTps), text: async () => "" };
    }
    return { ok: false, status: 404, text: async () => "Not found" };
  };
}

async function makeLlamaCppAgent(t) {
  stubMcpTransport(t);
  process.env.AI_PROVIDER = "llamacpp";
  process.env.LLAMACPP_MODEL = "test/slow-model";
  return createAgent({ root: FAKE_ROOT, version: "1.0.0" });
}

function slowTurnEvents(emitterSend) {
  return emitterSend.mock.calls
    .map(c => c.arguments[0])
    .filter(m => m.type === "slow_local_turn_detected");
}

describe("Slow-turn diagnostic (llamacpp.md Phase 5)", () => {
  test("fires once after 3 consecutive slow turns, not before", async (t) => {
    t.mock.method(globalThis, "fetch", makeFetchMock([2, 2, 2]));
    const agent = await makeLlamaCppAgent(t);
    const emitter = { send: t.mock.fn() };

    await agent.runAgentLoop([{ role: "user", content: "hi" }], emitter);
    assert.equal(slowTurnEvents(emitter.send).length, 0, "1 slow turn: no evidence yet");

    await agent.runAgentLoop([{ role: "user", content: "hi again" }], emitter);
    assert.equal(slowTurnEvents(emitter.send).length, 0, "2 slow turns: still not enough evidence");

    await agent.runAgentLoop([{ role: "user", content: "hi a third time" }], emitter);
    const events = slowTurnEvents(emitter.send);
    assert.equal(events.length, 1, "3rd consecutive slow turn fires the diagnostic");
    assert.equal(events[0].model, "test/slow-model");
    assert.equal(events[0].genTps, 2);
    assert.ok(events[0].hint, "carries a recommendation string");
  });

  test("does not fire again in the same session once emitted", async (t) => {
    t.mock.method(globalThis, "fetch", makeFetchMock([1, 1, 1, 1, 1]));
    const agent = await makeLlamaCppAgent(t);
    const emitter = { send: t.mock.fn() };

    for (let i = 0; i < 5; i++) {
      await agent.runAgentLoop([{ role: "user", content: `turn ${i}` }], emitter);
    }
    assert.equal(slowTurnEvents(emitter.send).length, 1, "latched — fires exactly once per session");
  });

  test("a fast turn resets the streak", async (t) => {
    // slow, slow, FAST, slow, slow — never 3 in a row, so it should never fire.
    t.mock.method(globalThis, "fetch", makeFetchMock([2, 2, 50, 2, 2]));
    const agent = await makeLlamaCppAgent(t);
    const emitter = { send: t.mock.fn() };

    for (let i = 0; i < 5; i++) {
      await agent.runAgentLoop([{ role: "user", content: `turn ${i}` }], emitter);
    }
    assert.equal(slowTurnEvents(emitter.send).length, 0, "streak reset by the fast turn — never reached 3 in a row");
  });

  test("fast turns never fire the diagnostic", async (t) => {
    t.mock.method(globalThis, "fetch", makeFetchMock([80, 80, 80]));
    const agent = await makeLlamaCppAgent(t);
    const emitter = { send: t.mock.fn() };

    for (let i = 0; i < 3; i++) {
      await agent.runAgentLoop([{ role: "user", content: `turn ${i}` }], emitter);
    }
    assert.equal(slowTurnEvents(emitter.send).length, 0);
  });
});
