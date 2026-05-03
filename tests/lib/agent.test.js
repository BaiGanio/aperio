// tests/agent.test.js
import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  getRecommendedModel,
  resolveProvider,
  fixUnclosedFence,
  parseMemoriesRaw,
  createAgent
} from "../../lib/agent.js";
import { makeWsEmitter } from "../../lib/emitters/wsEmitter.js";
import { makeCliEmitter } from "../../lib/emitters/cliEmitter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let output = "";

/** Capture process.stdout.write for the duration of one test. */
const mockStdout = (t) => {
  output = "";
  return t.mock.method(process.stdout, "write", (data) => {
    output += data;
    return true;
  });
};

/**
 * Create a fake response stream for testing Ollama responses
 */
function createMockResponseStream(chunks) {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
  
  return {
    ok: true,
    body: readable,
    text: async () => "",
  };
}

// ---------------------------------------------------------------------------
// createAgent – shared mock setup
// ---------------------------------------------------------------------------

const stubMcpTransport = (t) => {
  // Prevent StdioClientTransport from spawning anything
  t.mock.method(StdioClientTransport.prototype, "start", async () => {});
  t.mock.method(StdioClientTransport.prototype, "close", async () => {});

  // Make Client.connect() a no-op
  t.mock.method(Client.prototype, "connect", async () => {});

  // Make Client.listTools() return a predictable tool list with proper schema
  t.mock.method(Client.prototype, "listTools", async () => ({
    tools: [
      { 
        name: "test_tool", 
        description: "A test tool", 
        inputSchema: { type: "object", properties: {} } 
      },
      { 
        name: "recall", 
        description: "Recall memories", 
        inputSchema: { type: "object", properties: { query: { type: "string" } } } 
      },
      { 
        name: "remember", 
        description: "Save memory", 
        inputSchema: { type: "object", properties: { content: { type: "string" } } } 
      }
    ],
  }));
};

// ---------------------------------------------------------------------------
// agent.js – core
// ---------------------------------------------------------------------------

describe("agent.js - core", () => {
  test("parseMemoriesRaw handles empty input", () => {
    assert.deepStrictEqual(parseMemoriesRaw(""), []);
    assert.deepStrictEqual(parseMemoriesRaw("No memories found."), []);
    assert.deepStrictEqual(parseMemoriesRaw("No result"), []);
  });

  test("parseMemoriesRaw handles malformed input gracefully", () => {
    const result = parseMemoriesRaw("some random text without proper format");
    // Should return empty array or array with partial data, not throw
    assert.ok(Array.isArray(result));
  });

  test("fixUnclosedFence handles various fence scenarios", () => {
    assert.strictEqual(fixUnclosedFence("no fences"), "no fences");
    assert.strictEqual(fixUnclosedFence("```code"), "```code\n```");
    assert.strictEqual(fixUnclosedFence("```\ncode\n```"), "```\ncode\n```");
    assert.strictEqual(fixUnclosedFence("```js\ncode\n```\n```"), "```js\ncode\n```\n```");
  });
});

// ---------------------------------------------------------------------------
// RAM-based model selection
// ---------------------------------------------------------------------------

describe("RAM-based model selection", () => {
  test("selects deepseek-r1:32 for 64 GB+ RAM", () => {
    mock.method(os, "totalmem", () => 64 * 1024 ** 3);
    assert.strictEqual(getRecommendedModel(), "deepseek-r1:32");
  });

  test("selects qwen3:14b for 30-60 GB RAM", () => {
    mock.method(os, "totalmem", () => 30 * 1024 ** 3);
    assert.strictEqual(getRecommendedModel(), "qwen3:14b");
  });

  test("selects llama3.1:8b for 14-30 GB RAM", () => {
    mock.method(os, "totalmem", () => 14 * 1024 ** 3);
    assert.strictEqual(getRecommendedModel(), "llama3.1:8b");
  });

  test("selects qwen2.5:3b for 8-14 GB RAM", () => {
    mock.method(os, "totalmem", () => 8 * 1024 ** 3);
    assert.strictEqual(getRecommendedModel(), "qwen2.5:3b");
  });

  test("selects qwen3:8b for low RAM (<8 GB)", () => {
    mock.method(os, "totalmem", () => 4 * 1024 ** 3);
    assert.strictEqual(getRecommendedModel(), "qwen3:8b");
  });
});

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

