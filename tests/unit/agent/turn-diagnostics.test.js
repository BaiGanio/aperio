// tests/unit/agent/turn-diagnostics.test.js
//
// Coverage for checkNoToolUse() (lib/agent/turn-diagnostics.js). Regression
// target: id/reference/tech-debt.md's "Sessions — persisted transcript"
// entry — the diagnostic used to fire on any prose-with-codeblock answer
// with zero tool calls, regardless of whether a file-mutation tool was ever
// offered that turn, so a bare "implement an LRU cache from scratch" prompt
// (which tool-profiles.js deliberately never attaches file-edit/file-generate
// to) got flagged as a missed file write. Confirmed live in session
// 10d42bab-7081-4842-aa51-b9913dfc9e14.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkNoToolUse } from "../../../lib/agent/turn-diagnostics.js";

function makeState(overrides = {}) {
  return { noTools: false, toolWarningEmitted: false, noToolStreak: 0, ...overrides };
}

function makeEmitter() {
  const sent = [];
  return { sent, send: msg => sent.push(msg) };
}

describe("checkNoToolUse", () => {
  test("never warns when no mutation tool was offered, even after repeated prose-with-code turns", () => {
    const state = makeState();
    const emitter = makeEmitter();
    const provider = { model: "test-model" };
    for (let i = 0; i < 5; i++) {
      checkNoToolUse({
        state, provider, emitter,
        finalText: "Here's an LRU cache:\n```js\nclass LRU {}\n```",
        toolCallCount: 0,
        hadMutationToolOffered: false,
      });
    }
    assert.equal(emitter.sent.length, 0);
    assert.equal(state.toolWarningEmitted, false);
  });

  test("warns after two consecutive prose-with-code turns when a mutation tool WAS offered and unused", () => {
    const state = makeState();
    const emitter = makeEmitter();
    const provider = { model: "test-model" };
    const turn = () => checkNoToolUse({
      state, provider, emitter,
      finalText: "```js\nconsole.log('hi');\n```",
      toolCallCount: 0,
      hadMutationToolOffered: true,
    });
    turn();
    assert.equal(emitter.sent.length, 0, "single turn is not evidence");
    turn();
    assert.equal(emitter.sent.length, 1);
    assert.deepEqual(emitter.sent[0], { type: "no_tool_use_detected", model: "test-model" });
  });

  test("only warns once even if the streak keeps going", () => {
    const state = makeState();
    const emitter = makeEmitter();
    const provider = { model: "test-model" };
    for (let i = 0; i < 4; i++) {
      checkNoToolUse({
        state, provider, emitter,
        finalText: "```js\nfoo();\n```",
        toolCallCount: 0,
        hadMutationToolOffered: true,
      });
    }
    assert.equal(emitter.sent.length, 1);
  });

  test("an actual tool call resets the streak", () => {
    const state = makeState();
    const emitter = makeEmitter();
    const provider = { model: "test-model" };
    checkNoToolUse({
      state, provider, emitter,
      finalText: "```js\nfoo();\n```",
      toolCallCount: 0,
      hadMutationToolOffered: true,
    });
    checkNoToolUse({
      state, provider, emitter,
      finalText: "wrote it",
      toolCallCount: 1,
      hadMutationToolOffered: true,
    });
    checkNoToolUse({
      state, provider, emitter,
      finalText: "```js\nbar();\n```",
      toolCallCount: 0,
      hadMutationToolOffered: true,
    });
    assert.equal(emitter.sent.length, 0, "streak should have reset after the tool call");
  });

  test("a turn without the mutation tool offered is neutral and does not break an existing streak", () => {
    const state = makeState();
    const emitter = makeEmitter();
    const provider = { model: "test-model" };
    checkNoToolUse({
      state, provider, emitter,
      finalText: "```js\nfoo();\n```",
      toolCallCount: 0,
      hadMutationToolOffered: true,
    });
    // A conversational turn in between where no file tool was offered at all.
    checkNoToolUse({
      state, provider, emitter,
      finalText: "```js\nunrelated();\n```",
      toolCallCount: 0,
      hadMutationToolOffered: false,
    });
    checkNoToolUse({
      state, provider, emitter,
      finalText: "```js\nbar();\n```",
      toolCallCount: 0,
      hadMutationToolOffered: true,
    });
    assert.equal(emitter.sent.length, 1, "the two real offered-and-ignored turns should still count as the streak");
  });

  test("noTools bypasses the check entirely", () => {
    const state = makeState();
    const emitter = makeEmitter();
    const provider = { model: "test-model" };
    for (let i = 0; i < 3; i++) {
      checkNoToolUse({
        state, provider, emitter,
        finalText: "```js\nfoo();\n```",
        toolCallCount: 0,
        hadMutationToolOffered: true,
        noTools: true,
      });
    }
    assert.equal(emitter.sent.length, 0);
  });

  test("answer artifacts count as evidence of tool-equivalent output and reset the streak", () => {
    const state = makeState();
    const emitter = makeEmitter();
    const provider = { model: "test-model" };
    checkNoToolUse({
      state, provider, emitter,
      finalText: "```js\nfoo();\n```",
      toolCallCount: 0,
      hadMutationToolOffered: true,
    });
    checkNoToolUse({
      state, provider, emitter,
      finalText: "built it",
      toolCallCount: 0,
      answerArtifactCount: 1,
      hadMutationToolOffered: true,
    });
    checkNoToolUse({
      state, provider, emitter,
      finalText: "```js\nbar();\n```",
      toolCallCount: 0,
      hadMutationToolOffered: true,
    });
    assert.equal(emitter.sent.length, 0, "streak should have reset after the artifact turn");
  });
});
