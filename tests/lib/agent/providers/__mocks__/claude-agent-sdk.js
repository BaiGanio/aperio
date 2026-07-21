// Mock for @anthropic-ai/claude-agent-sdk
// Redirected via module.register() loader hook.

import { z } from "zod";

export function tool(name, description, schema, handler) {
  return { name, description, schema, handler };
}

export function createSdkMcpServer({ name, tools }) {
  return { name, version: "1", tools };
}

// Tests that need a custom event sequence (tool_use/tool_result fixtures,
// etc.) call __setMockEvents(events) immediately before invoking the
// provider; query() consumes and clears it so later tests fall back to the
// default fixed sequence below.
let queuedEvents = null;
export function __setMockEvents(events) { queuedEvents = events; }

export function query({ prompt, options }) {
  const events = queuedEvents;
  queuedEvents = null;
  const gen = (async function*() {
    if (events) {
      for (const ev of events) {
        if (ev && ev.__throw) throw ev.__throw;
        yield ev;
      }
      return;
    }
    yield { type: "system", subtype: "init", session_id: "sess-mock-1" };
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Mock response" } } };
    yield { type: "result", subtype: "success", result: "Mock response", usage: { input_tokens: 5, output_tokens: 3 } };
  })();
  return gen;
}