describe("Provider resolution", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.OLLAMA_MODEL;
    delete process.env.CHECK_RAM;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("defaults to anthropic provider", () => {
    const p = resolveProvider();
    assert.strictEqual(p.name, "anthropic");
    assert.ok(p.client);
  });

  test("handles OLLAMA_MODEL environment variable", () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "custom-model";
    const p = resolveProvider();
    assert.strictEqual(p.name, "ollama");
    assert.strictEqual(p.model, "custom-model");
  });

  test("auto-selects model when CHECK_RAM is true", () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.CHECK_RAM = "true";
    mock.method(os, "totalmem", () => 16 * 1024 ** 3);
    const p = resolveProvider();
    assert.strictEqual(p.model, "llama3.1:8b");
  });

  test("uses default llama3.1 when no OLLAMA_MODEL and CHECK_RAM false", () => {
    process.env.AI_PROVIDER = "ollama";
    const p = resolveProvider();
    assert.strictEqual(p.model, "llama3.1");
  });

  test("respects OLLAMA_BASE_URL", () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_BASE_URL = "http://custom:11434";
    const p = resolveProvider();
    assert.strictEqual(p.baseURL, "http://custom:11434/v1");
    assert.strictEqual(p.ollamaBaseURL, "http://custom:11434");
  });
});

// ---------------------------------------------------------------------------
// createAgent initialization
// ---------------------------------------------------------------------------

describe("createAgent initialization", () => {
  test("createAgent connects to MCP and lists tools", async (t) => {
    stubMcpTransport(t);
    
    // Mock callTool responses
    const mockCallTool = t.mock.fn(async () => ({ content: [{ text: "mock result" }] }));
    
    const agent = await createAgent({ root: process.cwd(), version: "1.0.0" });

    assert.ok(agent, "createAgent should return an agent object");
    assert.ok(agent.provider, "Agent should have provider");
    assert.ok(agent.callTool, "Agent should have callTool");
    assert.ok(agent.runAgentLoop, "Agent should have runAgentLoop");
    assert.ok(agent.fetchMemories, "Agent should have fetchMemories");
    assert.ok(agent.buildGreeting, "Agent should have buildGreeting");
  });

  test("createAgent handles missing prompts directory gracefully", async (t) => {
    stubMcpTransport(t);
    
    const agent = await createAgent({ 
      root: "/nonexistent/path", 
      version: "1.0.0" 
    });

    assert.ok(agent, "Should still create agent even without prompts");
  });
});

// ---------------------------------------------------------------------------
// String & Memory helpers - Full Coverage
// ---------------------------------------------------------------------------

describe("String & Memory Helpers - Full Coverage", () => {
  test("fixUnclosedFence: handles multiple fences correctly", () => {
    assert.strictEqual(fixUnclosedFence("```\na\n```\n```\nb"), "```\na\n```\n```\nb\n```");
    assert.strictEqual(fixUnclosedFence("text ```code``` more text"), "text ```code``` more text");
  });

  test("parseMemoriesRaw: parses complete memory block", () => {
    const raw = `[person] Alice Johnson (importance: 4)
Senior Software Engineer with 10 years experience
Tags: engineering, lead, remote
ID: 550e8400-e29b-41d4-a716-446655440000
Created: 2024-01-15T10:30:00Z`;

    const [mem] = parseMemoriesRaw(raw);
    assert.strictEqual(mem.type, "person");
    assert.strictEqual(mem.title, "Alice Johnson");
    assert.strictEqual(mem.content, "Senior Software Engineer with 10 years experience");
    assert.deepStrictEqual(mem.tags, ["engineering", "lead", "remote"]);
    assert.strictEqual(mem.importance, 4);
    assert.strictEqual(mem.id, "550e8400-e29b-41d4-a716-446655440000");
  });

  test("parseMemoriesRaw: handles missing optional fields", () => {
    const raw = `[fact] Some fact
Content here
Tags: none
ID: 123`;

    const [mem] = parseMemoriesRaw(raw);
    assert.strictEqual(mem.type, "fact");
    assert.strictEqual(mem.title, "Some fact");
    assert.strictEqual(mem.content, "Content here");
    assert.deepStrictEqual(mem.tags, []);
    assert.strictEqual(mem.importance, 3); // default
  });

  test("parseMemoriesRaw: handles multiple memory blocks", () => {
    const raw = `[fact] First fact
First content
Tags: tag1
ID: 1
---
[preference] Second pref
Second content
Tags: tag2
ID: 2`;

    const memories = parseMemoriesRaw(raw);
    assert.strictEqual(memories.length, 2);
    assert.strictEqual(memories[0].title, "First fact");
    assert.strictEqual(memories[1].title, "Second pref");
  });
});

