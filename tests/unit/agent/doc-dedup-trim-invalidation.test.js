// tests/unit/agent/doc-dedup-trim-invalidation.test.js
//
// Step 3 review, round 7, P1: the doc_batch dedup cache (lib/docgraph/
// retrieval.js's sessionReadFacts) must not outlive the model-facing context.
// When the context-trimming middleware sheds tool results — the 20-message
// history cap or token-pressure trimming — a document read earlier on this
// connection may no longer be reachable by the model, yet its cache entry
// survives and a later doc_batch would return an "already read" pointer for
// text the model can't see. This test drives a real runAgentLoop (through the
// real llamacpp provider loop, mocked fetch + MCP transport, no live
// llama-server or child process) and asserts the loop clears the doc dedup
// cache for ITS docSessionId exactly when a trim sheds content.

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
  // clearDocSessionCache rides the low-level Protocol#request channel
  // (lib/agent/index.js) — never a model-callable tools/call.
  const requestMock = t.mock.method(Client.prototype, "request", async () => ({}));
  return requestMock;
};

/** SSE body for a plain-text (no tool call) llama.cpp turn. */
function sseTurn() {
  const enc = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}],"usage":null}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}],"usage":null}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
      + '"usage":{"input_tokens":10,"output_tokens":2},'
      + '"timings":{"predicted_per_second":50,"prompt_per_second":50}}\n\n',
    'data: [DONE]\n\n',
  ];
  return new ReadableStream({
    start(ctrl) { for (const c of chunks) ctrl.enqueue(enc.encode(c)); ctrl.close(); },
  });
}

/** SSE body for a hop that issues a native tool call (so the loop takes a
 *  second hop before answering). The tool name is deliberately unknown to the
 *  loop's tool schema (listTools is stubbed empty), which routes it through
 *  the corrupted-name retry — that retry still re-runs prepareModelContext on
 *  the next hop, which is exactly the multi-hop-same-turn scenario the
 *  per-loop latch used to suppress. */
function sseToolCall() {
  const enc = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null}}],"usage":null}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"/fake/project/x\"}"}}]}}],"usage":null}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],'
      + '"usage":{"prompt_tokens":10,"completion_tokens":2},'
      + '"timings":{"predicted_per_second":50,"prompt_per_second":50}}\n\n',
    'data: [DONE]\n\n',
  ];
  return new ReadableStream({
    start(ctrl) { for (const c of chunks) ctrl.enqueue(enc.encode(c)); ctrl.close(); },
  });
}

/** Queue-driven fetch mock: hop 1 answers with a tool call, hop 2 with text. */
function makeTwoHopFetchMock() {
  let completions = 0;
  return async (url) => {
    const tag = String(url);
    if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
    if (tag.includes("/chat/completions")) {
      completions++;
      return { ok: true, status: 200, body: completions === 1 ? sseToolCall() : sseTurn(), text: async () => "" };
    }
    return { ok: false, status: 404, text: async () => "Not found" };
  };
}

function makeFetchMock() {
  return async (url) => {
    const tag = String(url);
    if (tag.includes("/health")) return { ok: true, status: 200, text: async () => "" };
    if (tag.includes("/chat/completions")) {
      return { ok: true, status: 200, body: sseTurn(), text: async () => "" };
    }
    return { ok: false, status: 404, text: async () => "Not found" };
  };
}

async function makeLlamaCppAgent(t) {
  const requestMock = stubMcpTransport(t);
  process.env.AI_PROVIDER = "llamacpp";
  process.env.LLAMACPP_MODEL = "test/dedup-model";
  const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0" });
  return { agent, requestMock };
}

function clearCalls(requestMock) {
  return requestMock.mock.calls
    .map(c => c.arguments[0])
    .filter(req => req?.method === "aperio/clearDocSessionCache");
}

describe("context trims invalidate the connection's doc_batch dedup cache (Step 3 review, round 7, P1)", () => {
  test("the 20-message history cap (no token pressure) clears the dedup cache for the loop's docSessionId", async (t) => {
    t.mock.method(globalThis, "fetch", makeFetchMock());
    const { agent, requestMock } = await makeLlamaCppAgent(t);
    const emitter = { send: t.mock.fn() };

    const messages = Array.from({ length: 25 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `message ${index}`,
    }));
    await agent.runAgentLoop(messages, emitter, { docSessionId: "conn-1" });

    const calls = clearCalls(requestMock);
    assert.equal(calls.length, 1, "one qualifying shed in this single-hop turn — exactly one clear");
    assert.equal(calls[0].params.sessionId, "conn-1",
      "the clear targets the CONNECTION's docSessionId — the namespace its doc_batch calls use");
  });

  test("a short history that stays under the cap and under token pressure clears nothing", async (t) => {
    t.mock.method(globalThis, "fetch", makeFetchMock());
    const { agent, requestMock } = await makeLlamaCppAgent(t);
    const emitter = { send: t.mock.fn() };

    const messages = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ];
    await agent.runAgentLoop(messages, emitter, { docSessionId: "conn-2" });

    assert.deepEqual(clearCalls(requestMock), [],
      "nothing shed — the dedup cache stays valid for content still in context");
  });

  test("a loop without a docSessionId (non-WebSocket caller) never clears anything", async (t) => {
    t.mock.method(globalThis, "fetch", makeFetchMock());
    const { agent, requestMock } = await makeLlamaCppAgent(t);
    const emitter = { send: t.mock.fn() };

    const messages = Array.from({ length: 25 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `message ${index}`,
    }));
    await agent.runAgentLoop(messages, emitter, {});

    assert.deepEqual(clearCalls(requestMock), [],
      "no docSessionId — there is no connection-scoped dedup cache to invalidate");
  });

  test("later trims in the SAME turn clear again — no per-loop latch, because content read after the first clear can itself be shed on a later hop (round 9, P1)", async (t) => {
    t.mock.method(globalThis, "fetch", makeTwoHopFetchMock());
    const { agent, requestMock } = await makeLlamaCppAgent(t);
    const emitter = { send: t.mock.fn() };

    // Both hops carry >maxHistory messages, so each hop's prepareModelContext
    // sheds (20-message cap) and must invalidate the dedup cache — the old
    // per-loop guard suppressed the second clear, leaving stale "already read"
    // entries for documents read after the first clear and shed by the second.
    const messages = Array.from({ length: 25 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `message ${index}`,
    }));
    await agent.runAgentLoop(messages, emitter, { docSessionId: "conn-3" });

    const calls = clearCalls(requestMock);
    assert.equal(calls.length, 2,
      "each qualifying shed within one turn must invalidate — the first clear must not latch for the rest of the loop");
    assert.ok(calls.every(c => c.params.sessionId === "conn-3"),
      "every clear targets the connection's docSessionId");
  });
});
