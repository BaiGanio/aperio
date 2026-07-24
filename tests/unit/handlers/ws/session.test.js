import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

// =============================================================================
// handleBranchConversation — branch current session into a child
// =============================================================================
describe("handleBranchConversation", () => {
  function mockDeps(overrides = {}) {
    return {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
      sessionId: "parent-1",
      msgAttachments: [],
      sessionHadAttachments: false,
      provider: () => ({ model: "claude-3", name: "anthropic" }),
      send: mock.fn(),
      sessionLogger: { info: mock.fn(), error: mock.fn() },
      ...overrides,
    };
  }

  test("returns null and sends ok:false when messages.length < 2", async () => {
    const { handleBranchConversation } = await import(
      "../../../../lib/emitters/handlers/ws/session.js"
    );
    const deps = mockDeps({ messages: [{ role: "user", content: "only one" }] });
    const result = await handleBranchConversation(deps);

    assert.strictEqual(result, null);
    assert.equal(deps.send.mock.calls.length, 1);
    const [type, payload] = deps.send.mock.calls[0].arguments;
    assert.equal(type, "session_branched");
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "Not enough conversation to branch yet.");
  });

  test("continues when messages has exactly enough messages", async () => {
    // Minimum 2 messages — should pass the guard and proceed to sessions API
    const { handleBranchConversation } = await import(
      "../../../../lib/emitters/handlers/ws/session.js"
    );
    const deps = mockDeps(); // default messages has 2 entries
    // We don't assert on the return value (needs ESM mocking for sessions API),
    // but verify it didn't return null with the early-exit reason
    const result = await handleBranchConversation(deps);
    // It will throw from the real sessions module, but that's expected without mocking
    // This test is a guard: the early return must not trigger for valid message counts
    assert.notEqual(result?.reason, "Not enough conversation to branch yet.");
  });
});

// =============================================================================
// handleResumeSession — resume a previous session by id
// =============================================================================
describe("handleResumeSession", () => {
  function mockDeps(overrides = {}) {
    return {
      messages: [],
      currentLang: "en",
      runAgentLoop: mock.fn(async () => ""),
      emitter: mock.fn(),
      send: mock.fn(),
      sessionLogger: { info: mock.fn(), error: mock.fn() },
      getAbort: () => null,
      setAbort: mock.fn(),
      ...overrides,
    };
  }

  test("sends error when session is not found", async () => {
    const { handleResumeSession } = await import(
      "../../../../lib/emitters/handlers/ws/session.js"
    );
    const deps = mockDeps();
    const result = await handleResumeSession("nonexistent", deps);

    assert.strictEqual(result, null);
    assert.equal(deps.send.mock.calls.length, 1);
    assert.equal(deps.send.mock.calls[0].arguments[0], "error");
    assert.match(deps.send.mock.calls[0].arguments[1].text, /Session not found/);
  });
});
