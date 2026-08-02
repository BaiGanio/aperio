import test from "node:test";
import assert from "node:assert/strict";
import { createLifecycleRunner } from "../../../lib/agent/middleware.js";
import {
  MODEL_CONTEXT_MIDDLEWARE_NAMES,
  TOOL_RESULT_OFFLOAD_MIDDLEWARE_NAME,
  appendTailToMessages,
  createModelContextMiddleware,
  createToolResultOffloadMiddleware,
  projectObservedInputTokens,
} from "../../../lib/agent/model-context-middleware.js";

const noop = () => {};
const logger = { info: noop, warn: noop };

test("projects newly appended recall results into the next request's input pressure", () => {
  assert.equal(projectObservedInputTokens({
    observedInputTokens: 9_775,
    previousMessageTokens: 120,
    currentMessageTokens: 1_820,
  }), 11_475);
});

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
    tailAppend: [],
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
  assert.deepEqual(prepared.request.promptParts, ["BASE", "MEMORY POINTER"]);
  // Skill prompts attach to tailAppend (the request's newest content), not
  // the cached system-prompt parts, so per-turn skill injection never busts
  // the byte-stable prefix llama.cpp's KV cache relies on.
  assert.deepEqual(prepared.request.tailAppend, ["SKILL PROMPT"]);
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

test("offloading a result clears the docgraph session dedup cache (round 14, P1)", async () => {
  // Regression: docgraphHandlers.js's doc_batch commits the session dedup
  // cache (sessionReadFacts) inside the MCP child process the instant the
  // tool call returns — before this middleware ever runs. When the result is
  // large enough to be offloaded here, the model only receives the preview
  // (finalizeToolResult returns THIS middleware's `result`), yet the dedup
  // cache already claims the full document was "already read". Without
  // invalidating it here, a later doc_batch for the same document (once
  // read_artifact's turn-scoped exposure has expired) would return only the
  // dedup pointer, permanently withholding content the model never saw.
  const cleared = [];
  const runner = createLifecycleRunner([
    createToolResultOffloadMiddleware({
      offloadToolResult: () => ({
        result: "preview",
        artifacts: [{ id: "artifact-1", scope: "session", byteCount: 200_000, originalTokenCount: 50_000 }],
      }),
      artifactContext: { scope: "session", ownerId: "session-1", contextWindow: 8_000 },
      artifactIds: new Set(),
      emitter: { send: noop },
      logger,
      clearDocSessionCache: async (sessionId) => { cleared.push(sessionId); },
      docSessionId: "conn-dedup-1",
    }),
  ]);

  await runner.run("afterTool", { name: "docgraph_doc_batch", result: "a huge doc_batch payload" });
  assert.deepEqual(cleared, ["conn-dedup-1"], "the connection's doc_batch dedup cache must be invalidated when its result is offloaded");
});

test("a tool result that is NOT offloaded never clears the dedup cache", async () => {
  const cleared = [];
  const runner = createLifecycleRunner([
    createToolResultOffloadMiddleware({
      offloadToolResult: (result) => ({ result, artifacts: [] }), // under the size threshold — no offload
      artifactContext: { scope: "session", ownerId: "session-1", contextWindow: 8_000 },
      artifactIds: new Set(),
      emitter: { send: noop },
      logger,
      clearDocSessionCache: async (sessionId) => { cleared.push(sessionId); },
      docSessionId: "conn-dedup-1",
    }),
  ]);

  await runner.run("afterTool", { name: "docgraph_doc_batch", result: "small result" });
  assert.deepEqual(cleared, [], "no offload happened, so the dedup cache must be left alone");
});

test("no docSessionId or no clearDocSessionCache callback never throws and never clears", async () => {
  const runner = createLifecycleRunner([
    createToolResultOffloadMiddleware({
      offloadToolResult: () => ({
        result: "preview",
        artifacts: [{ id: "artifact-1", scope: "session", byteCount: 200_000, originalTokenCount: 50_000 }],
      }),
      artifactContext: { scope: "session", ownerId: "session-1", contextWindow: 8_000 },
      artifactIds: new Set(),
      emitter: { send: noop },
      logger,
      // clearDocSessionCache/docSessionId both omitted — e.g. a non-WebSocket caller (CLI/harness).
    }),
  ]);

  const result = await runner.run("afterTool", { name: "docgraph_doc_batch", result: "a huge doc_batch payload" });
  assert.equal(result.request.result, "preview");
});