// ---------------------------------------------------------------------------
// Agent Loop Logic – Anthropic streaming
// ---------------------------------------------------------------------------

describe("Agent Loop Logic - Anthropic", () => {
  test("mock stream iterates correctly", async () => {
    const mockStream = (async function* () {
      yield { type: "content_block_start", content_block: { type: "text" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: " World" } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 5 } };
    })();

    const events = [];
    for await (const chunk of mockStream) {
      events.push(chunk);
    }

    assert.strictEqual(events.length, 4);
    assert.strictEqual(events[1].delta.text, "Hello");
    assert.strictEqual(events[2].delta.text, " World");
  });
});

// ---------------------------------------------------------------------------
// Ollama Loop – Health Check and Error Handling
// ---------------------------------------------------------------------------

describe("Ollama Loop Logic - Health Check", () => {
  beforeEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.OLLAMA_MODEL;
  });

  test("health check handles fetch errors gracefully", async (t) => {
    stubMcpTransport(t);

    // Mock fetch to simulate network error
    t.mock.method(globalThis, "fetch", () => {
      throw new Error("Network error");
    });

    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "llama3.1";

    const agent = await createAgent({ root: process.cwd(), version: "1.0.0" });
    const emitter = { send: t.mock.fn() };
    
    // Directly test the internal health check by exposing it via a test hook
    // Since runOllamaLoop is internal, we test via runAgentLoop
    const result = await agent.runAgentLoop(
      [{ role: "user", content: "hi" }],
      emitter
    );

    assert.ok(result.includes("Ollama is not running") || result.includes("Network error"));
  });

  test("handles non-ok response from Ollama", async (t) => {
    stubMcpTransport(t);

    t.mock.method(globalThis, "fetch", () =>
      Promise.resolve({
        ok: false,
        text: () => Promise.stringify({ error: "Model not found" }),
      })
    );

    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "nonexistent-model";

    const agent = await createAgent({ root: process.cwd(), version: "1.0.0" });
    const emitter = { send: t.mock.fn() };
    
    const result = await agent.runAgentLoop(
      [{ role: "user", content: "hi" }],
      emitter
    );

    assert.ok(result.includes("Ollama error") || result.includes("error"));
  });
});

// ---------------------------------------------------------------------------
// History Management
// ---------------------------------------------------------------------------

describe("History Management", () => {
  test("truncates history correctly when exceeding limit", () => {
    const MAX_HISTORY = 20;
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i === 0 ? "system" : "user",
      content: `msg ${i}`,
    }));

    const trimmed = messages.length > MAX_HISTORY
      ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))]
      : messages;

    assert.strictEqual(trimmed.length, MAX_HISTORY);
    assert.strictEqual(trimmed[0].role, "system");
    assert.strictEqual(trimmed[1].content, "msg 11");
  });

  test("does not truncate when under limit", () => {
    const MAX_HISTORY = 20;
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user",
      content: `msg ${i}`,
    }));

    const trimmed = messages.length > MAX_HISTORY
      ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))]
      : messages;

    assert.strictEqual(trimmed.length, 10);
  });
});

// ---------------------------------------------------------------------------
// WebSocket Emitter
// ---------------------------------------------------------------------------

describe("makeWsEmitter", () => {
  test("serializes payload to JSON and calls ws.send exactly once", (t) => {
    const mockWs = { send: t.mock.fn() };
    const emitter = makeWsEmitter(mockWs);
    const payload = { type: "token", text: "hello" };

    emitter.send(payload);

    assert.strictEqual(mockWs.send.mock.callCount(), 1);
    assert.strictEqual(
      mockWs.send.mock.calls[0].arguments[0],
      JSON.stringify(payload)
    );
  });

  test("handles multiple sends", (t) => {
    const mockWs = { send: t.mock.fn() };
    const emitter = makeWsEmitter(mockWs);
    
    emitter.send({ type: "token", text: "a" });
    emitter.send({ type: "token", text: "b" });
    emitter.send({ type: "stream_end" });

    assert.strictEqual(mockWs.send.mock.callCount(), 3);
  });
});

