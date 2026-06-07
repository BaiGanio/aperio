// Mock for @anthropic-ai/claude-agent-sdk
// Redirected via module.register() loader hook.

import { z } from "zod";

export function tool(name, description, schema, handler) {
  return { name, description, schema, handler };
}

export function createSdkMcpServer({ name, tools }) {
  return { name, version: "1", tools };
}

export function query({ prompt, options }) {
  const gen = (async function*() {
    yield { type: "system", subtype: "init", session_id: "sess-mock-1" };
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Mock response" } } };
    yield { type: "result", subtype: "success", result: "Mock response", usage: { input_tokens: 5, output_tokens: 3 } };
  })();
  return gen;
}