test("a throwing clearDocSessionCache fails open — the offload result still returns", async () => {
  const warnings = [];
  const runner = createLifecycleRunner([
    createToolResultOffloadMiddleware({
      offloadToolResult: () => ({
        result: "preview",
        artifacts: [{ id: "artifact-1", scope: "session", byteCount: 200_000, originalTokenCount: 50_000 }],
      }),
      artifactContext: { scope: "session", ownerId: "session-1", contextWindow: 8_000 },
      artifactIds: new Set(),
      emitter: { send: noop },
      logger: { info: noop, warn: message => warnings.push(message) },
      clearDocSessionCache: async () => { throw new Error("mcp round trip failed"); },
      docSessionId: "conn-dedup-1",
    }),
  ]);

  const result = await runner.run("afterTool", { name: "docgraph_doc_batch", result: "a huge doc_batch payload" });
  assert.equal(result.request.result, "preview", "the offload itself must still succeed even if the cache clear failed");
  assert.match(warnings[0], /mcp round trip failed/);
});

// ── WS-A: shared tail-attachment plumbing ─────────────────────────────────
// isFirstHop detection (context-trimming stage) + appendTailToMessages, the
// generic clone-and-splice mechanism that WS-B (clock) and WS-C (skills) will
// push onto instead of promptParts.

function stubMiddleware(overrides = {}) {
  return createModelContextMiddleware({
    emitter: { send: noop },
    logger,
    getMemoryPointers: () => [],
    ensureTurn: () => ({ skills: [] }),
    logTurnOnce: noop,
    getSkillPrompts: () => [],
    getSelectedTools: () => [],
    ...overrides,
  });
}

function runBeforeModel(middleware, request) {
  return createLifecycleRunner(middleware).run("beforeModel", {
    observedInputTokens: 0,
    contextWindow: 100_000,
    providerLabel: "test",
    promptParts: [],
    tailAppend: [],
    ...request,
  });
}

test("A1: isFirstHop is true when the newest message is the user's own turn", async () => {
  const messages = [
    { role: "user", content: "oldest" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "current request" },
  ];
  const prepared = await runBeforeModel(stubMiddleware(), { messages });
  assert.equal(prepared.request.isFirstHop, true);
});

test("A2: isFirstHop is false on every hop after the first within a turn", async () => {
  const twoHop = [
    { role: "user", content: "current request" },
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read_file", input: {} }] },
    { role: "tool", tool_call_id: "1", content: "file contents" },
  ];
  const prepared2 = await runBeforeModel(stubMiddleware(), { messages: twoHop });
  assert.equal(prepared2.request.isFirstHop, false);

  const threeHop = [
    { role: "user", content: "current request" },
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read_file", input: {} }] },
    { role: "tool", tool_call_id: "1", content: "first result" },
    { role: "assistant", content: [{ type: "tool_use", id: "2", name: "read_file", input: {} }] },
    { role: "tool", tool_call_id: "2", content: "second result" },
  ];
  const prepared3 = await runBeforeModel(stubMiddleware(), { messages: threeHop });
  assert.equal(prepared3.request.isFirstHop, false);
});

test("A3: appendTailToMessages splices into a clone, not the original message (string content)", async () => {
  const originalMessages = [
    { role: "user", content: "current request" },
  ];
  const markerStage = {
    name: "test-marker",
    beforeModel(request) {
      if (!request.isFirstHop) return undefined;
      return { update: { tailAppend: [...request.tailAppend, "MARKER"] } };
    },
  };
  const prepared = await runBeforeModel([...stubMiddleware(), markerStage], { messages: originalMessages });
  const finalMessages = appendTailToMessages(prepared.request.messages, prepared.request.tailAppend);

  assert.notEqual(finalMessages.at(-1), originalMessages.at(-1));
  assert.doesNotMatch(originalMessages.at(-1).content, /MARKER/);
  assert.match(finalMessages.at(-1).content, /current request/);
  assert.match(finalMessages.at(-1).content, /MARKER/);
});

test("A3 edge case: multimodal content clones and appends without dropping image blocks", () => {
  const original = [{
    role: "user",
    content: [
      { type: "text", text: "describe this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
    ],
  }];
  const result = appendTailToMessages(original, ["MARKER"]);

  assert.notEqual(result.at(-1), original.at(-1));
  // Original untouched.
  assert.equal(original.at(-1).content.length, 2);
  assert.doesNotMatch(original.at(-1).content[0].text, /MARKER/);

  const blocks = result.at(-1).content;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, "image");
  assert.deepEqual(blocks[1], original.at(-1).content[1]);
  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text, /describe this/);
  assert.match(blocks[0].text, /MARKER/);
});

test("A4: no tailAppend contributors is a no-op", async () => {
  const messages = [
    { role: "user", content: "current request" },
  ];
  const prepared = await runBeforeModel(stubMiddleware(), { messages });
  assert.deepEqual(prepared.request.tailAppend, []);
  const finalMessages = appendTailToMessages(prepared.request.messages, prepared.request.tailAppend);
  assert.equal(finalMessages, prepared.request.messages);
});

