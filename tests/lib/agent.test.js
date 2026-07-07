// tests/agent.test.js
import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
  getRecommendedModel,
  resolveProvider,
  parseMemoriesRaw,
  isRetrievalQuestion,
  createAgent,
  zodToJsonSchema,
  persistAnswerArtifacts,
} from "../../lib/agent.js";
import fs from "node:fs";
import path from "node:path";
import { fixUnclosedFence } from "../../lib/helpers/validateOutput.js";
import { makeWsEmitter } from "../../lib/emitters/wsEmitter.js";
import { makeCliEmitter } from "../../lib/emitters/cliEmitter.js";

// Synthetic root — never a real path on the user's machine.
// createAgent wraps all readFileSync calls in try/catch, so missing
// prompt/skill/locale files silently fall back to empty defaults.
const FAKE_ROOT = "/fake/project";

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

  // Make Client.callTool() succeed with a neutral "no memories" response so
  // internal callTool closures don't throw "Not connected".
  t.mock.method(Client.prototype, "callTool", async () => ({
    content: [{ type: "text", text: "No memories found." }],
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

  test("isRetrievalQuestion fires on memory-lookup phrasing, not on work prompts", () => {
    // The exact QWEN3 failure cases that prompted Layer 2 (deterministic recall).
    for (const q of [
      "do I have any meeting today?",
      "do you recall any memories for that?",
      "what do you know about my deadlines",
      "any reminders about the dentist",
    ]) assert.ok(isRetrievalQuestion(q), `should detect: "${q}"`);

    // False positives only cost an extra recall, but obvious work prompts and
    // bare modal "do I have to" must not trigger it.
    for (const q of [
      "write a function to add two numbers",
      "do I have to refactor this",
      "",
    ]) assert.ok(!isRetrievalQuestion(q), `should NOT detect: "${q}"`);
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
  test("selects qwen3:30b-a3b for 48 GB+ RAM", () => {
    mock.method(os, "totalmem", () => 64 * 1024 ** 3);
    assert.strictEqual(getRecommendedModel(), "qwen3:30b-a3b");
  });

  test("selects gemma4:12b for 24-48 GB RAM", () => {
    mock.method(os, "totalmem", () => 32 * 1024 ** 3);
    assert.strictEqual(getRecommendedModel(), "gemma4:12b");
  });

  test("selects gemma4:e4b for 8-24 GB RAM (most capable that fits low hardware)", () => {
    mock.method(os, "totalmem", () => 16 * 1024 ** 3);
    assert.strictEqual(getRecommendedModel(), "gemma4:e4b");
  });

  test("selects qwen2.5:3b for low RAM (<8 GB) — low budget, runs anywhere", () => {
    mock.method(os, "totalmem", () => 4 * 1024 ** 3);
    assert.strictEqual(getRecommendedModel(), "qwen2.5:3b");
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

  test("uses default llama3.1 when no OLLAMA_MODEL is set", () => {
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
    
    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0" });

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

  test("createAgent builds a compatibility AgentSpec for legacy callers", async (t) => {
    stubMcpTransport(t);

    const agent = await createAgent({
      root: FAKE_ROOT,
      version: "1.0.0",
      clientName: "legacy-agent",
      providerConfig: { name: "deepseek", model: "deepseek-v4-flash" },
      persona: "reviewer",
      character: "security-engineer",
    });

    assert.equal(agent.spec.id, "legacy-agent");
    assert.deepEqual(agent.spec.provider, { name: "deepseek", model: "deepseek-v4-flash" });
    assert.equal(agent.persona, "reviewer");
    assert.equal(agent.character, "security-engineer");
    assert.equal(agent.spec.toolAllowlist, null, "legacy callers keep unrestricted dynamic tools");
    assert.deepEqual(agent.mcpTools.map(t => t.name), ["test_tool", "recall", "remember"]);
  });

  test("explicit AgentSpec overrides provider, persona, character, and identity prompt", async (t) => {
    stubMcpTransport(t);

    const agent = await createAgent({
      root: FAKE_ROOT,
      version: "1.0.0",
      providerConfig: { name: "ollama", model: "ignored" },
      persona: "ignored-persona",
      character: "ignored-character",
      spec: {
        id: "specified",
        provider: { name: "deepseek", model: "deepseek-v4-flash" },
        identity: { persona: "architect", prompt: "SPEC IDENTITY PROMPT" },
        character: "software-architect",
        toolAllowlist: null,
      },
    });

    assert.equal(agent.provider.name, "deepseek");
    assert.equal(agent.provider.model, "deepseek-v4-flash");
    assert.equal(agent.persona, "architect");
    assert.equal(agent.character, "software-architect");
    assert.equal(agent.spec.id, "specified");
    assert.match(agent.getSystemPrompt("hi"), /SPEC IDENTITY PROMPT/);
  });

  test("explicit AgentSpec tool allowlist filters provider-visible MCP tools", async (t) => {
    stubMcpTransport(t);

    const agent = await createAgent({
      root: FAKE_ROOT,
      version: "1.0.0",
      providerConfig: { name: "deepseek", model: "deepseek-v4-flash" },
      spec: {
        id: "recall-only",
        toolAllowlist: ["recall"],
      },
    });

    assert.deepEqual(agent.mcpTools.map(t => t.name), ["recall"]);
    assert.equal(agent.getToolCount("remember this and recall it", [{ role: "user", content: "remember this and recall it" }]), 1);
    assert.ok(agent.getAnthropicTools("remember this", [{ role: "user", content: "remember this" }]).every(t => t.name === "recall"));
    assert.deepEqual(
      agent.getOllamaTools("remember this", [{ role: "user", content: "remember this" }]).map(t => t.function.name),
      ["recall"],
    );
    assert.deepEqual(
      agent.getGeminiTools("remember this", [{ role: "user", content: "remember this" }])[0].functionDeclarations.map(t => t.name),
      ["recall"],
    );
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

    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0" });
    const emitter = { send: t.mock.fn() };
    
    // Directly test the internal health check by exposing it via a test hook
    // Since runOllamaLoop is internal, we test via runAgentLoop
    const result = await agent.runAgentLoop(
      [{ role: "user", content: "hi" }],
      emitter
    );

    assert.ok(result.includes("Ollama is not running") || result.includes("Network error"));
    const trace = agent.getLifecycleTrace();
    assert.ok(trace.entries.some(entry =>
      entry.hook === "beforeModel" &&
      entry.middleware === "context-trimming"));
    assert.ok(trace.entries.some(entry =>
      entry.hook === "selectTools" &&
      entry.middleware === "tool-profile-selection"));
    assert.equal(trace.stats.retained, trace.entries.length);
    assert.doesNotMatch(JSON.stringify(trace), /Network error|\"content\":\"hi\"/);
  });

  test("handles non-ok response from Ollama", async (t) => {
    stubMcpTransport(t);

    t.mock.method(globalThis, "fetch", (url) => {
      // Let the health check (/api/tags) pass so the chat request is attempted
      if (String(url).includes("/api/tags")) return Promise.resolve({ ok: true });
      return Promise.resolve({
        ok: false,
        text: () => Promise.resolve(JSON.stringify({ error: "Model not found" })),
      });
    });

    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "nonexistent-model";

    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0" });
    const emitter = { send: t.mock.fn() };
    
    const result = await agent.runAgentLoop(
      [{ role: "user", content: "hi" }],
      emitter
    );

    assert.ok(result.includes("Ollama error") || result.includes("error"));
  });
});

// ---------------------------------------------------------------------------
// run_shell cwd injection (callToolHooked)
// ---------------------------------------------------------------------------
//
// run_shell executes in the MCP subprocess, where getActiveScratchDir() is
// always null — so it cannot default its own working directory. callToolHooked
// (main process) must inject a cwd before the call crosses the MCP boundary:
// the session scratch dir if it exists, else the project root. We drive a full
// runAgentLoop through the Ollama loop, have the mocked model emit a run_shell
// tool call, and assert on the arguments that reach Client.prototype.callTool
// (the MCP boundary).

describe("run_shell cwd injection", () => {
  // run_shell is only offered to the model when shell is enabled (globally + for
  // local Ollama models) AND the model is trusted (listed in APERIO_CAPABLE_MODELS).
  // These gates landed after this test was written; set them so run_shell actually
  // reaches the model and the cwd-injection hook runs.
  let savedEnv;
  beforeEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.OLLAMA_MODEL;
    savedEnv = {
      APERIO_ENABLE_SHELL:   process.env.APERIO_ENABLE_SHELL,
      APERIO_SHELL_LOCAL:    process.env.APERIO_SHELL_LOCAL,
      APERIO_CAPABLE_MODELS: process.env.APERIO_CAPABLE_MODELS,
    };
    process.env.APERIO_ENABLE_SHELL   = "1";
    process.env.APERIO_SHELL_LOCAL    = "1";
    process.env.APERIO_CAPABLE_MODELS = "llama3.1";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  // Build an SSE chunk that mimics one OpenAI-style streaming delta.
  const sse = (delta) => "data: " + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + "\n";
  const DONE = "data: [DONE]\n";

  // Drive a single turn where the model calls run_shell with `shellArgs`, then
  // returns a final answer. Returns the args that reached the MCP boundary.
  async function runShellTurn(t, shellArgs) {
    stubMcpTransport(t);

    // The shared stub's tool list omits run_shell — add it so it's an available
    // MCP tool that gets offered to the model and routed through the cwd hook.
    t.mock.method(Client.prototype, "listTools", async () => ({
      tools: [
        { name: "recall",    description: "Recall memories", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
        { name: "run_shell", description: "Run a shell command", inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } } } },
      ],
    }));

    // Capture what crosses into the MCP subprocess.
    const captured = [];
    t.mock.method(Client.prototype, "callTool", async ({ name, arguments: args }) => {
      captured.push({ name, args });
      return { content: [{ type: "text", text: "ok" }] };
    });

    // First chat completion → a run_shell tool call; second → a final answer.
    let chatCalls = 0;
    t.mock.method(globalThis, "fetch", (url) => {
      if (String(url).includes("/api/tags")) return Promise.resolve({ ok: true });
      chatCalls++;
      const chunks = chatCalls === 1
        ? [sse({ tool_calls: [{ index: 0, id: "call_1", function: { name: "run_shell", arguments: JSON.stringify(shellArgs) } }] }), DONE]
        : [sse({ content: "Done." }), DONE];
      return Promise.resolve(createMockResponseStream(chunks));
    });

    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "llama3.1";

    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0" });
    await agent.runAgentLoop([{ role: "user", content: "please run ls" }], { send: t.mock.fn() });

    return captured.find((c) => c.name === "run_shell");
  }

  test("injects the project root as cwd when the model omits it", async (t) => {
    const call = await runShellTurn(t, { command: "ls" });
    assert.ok(call, "run_shell should reach the MCP boundary");
    assert.strictEqual(call.args.command, "ls");
    // No session scratch dir exists in the test, so the agent falls back to
    // process.cwd() at tool-execution time (independent of the createAgent root).
    assert.strictEqual(call.args.cwd, process.cwd());
  });

  test("preserves an explicit cwd supplied by the model", async (t) => {
    const call = await runShellTurn(t, { command: "ls", cwd: "/some/allowed/path" });
    assert.ok(call, "run_shell should reach the MCP boundary");
    assert.strictEqual(call.args.cwd, "/some/allowed/path");
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
    
    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0" });
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
    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0" });
    
    // Mock the internal callTool response
    t.mock.method(agent, "callTool", async () => {
      return "[fact] Test memory\nTest content\nTags: test\nID: 123";
    });
    
    const { raw, parsed } = await agent.fetchMemories();
    
    assert.ok(raw);
    assert.ok(Array.isArray(parsed));
  });

  test("buildGreeting gives tool-capable models a recall pointer, not preloaded content", async (t) => {
    stubMcpTransport(t);

    // Memory is no longer preloaded as content. A tool-capable model (the default
    // anthropic provider) gets a lightweight pointer in memCtx — the memory count
    // plus an instruction to call `recall` — so it fetches memories query-scoped
    // on demand instead of carrying a blind top-N. See refreshSessionMemCtx.
    t.mock.method(Client.prototype, "callTool", async ({ name }) => {
      if (name === "recall") {
        return { content: [{ type: "text", text: "[fact] User name is John\n---\n[preference] Likes Node.js" }] };
      }
      return { content: [{ type: "text", text: "OK" }] };
    });

    // Pin a tool-capable cloud provider (independent of AI_PROVIDER leaked by
    // earlier tests); deepseek constructs no SDK client, so no API key is needed.
    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0", providerConfig: { name: "deepseek", model: "deepseek-v4-flash" } });

    const { prompt, memCtx, preloadedMemCount } = await agent.buildGreeting();

    assert.ok(prompt.includes("Greet me"));
    assert.ok(!memCtx.includes("User name is John"), "memory content must NOT be preloaded");
    assert.match(memCtx, /stored outside this conversation/, "memCtx must be the recall pointer");
    assert.match(memCtx, /2 saved memories/, "pointer states the memory count");
    assert.match(memCtx, /recall/, "pointer steers the model to recall");
    assert.strictEqual(preloadedMemCount, 2);
  });

  test("local (Ollama) models get no memory pointer — memory is skipped entirely", async (t) => {
    stubMcpTransport(t);

    // Weak/local models can't make good use of memory and shouldn't burn tokens on
    // it. Even with memories in the store, an Ollama agent gets an empty memCtx and
    // reports zero to the banner. See refreshSessionMemCtx.
    t.mock.method(Client.prototype, "callTool", async ({ name }) => {
      if (name === "recall") {
        return { content: [{ type: "text", text: "[fact] User name is John\n---\n[fact] Likes Node" }] };
      }
      return { content: [{ type: "text", text: "OK" }] };
    });

    const agent = await createAgent({
      root: FAKE_ROOT, version: "1.0.0",
      providerConfig: { name: "ollama", model: "qwen2.5:3b" },
    });

    const { memCtx, preloadedMemCount } = await agent.buildGreeting();

    assert.strictEqual(memCtx, "", "Ollama models must not get a memory pointer");
    assert.strictEqual(preloadedMemCount, 0, "no memories reported to the banner");
    assert.strictEqual(agent.toolsEnabled, false, "weak Ollama models are offered no tools");
    assert.strictEqual(agent.getToolCount("read my files", []), 0, "tool count is zero for weak models");
  });

  test("an allowlisted (APERIO_CAPABLE_MODELS) Ollama model gets memory + tools", async (t) => {
    stubMcpTransport(t);
    const prev = process.env.APERIO_CAPABLE_MODELS;
    process.env.APERIO_CAPABLE_MODELS = "qwen3:32b, llama3.1:70b";
    t.after(() => { if (prev === undefined) delete process.env.APERIO_CAPABLE_MODELS; else process.env.APERIO_CAPABLE_MODELS = prev; });

    t.mock.method(Client.prototype, "callTool", async ({ name }) => {
      if (name === "recall") return { content: [{ type: "text", text: "[fact] User name is John" }] };
      return { content: [{ type: "text", text: "OK" }] };
    });

    const agent = await createAgent({
      root: FAKE_ROOT, version: "1.0.0",
      providerConfig: { name: "ollama", model: "qwen3:32b" },
    });

    const { memCtx } = await agent.buildGreeting();

    assert.strictEqual(agent.toolsEnabled, true, "allowlisted Ollama models are capable");
    assert.match(memCtx, /1 saved memory\b/, "allowlisted models get the recall pointer");
  });

  test("buildGreeting handles no memories gracefully", async (t) => {
    stubMcpTransport(t);

    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0" });

    t.mock.method(agent, "callTool", async () => "No memories found.");

    const { prompt, memCtx, preloadedMemCount } = await agent.buildGreeting();

    assert.ok(prompt.includes("Greet me"));
    assert.strictEqual(memCtx, "");
    assert.strictEqual(preloadedMemCount, 0);
  });

  test("the memory pointer persists into later turns' system prompt, not just the greeting", async (t) => {
    stubMcpTransport(t);

    // Regression: memCtx used to be injected only on the greeting turn, so on the
    // user's first real question the model had no memory context. buildGreeting
    // persists the pointer on the agent, so every turn's system prompt carries it.
    t.mock.method(Client.prototype, "callTool", async ({ name }) => {
      if (name === "recall") {
        return { content: [{ type: "text", text: "[fact] User name is John\n---\n[preference] Likes Node.js" }] };
      }
      return { content: [{ type: "text", text: "OK" }] };
    });

    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0", providerConfig: { name: "deepseek", model: "deepseek-v4-flash" } });

    // Before the greeting, the pointer isn't there yet.
    assert.ok(!agent.getSystemPrompt("hi").includes("stored outside this conversation"),
      "no memory pointer before buildGreeting");

    await agent.buildGreeting();

    // A later, ordinary turn (not the greeting) must still carry the pointer.
    const laterTurn = agent.getSystemPrompt("what do you know about me?", "en", "", [
      { role: "user", content: "what do you know about me?" },
    ]);
    assert.match(laterTurn, /stored outside this conversation/,
      "memory pointer must persist into later turns' system prompt");
    assert.match(laterTurn, /2 saved memories/, "pointer states the memory count");
  });

  test("a memory saved mid-session updates the pointer count", async (t) => {
    stubMcpTransport(t);

    // The greeting-time pointer is built once; a write later in the session must
    // re-load it so the count reflects the new memory on subsequent turns. The
    // write goes through callTool, which triggers the refresh for memory-write
    // tools.
    let saved = false;
    t.mock.method(Client.prototype, "callTool", async ({ name }) => {
      if (name === "recall") {
        const text = saved
          ? "[fact] User name is John\n---\n[fact] User loves sushi"
          : "[fact] User name is John";
        return { content: [{ type: "text", text }] };
      }
      if (name === "remember") { saved = true; return { content: [{ type: "text", text: "Saved." }] }; }
      return { content: [{ type: "text", text: "OK" }] };
    });

    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0", providerConfig: { name: "deepseek", model: "deepseek-v4-flash" } });
    await agent.buildGreeting();

    assert.match(agent.getSystemPrompt("hi"), /1 saved memory\b/,
      "pointer starts at one memory");

    await agent.callTool("remember", { type: "fact", title: "sushi", content: "User loves sushi" });

    assert.match(agent.getSystemPrompt("and now?"), /2 saved memories/,
      "saving a memory mid-session bumps the pointer count");
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
    const agent = await createAgent({ root: FAKE_ROOT, version: "1.0.0" });
    assert.ok(agent);
  });
});

// ---------------------------------------------------------------------------
// zodToJsonSchema direct tests
// ---------------------------------------------------------------------------

describe("zodToJsonSchema direct", () => {
  test("returns empty schema for null input", () => {
    const result = zodToJsonSchema(null);
    assert.deepStrictEqual(result, { type: "object", properties: {}, required: [] });
  });

  test("returns empty schema for undefined input", () => {
    const result = zodToJsonSchema(undefined);
    assert.deepStrictEqual(result, { type: "object", properties: {}, required: [] });
  });

  test("maps z.string() field to string type", () => {
    const schema = z.object({ name: z.string() });
    const result = zodToJsonSchema(schema);
    assert.strictEqual(result.properties.name.type, "string");
  });

  test("maps z.number() field to number type", () => {
    const schema = z.object({ age: z.number() });
    const result = zodToJsonSchema(schema);
    assert.strictEqual(result.properties.age.type, "number");
  });

  test("maps z.boolean() field to boolean type", () => {
    const schema = z.object({ active: z.boolean() });
    const result = zodToJsonSchema(schema);
    assert.strictEqual(result.properties.active.type, "boolean");
  });

  test("maps z.array(z.string()) field to array type", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const result = zodToJsonSchema(schema);
    assert.strictEqual(result.properties.tags.type, "array");
  });

  test('maps z.enum(["a","b"]) field to string type', () => {
    const schema = z.object({ color: z.enum(["a", "b"]) });
    const result = zodToJsonSchema(schema);
    assert.strictEqual(result.properties.color.type, "string");
  });

  test("marks required fields (non-optional) in the required array", () => {
    const schema = z.object({ name: z.string() });
    const result = zodToJsonSchema(schema);
    assert.ok(result.required.includes("name"));
  });

  test("does NOT mark optional fields as required", () => {
    const schema = z.object({ nickname: z.string().optional() });
    const result = zodToJsonSchema(schema);
    assert.ok(!result.required.includes("nickname"));
  });

  test("handles a schema with mixed required and optional fields", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      nickname: z.string().optional(),
    });
    const result = zodToJsonSchema(schema);
    assert.ok(result.required.includes("name"));
    assert.ok(result.required.includes("age"));
    assert.ok(!result.required.includes("nickname"));
    assert.strictEqual(result.properties.name.type, "string");
    assert.strictEqual(result.properties.age.type, "number");
    assert.strictEqual(result.properties.nickname.type, "string");
  });
});

// ---------------------------------------------------------------------------
// Provider resolution – DeepSeek
// ---------------------------------------------------------------------------

describe("Provider resolution - DeepSeek", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("resolves deepseek provider with correct fields", () => {
    process.env.AI_PROVIDER = "deepseek";
    process.env.DEEPSEEK_MODEL = "deepseek-coder";
    process.env.DEEPSEEK_API_KEY = "sk-test";

    const p = resolveProvider();
    assert.strictEqual(p.name, "deepseek");
    assert.strictEqual(p.model, "deepseek-coder");
    assert.strictEqual(p.baseURL, "https://api.deepseek.com/v1");
    assert.strictEqual(p.apiKey, "sk-test");
    assert.strictEqual(p.vision, false);
    assert.strictEqual(p.ollamaBaseURL, null);
  });

  test("enables vision only for deepseek-v4-pro, not flash", () => {
    process.env.AI_PROVIDER = "deepseek";
    process.env.DEEPSEEK_API_KEY = "sk-test";

    process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";
    assert.strictEqual(resolveProvider().vision, true);

    process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
    assert.strictEqual(resolveProvider().vision, false);
  });
});

describe("persistAnswerArtifacts()", () => {
  // Uses isolated temp dirs (os.tmpdir) — cleaned up after each test.
  // The function under test writes files via mkdirSync/writeFileSync;
  // the temp dir is scoped to this describe block only.
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "answer-artifacts-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const bigHtml = "<!DOCTYPE html>\n<html><head><title>WealthPath Dashboard</title></head>\n" +
    Array.from({ length: 30 }, (_, i) => `<div>row ${i}</div>`).join("\n") + "\n</html>";

  test("writes a fenced HTML deliverable to scratch intact", () => {
    const text = "Here you go:\n```html\n" + bigHtml + "\n```";
    const n = persistAnswerArtifacts(text, dir);
    assert.equal(n, 1);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{8}-wealthpath-dashboard\.html$/);
    const content = fs.readFileSync(path.join(dir, files[0]), "utf8");
    assert.ok(content.includes("WealthPath Dashboard") && content.includes("row 29"));
  });

  test("persists HTML from a bare ``` fence (no language tag)", () => {
    const text = "Here:\n```\n" + bigHtml + "\n```\nPreview above.";
    assert.equal(persistAnswerArtifacts(text, dir), 1);
    assert.match(fs.readdirSync(dir)[0], /\.html$/);
  });

  test("persists RAW unfenced HTML wrapped in <pre><code>", () => {
    const text = "Brief…\n\n<pre><code>\n" + bigHtml + "\n</code></pre>\n\nPreview the page above.";
    assert.equal(persistAnswerArtifacts(text, dir), 1);
    const content = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8");
    assert.ok(content.startsWith("<!DOCTYPE html>") && content.includes("row 29"));
  });

  test("ignores small snippets and non-deliverable languages", () => {
    const text = "```js\nconsole.log(1)\n```\n```css\nbody{color:red}\n```\n```html\n<p>tiny</p>\n```";
    assert.equal(persistAnswerArtifacts(text, dir), 0);
    assert.equal(fs.readdirSync(dir).length, 0);
  });

  test("returns 0 with no scratch dir", () => {
    assert.equal(persistAnswerArtifacts("```html\n" + bigHtml + "\n```", null), 0);
  });

  test("creates the scratch dir if it doesn't exist yet", () => {
    const missing = path.join(dir, "session-never-created");
    const bigMd = "# Title\n\n" + Array.from({ length: 30 }, (_, i) => `- item ${i}`).join("\n");
    assert.equal(persistAnswerArtifacts("Here:\n```md\n" + bigMd + "\n```", missing), 1);
    assert.match(fs.readdirSync(missing)[0], /^[0-9a-f]{8}-build-1\.md$/);
  });
});

// ---------------------------------------------------------------------------
// Run the tests with coverage
// ---------------------------------------------------------------------------
// To run with coverage:
// node --test --experimental-test-coverage tests/agent.test.js