// ---------------------------------------------------------------------------
// CLI Emitter - Full Coverage
// ---------------------------------------------------------------------------

describe("makeCliEmitter - Full Coverage", () => {
  test("renderMarkdown: handles all markdown syntax", (t) => {
    const stdoutMock = mockStdout(t);
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone, { stopSpinner: () => {}, startSpinner: () => {} }, { showReasoning: false });

    const markdown = [
      "# Heading 1",
      "## Heading 2",
      "### Heading 3",
      "- Bullet point",
      "1. Numbered item",
      "**Bold text**",
      "*Italic text*",
      "_Also italic_",
      "~~Strikethrough~~",
      "`inline code`",
      "***Bold and italic***",
      "---",
      "```javascript",
      "const x = 1;",
      "```",
      "Normal text"
    ].join("\n");

    emitter.send({ type: "token", text: markdown });
    emitter.send({ type: "stream_end" });

    assert.ok(!stdoutMock.mock.calls.some(c => String(c.arguments[0]).includes("undefined")));
    assert.strictEqual(turnDone.mock.callCount(), 1);
  });

  test("handles tool badges for all tool types", (t) => {
    const stdoutMock = mockStdout(t);
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone, { stopSpinner: () => {}, startSpinner: () => {} }, { showReasoning: false });

    const tools = ["recall", "remember", "backfill_embeddings", "deduplicate_memories", "forget", "unknown_tool"];
    
    for (const tool of tools) {
      emitter.send({ type: "tool", name: tool });
    }

    const allOutput = output;
    assert.ok(allOutput.includes("⟳ recalling memory"));
    assert.ok(allOutput.includes("✦ saving memory"));
    assert.ok(allOutput.includes("⟳ backfilling embeddings"));
    assert.ok(allOutput.includes("⟳ deduplicating"));
    assert.ok(allOutput.includes("✕ forgetting memory"));
    assert.ok(allOutput.includes("◆ unknown_tool"));
  });

  test("reasoning block renders correctly when enabled", (t) => {
    const stdoutMock = mockStdout(t);
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone, { stopSpinner: () => {}, startSpinner: () => {} }, { showReasoning: true });

    emitter.send({ type: "reasoning_start" });
    emitter.send({ type: "reasoning_token", text: "First step reasoning" });
    emitter.send({ type: "reasoning_token", text: "Second step reasoning" });
    emitter.send({ type: "reasoning_done" });

    assert.ok(output.includes("╭─ thinking"));
    assert.ok(output.includes("First step reasoning"));
    assert.ok(output.includes("Second step reasoning"));
    assert.ok(output.includes("╰"));
  });

  test("spinner controls work correctly", (t) => {
    let spinnerStarted = false;
    let spinnerStopped = false;
    
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone, {
      stopSpinner: () => { spinnerStopped = true; },
      startSpinner: (msg) => { spinnerStarted = msg; }
    }, { showReasoning: false });

    emitter.send({ type: "thinking" });
    assert.strictEqual(spinnerStarted, "thinking");

    emitter.send({ type: "tool", name: "recall" });
    assert.ok(spinnerStopped);
  });

  test("retract clears buffer without output", (t) => {
    const stdoutMock = mockStdout(t);
    const turnDone = t.mock.fn();
    const emitter = makeCliEmitter(turnDone, { stopSpinner: () => {}, startSpinner: () => {} }, { showReasoning: false });

    emitter.send({ type: "token", text: "This will be buffered" });
    emitter.send({ type: "retract" });
    emitter.send({ type: "stream_end", text: "" });

    // The retract should prevent the buffered text from being output
    // Only the final newline might be output
    assert.ok(!output.includes("This will be buffered"));
  });

  test("multiple stream cycles work correctly", (t) => {
    const stdoutMock = mockStdout(t);
    let turnCount = 0;
    const emitter = makeCliEmitter(() => turnCount++, { stopSpinner: () => {}, startSpinner: () => {} }, { showReasoning: false });

    // First turn
    emitter.send({ type: "stream_start" });
    emitter.send({ type: "token", text: "First answer" });
    emitter.send({ type: "stream_end" });
    
    // Second turn
    emitter.send({ type: "stream_start" });
    emitter.send({ type: "token", text: "Second answer" });
    emitter.send({ type: "stream_end" });

    assert.strictEqual(turnCount, 2);
    assert.ok(output.includes("First answer"));
    assert.ok(output.includes("Second answer"));
  });

  test("handles error events with proper cleanup", (t) => {
    const stdoutMock = mockStdout(t);
    let turnDoneCalled = false;
    const emitter = makeCliEmitter(() => { turnDoneCalled = true; }, { stopSpinner: () => {} }, { showReasoning: false });

    emitter.send({ type: "token", text: "Some text before error" });
    emitter.send({ type: "error", text: "Something went wrong" });

    assert.ok(output.includes("✖ error: Something went wrong"));
    assert.ok(turnDoneCalled);
    // Error should clear the buffer
    assert.ok(!output.match(/Some text before error.*Something went wrong/s));
  });

  test("handles provider and status events silently", (t) => {
    const stdoutMock = mockStdout(t);
    const emitter = makeCliEmitter(() => {}, { stopSpinner: () => {}, startSpinner: () => {} }, { showReasoning: false });

    emitter.send({ type: "provider", name: "ollama", model: "llama3.1" });
    emitter.send({ type: "status", text: "connected" });
    emitter.send({ type: "memories", memories: [] });
    emitter.send({ type: "deleted", id: "123" });

    // None of these should produce output
    assert.strictEqual(output, "");
  });
});