// ── WS-C: skill relocation ────────────────────────────────────────────────
// getSkillPrompts' contribution now lands in tailAppend, targeted at the
// turn's originating message (lastUser) rather than the array's last element
// — required so it re-attaches at the same position on every hop, not just
// hop 1 (see the WS-A landed finding under the plan's Architecture section).

test("C1: skill-injection stage contributes to tailAppend, not promptParts", async () => {
  const middleware = stubMiddleware({ getSkillPrompts: () => ["XLSX SKILL GUIDANCE"] });
  const prepared = await runBeforeModel(middleware, {
    messages: [{ role: "user", content: "please help me export this xlsx" }],
    promptParts: ["BASE"],
  });
  assert.deepEqual(prepared.request.promptParts, ["BASE"]);
  assert.deepEqual(prepared.request.tailAppend, ["XLSX SKILL GUIDANCE"]);
});

test("C1: skill tail re-attaches at the turn's originating message on every hop, not the array's last element", async () => {
  const middleware = stubMiddleware({ getSkillPrompts: () => ["XLSX SKILL GUIDANCE"] });

  // Hop 1 — first request of the turn: lastUser is messages.at(-1).
  const prepared1 = await runBeforeModel(middleware, {
    messages: [{ role: "user", content: "please help me export this xlsx" }],
  });
  assert.equal(prepared1.request.isFirstHop, true);
  const finalHop1 = appendTailToMessages(
    prepared1.request.messages, prepared1.request.tailAppend, prepared1.request.lastUser,
  );
  assert.match(finalHop1.at(-1).content, /XLSX SKILL GUIDANCE/);

  // Hop 2 — same turn continues with a tool call/result appended after the
  // user's message. The array's last element is now the tool result, but
  // lastUser must still resolve to the originating user message (index 0),
  // so the skill tail lands there instead of on the trailing tool result.
  const prepared2 = await runBeforeModel(middleware, {
    messages: [
      { role: "user", content: "please help me export this xlsx" },
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read_file", input: {} }] },
      { role: "tool", tool_call_id: "1", content: "file contents" },
    ],
  });
  assert.equal(prepared2.request.isFirstHop, false);
  // Within this hop's own request graph, lastUser is the SAME object as the
  // originating message inside `messages` (the runner's snapshot dedups
  // shared references) — this is what appendTailToMessages' lastIndexOf
  // lookup relies on to find the right position.
  assert.equal(prepared2.request.lastUser, prepared2.request.messages[0]);

  const finalHop2 = appendTailToMessages(
    prepared2.request.messages, prepared2.request.tailAppend, prepared2.request.lastUser,
  );
  // Skill content lands on the originating user message (index 0)...
  assert.match(finalHop2[0].content, /XLSX SKILL GUIDANCE/);
  // ...not duplicated onto the new trailing tool-result message.
  assert.equal(finalHop2.at(-1).content, "file contents");
});

test("C2: an unrelated follow-up turn carries no skill tail (anti-bleed)", async () => {
  let call = 0;
  const middleware = stubMiddleware({
    getSkillPrompts: () => (++call === 1 ? ["DEBUG SKILL GUIDANCE"] : []),
  });

  const turn1 = await runBeforeModel(middleware, {
    messages: [{ role: "user", content: "why is this stack trace happening" }],
  });
  assert.deepEqual(turn1.request.tailAppend, ["DEBUG SKILL GUIDANCE"]);

  const turn2 = await runBeforeModel(middleware, {
    messages: [{ role: "user", content: "hey, how are you?" }],
  });
  assert.deepEqual(turn2.request.tailAppend, []);
});

test("C4: multimodal first message — skill tail lands in the text block, image blocks preserved", async () => {
  const userMsg = {
    role: "user",
    content: [
      { type: "text", text: "describe and log this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
    ],
  };
  const middleware = stubMiddleware({ getSkillPrompts: () => ["IMAGE SKILL GUIDANCE"] });
  const prepared = await runBeforeModel(middleware, { messages: [userMsg] });
  const final = appendTailToMessages(
    prepared.request.messages, prepared.request.tailAppend, prepared.request.lastUser,
  );

  const blocks = final.at(-1).content;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, "image");
  assert.deepEqual(blocks[1], userMsg.content[1]);
  assert.match(blocks[0].text, /describe and log this/);
  assert.match(blocks[0].text, /IMAGE SKILL GUIDANCE/);
  // Original untouched.
  assert.doesNotMatch(userMsg.content[0].text, /IMAGE SKILL GUIDANCE/);
});

