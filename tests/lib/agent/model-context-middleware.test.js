import test from "node:test";
import assert from "node:assert/strict";
import { createLifecycleRunner } from "../../../lib/agent/middleware.js";
import {
  MODEL_CONTEXT_MIDDLEWARE_NAMES,
  TOOL_RESULT_OFFLOAD_MIDDLEWARE_NAME,
  createModelContextMiddleware,
  createToolResultOffloadMiddleware,
} from "../../../lib/agent/model-context-middleware.js";

const noop = () => {};
const logger = { info: noop, warn: noop };

test("composes trimming, memory pointers, skills, and tool profiles in named order", async () => {
  const events = [];
  const calls = [];
  const messages = [
    { role: "user", content: "oldest" },
    { role: "assistant", content: "older" },
    { role: "user", content: "previous" },
    { role: "assistant", content: "recent" },
    { role: "user", content: "current request" },
  ];
  const turn = { skills: [{ name: "docs" }] };
  const tools = [{ name: "read_file", inputSchema: { type: "object" } }];
  const middleware = createModelContextMiddleware({
    emitter: { send: event => events.push(event) },
    logger,
    maxHistory: 3,
    getMemoryPointers: () => ["MEMORY POINTER"],
    ensureTurn(receivedMessages, userText) {
      calls.push(["ensureTurn", receivedMessages.length, userText]);
      return turn;
    },
    logTurnOnce(receivedTurn) {
      calls.push(["logTurnOnce", receivedTurn]);
    },
    getSkillPrompts(receivedTurn) {
      calls.push(["getSkillPrompts", receivedTurn]);
      return ["SKILL PROMPT"];
    },
    getSelectedTools(receivedTurn) {
      calls.push(["getSelectedTools", receivedTurn]);
      return tools;
    },
  });
  const runner = createLifecycleRunner(middleware);

  assert.deepEqual(runner.middlewareNames, MODEL_CONTEXT_MIDDLEWARE_NAMES);
  const prepared = await runner.run("beforeModel", {
    messages,
    observedInputTokens: 0,
    contextWindow: 100_000,
    providerLabel: "test",
    promptParts: ["BASE"],
  });
  const selected = await runner.run("selectTools", {
    messages: prepared.request.messages,
    userText: prepared.request.userText,
    turn: prepared.request.turn,
    tools: [],
  });

  assert.deepEqual(prepared.request.messages, [
    messages[0],
    messages[3],
    messages[4],
  ]);
  assert.equal(prepared.request.userText, "current request");
  assert.deepEqual(prepared.request.promptParts, [
    "BASE",
    "MEMORY POINTER",
    "SKILL PROMPT",
  ]);
  assert.deepEqual(selected.request.tools, tools);
  assert.deepEqual(calls, [
    ["ensureTurn", 3, "current request"],
    ["logTurnOnce", turn],
    ["getSkillPrompts", turn],
    ["logTurnOnce", turn],
    ["getSelectedTools", turn],
  ]);
  assert.deepEqual(events, []);
  assert.deepEqual(messages[1], { role: "assistant", content: "older" });
});

test("context trimming emits the existing bounded event without mutating history", async () => {
  const events = [];
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: "x".repeat(2_000),
  }));
  const original = structuredClone(messages);
  const runner = createLifecycleRunner(createModelContextMiddleware({
    emitter: { send: event => events.push(event) },
    logger,
    getMemoryPointers: () => [],
    ensureTurn: () => ({ skills: [] }),
    logTurnOnce: noop,
    getSkillPrompts: () => [],
    getSelectedTools: () => [],
  }));

  const result = await runner.run("beforeModel", {
    messages,
    observedInputTokens: 20_000,
    contextWindow: 4_000,
    providerLabel: "ollama",
    promptParts: [],
  });

  assert.ok(result.request.dropped > 0);
  assert.equal(events.some(event =>
    event.type === "context_trimmed" &&
    event.dropped === result.request.dropped &&
    event.pct === result.request.pct), true);
  assert.deepEqual(messages, original);
});

test("tool-result offloading is an afterTool middleware and fails open", async () => {
  const ids = new Set();
  const events = [];
  const warnings = [];
  const context = { scope: "session", ownerId: "session-1", contextWindow: 8_000 };
  const runner = createLifecycleRunner([
    createToolResultOffloadMiddleware({
      offloadToolResult: (result, owner) => ({
        result: "preview",
        artifacts: [{
          id: "artifact-1",
          scope: owner.scope,
          byteCount: result.length,
          originalTokenCount: 10,
        }],
      }),
      artifactContext: context,
      artifactIds: ids,
      emitter: { send: event => events.push(event) },
      logger: { info: noop, warn: message => warnings.push(message) },
    }),
  ]);

  assert.deepEqual(runner.middlewareNames, [TOOL_RESULT_OFFLOAD_MIDDLEWARE_NAME]);
  const result = await runner.run("afterTool", { name: "read_file", result: "complete" });
  assert.equal(result.request.result, "preview");
  assert.deepEqual([...ids], ["artifact-1"]);
  assert.deepEqual(events, [{
    type: "tool_result_offloaded",
    name: "read_file",
    artifactId: "artifact-1",
    scope: "session",
    byteCount: 8,
    tokenCount: 10,
  }]);
  assert.deepEqual(warnings, []);

  const failing = createLifecycleRunner([
    createToolResultOffloadMiddleware({
      offloadToolResult: () => { throw new Error("disk full"); },
      artifactContext: context,
      artifactIds: new Set(),
      emitter: { send: noop },
      logger: { info: noop, warn: message => warnings.push(message) },
    }),
  ]);
  const unchanged = await failing.run("afterTool", { name: "read_file", result: "complete" });
  assert.equal(unchanged.request.result, "complete");
  assert.match(warnings[0], /disk full/);
});