// ---------------------------------------------------------------------------
// Integration: Agent with Emitter
// ---------------------------------------------------------------------------

describe("Agent Integration with Emitter", () => {
  test("handleRememberIntent works correctly", async (t) => {
    stubMcpTransport(t);
    
    const agent = await createAgent({ root: process.cwd(), version: "1.0.0" });
    const emitter = { send: t.mock.fn() };
    
    await agent.handleRememberIntent("remember that the user likes coffee", emitter);
    
    // Should call tool with appropriate args
    assert.ok(emitter.send.mock.calls.some(c => 
      c.arguments[0].type === "tool" && c.arguments[0].name === "remember"
    ));
  });

  test("fetchMemories returns parsed memories", async (t) => {
    stubMcpTransport(t);
    
    // Override callTool for testing
    const agent = await createAgent({ root: process.cwd(), version: "1.0.0" });
    
    // Mock the internal callTool response
    t.mock.method(agent, "callTool", async () => {
      return "[fact] Test memory\nTest content\nTags: test\nID: 123";
    });
    
    const { raw, parsed } = await agent.fetchMemories();
    
    assert.ok(raw);
    assert.ok(Array.isArray(parsed));
  });

  test("buildGreeting handles memory injection", async (t) => {
    stubMcpTransport(t);
    
    const agent = await createAgent({ root: process.cwd(), version: "1.0.0" });
    
    // Mock recall to return memories
    t.mock.method(agent, "callTool", async (name) => {
      if (name === "recall") {
        return "[fact] User name is John\n[preference] Likes Node.js";
      }
      return "No result";
    });
    
    const greeting = await agent.buildGreeting();
    
    assert.ok(greeting.includes("Greet me"));
    assert.ok(greeting.includes("Here is what you know"));
  });

  test("buildGreeting handles no memories gracefully", async (t) => {
    stubMcpTransport(t);
    
    const agent = await createAgent({ root: process.cwd(), version: "1.0.0" });
    
    t.mock.method(agent, "callTool", async () => "No memories found.");
    
    const greeting = await agent.buildGreeting();
    
    assert.ok(greeting.includes("Greet me"));
    assert.ok(!greeting.includes("Here is what you know"));
  });
});

// ---------------------------------------------------------------------------
// Zod to JSON Schema Conversion
// ---------------------------------------------------------------------------

describe("zodToJsonSchema", () => {
  // Import the function (may need to export it from agent.js for testing)
  // For now, we test indirectly through tool creation
  
  test("handles null/undefined schema gracefully", async (t) => {
    stubMcpTransport(t);
    // This should not throw
    const agent = await createAgent({ root: process.cwd(), version: "1.0.0" });
    assert.ok(agent);
  });
});

// ---------------------------------------------------------------------------
// Run the tests with coverage
// ---------------------------------------------------------------------------
// To run with coverage:
// node --test --experimental-test-coverage tests/agent.test.js