// ── Dedup-cache invalidation on context shed (Step 3 review, round 7, P1) ────
// onModelContextShed must fire whenever the model-facing context sheds content
// that was previously visible — the token-pressure trim OR the maxHistory cap —
// because tool results that carried document text (or offloaded-artifact
// pointers) may be among the shed messages. The caller invalidates
// session-scoped caches (the doc_batch dedup cache) on this signal: cache
// validity must follow the model-facing context, not the untrimmed
// conversation lifetime.

test("onModelContextShed fires with dropped>0 when the token-pressure trim sheds messages", async () => {
  const sheds = [];
  const middleware = stubMiddleware({
    onModelContextShed: shed => sheds.push(shed),
  });
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: "x".repeat(2_000),
  }));

  await runBeforeModel(middleware, {
    messages,
    observedInputTokens: 20_000,
    contextWindow: 4_000,
  });

  assert.equal(sheds.length, 1, "token-pressure trim must notify the observer exactly once");
  assert.ok(sheds[0].dropped > 0, "carries the dropped count");
  assert.equal(sheds[0].historyCapped, false);
  assert.equal(typeof sheds[0].pct, "number");
});

test("onModelContextShed fires with historyCapped when the maxHistory cap sheds messages without token pressure", async () => {
  const sheds = [];
  const middleware = stubMiddleware({
    maxHistory: 3,
    onModelContextShed: shed => sheds.push(shed),
  });
  const messages = [
    { role: "user", content: "oldest" },
    { role: "assistant", content: "older" },
    { role: "user", content: "previous" },
    { role: "assistant", content: "recent" },
    { role: "user", content: "current request" },
  ];

  await runBeforeModel(middleware, {
    messages,
    observedInputTokens: 0,
    contextWindow: 100_000, // no token pressure — only the cap can shed
  });

  assert.equal(sheds.length, 1, "history-cap shed must notify the observer exactly once");
  assert.equal(sheds[0].dropped, 0, "no token-pressure trim happened");
  assert.equal(sheds[0].historyCapped, true, "the cap is what shed content");
  assert.deepEqual(messages.map(m => m.content), ["oldest", "older", "previous", "recent", "current request"],
    "observer must not mutate the caller's history");
});

test("onModelContextShed does not fire when nothing sheds (no token pressure, under the cap)", async () => {
  const sheds = [];
  const middleware = stubMiddleware({
    maxHistory: 20,
    onModelContextShed: shed => sheds.push(shed),
  });
  await runBeforeModel(middleware, {
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ],
    observedInputTokens: 0,
    contextWindow: 100_000,
  });
  assert.deepEqual(sheds, [], "nothing shed — observer must stay silent");
});

test("onModelContextShed fires when capToolResults truncates a tool result — even with no dropped messages and no history cap (round 9, P1)", async () => {
  const sheds = [];
  const middleware = stubMiddleware({
    onModelContextShed: shed => sheds.push(shed),
  });
  const messages = [
    { role: "user", content: "read these and summarize" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "y".repeat(20_000) }] },
  ];

  await runBeforeModel(middleware, {
    messages,
    observedInputTokens: 0,
    contextWindow: 4_000, // 25% budget = 1k tokens — the 20k-char result is capped
  });

  assert.equal(sheds.length, 1, "a capped tool result is a shed: its truncated middle is no longer model-visible");
  assert.equal(sheds[0].cappedToolResults, true);
  assert.equal(sheds[0].dropped, 0, "no message was dropped — only the result was truncated in place");
  assert.equal(sheds[0].historyCapped, false, "no history cap either — capping is the only shed signal");
});

test("onModelContextShed reports cappedToolResults: false when nothing was capped", async () => {
  const sheds = [];
  const middleware = stubMiddleware({
    onModelContextShed: shed => sheds.push(shed),
  });
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: "x".repeat(2_000),
  }));

  await runBeforeModel(middleware, {
    messages,
    observedInputTokens: 20_000,
    contextWindow: 4_000,
  });

  assert.equal(sheds.length, 1);
  assert.ok(sheds[0].dropped > 0, "sanity: the token trim is what shed here");
  assert.equal(sheds[0].cappedToolResults, false, "plain-string messages are never capped");
});

test("a throwing onModelContextShed fails open: the trim still produces its request", async () => {
  const middleware = stubMiddleware({
    onModelContextShed: () => { throw new Error("cache clear exploded"); },
  });
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: "x".repeat(2_000),
  }));

  const prepared = await runBeforeModel(middleware, {
    messages,
    observedInputTokens: 20_000,
    contextWindow: 4_000,
  });

  assert.ok(prepared.request.dropped > 0, "trimmed request still produced despite observer failure");
});
