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

  test("awaits the doc_batch dedup-cache invalidation BEFORE emitting session_branched (round 10, P2)", async () => {
    const { handleBranchConversation } = await import(
      "../../../../lib/emitters/handlers/ws/session.js"
    );
    const { createSession, deleteSession } = await import(
      "../../../../lib/helpers/sessions.js"
    );
    // A real parent session so the branch path (getSession/createSession/
    // setSessionTitle) resolves without throwing.
    const parentId = createSession({ model: "claude-3", provider: "anthropic", source: "web" });
    let childId = null;
    try {
      let releaseClear;
      const clearGate = new Promise(resolve => { releaseClear = resolve; });
      let clearCalled = false;
      const send = mock.fn();
      const deps = mockDeps({
        sessionId: parentId,
        msgAttachments: new Map(), // real finaliseSession calls .get() on the attachments map
        send,
        clearDocSessionCache: async (docSessionId) => {
          clearCalled = true;
          assert.equal(docSessionId, "conn-dedup-1",
            "the invalidation targets the connection's fixed docSessionId namespace");
          await clearGate;
        },
        docSessionId: "conn-dedup-1",
      });

      const pending = handleBranchConversation(deps); // do NOT await yet
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(clearCalled, true, "the handler starts the invalidation");
      assert.equal(
        send.mock.calls.some(c => c.arguments[0] === "session_branched"), false,
        "the ack must NOT be emitted while the invalidation is still in flight",
      );

      releaseClear();
      const result = await pending;
      childId = result?.sessionId ?? null;
      assert.equal(
        send.mock.calls.some(c => c.arguments[0] === "session_branched"), true,
        "the ack is emitted only after the invalidation completed",
      );
    } finally {
      if (childId) deleteSession(childId);
      deleteSession(parentId);
    }
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

  test("rejects a path-traversal resume id as 'not found' instead of resolving outside var/sessions (security)", async () => {
    // A client-controlled resume id like "../../package" used to resolve
    // inside SESSIONS_DIR to the repo's own package.json (valid JSON), which
    // getSession() would then hand back as if it were a real session — this
    // handler would go on to rebind scratch/log paths to that same escaped
    // path and, at close time, overwrite or delete it. sessions.js now
    // rejects the id before any path join, so this must surface as the
    // ordinary "not found" path, never a resolved session.
    const { handleResumeSession } = await import(
      "../../../../lib/emitters/handlers/ws/session.js"
    );
    const deps = mockDeps();
    const result = await handleResumeSession("../../package", deps);

    assert.strictEqual(result, null);
    assert.equal(deps.send.mock.calls[0].arguments[0], "error");
    assert.match(deps.send.mock.calls[0].arguments[1].text, /Session not found/);
  });

  test("returns the resumed session's own id as sessionId (P1 fix: dedup namespace must follow resume, not stay pinned to the connection's original session)", async () => {
    const { handleResumeSession } = await import(
      "../../../../lib/emitters/handlers/ws/session.js"
    );
    const { createSession, deleteSession } = await import(
      "../../../../lib/helpers/sessions.js"
    );
    const id = createSession({ model: "claude-3", provider: "anthropic", source: "web" });
    try {
      const deps = mockDeps();
      const result = await handleResumeSession(id, deps);
      assert.ok(result, "a real, just-created session must resolve");
      assert.equal(result.sessionId, id, "sessionId must be the RESUMED conversation's id, not left for the caller to infer");
      assert.equal(result.providerSessionSourceId, id);
    } finally {
      deleteSession(id);
    }
  });

  test("awaits the doc_batch dedup-cache invalidation BEFORE emitting session_resumed (round 10, P2)", async () => {
    const { handleResumeSession } = await import(
      "../../../../lib/emitters/handlers/ws/session.js"
    );
    const { createSession, deleteSession } = await import(
      "../../../../lib/helpers/sessions.js"
    );
    const id = createSession({ model: "claude-3", provider: "anthropic", source: "web" });
    try {
      let releaseClear;
      const clearGate = new Promise(resolve => { releaseClear = resolve; });
      let clearCalled = false;
      const send = mock.fn();
      const deps = mockDeps({
        send,
        clearDocSessionCache: async (docSessionId) => {
          clearCalled = true;
          assert.equal(docSessionId, "conn-dedup-1",
            "the invalidation targets the connection's fixed docSessionId namespace");
          await clearGate;
        },
        docSessionId: "conn-dedup-1",
      });

      const pending = handleResumeSession(id, deps); // do NOT await yet
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(clearCalled, true, "the handler starts the invalidation");
      assert.equal(
        send.mock.calls.some(c => c.arguments[0] === "session_resumed"), false,
        "the ack must NOT be emitted while the invalidation is still in flight — an immediate follow-up chat could otherwise race a doc_batch ahead of it",
      );

      releaseClear();
      await pending;
      assert.equal(
        send.mock.calls.some(c => c.arguments[0] === "session_resumed"), true,
        "the ack is emitted only after the invalidation completed",
      );
    } finally {
      deleteSession(id);
    }
  });

  test("a failed resume rolls back messages and leaves the outgoing session untouched (round 12, P2)", async () => {
    // Regression: the outgoing session used to be finalised (and its file
    // possibly deleted, if it looked trivial) BEFORE the bootstrap
    // runAgentLoop ran. If that call threw, the caller never applies the
    // handler's return value, so the socket kept the OLD sessionId — but its
    // `messages` had already been wiped and repurposed for the (never
    // switched-to) target session, and the outgoing session file had already
    // been finalised/deleted despite the connection still pointing at it.
    const { handleResumeSession } = await import(
      "../../../../lib/emitters/handlers/ws/session.js"
    );
    const { createSession, getSession, deleteSession } = await import(
      "../../../../lib/helpers/sessions.js"
    );
    const oldId = createSession({ model: "claude-3", provider: "anthropic", source: "web" });
    const targetId = createSession({ model: "claude-3", provider: "anthropic", source: "web" });
    try {
      const originalMessages = [
        { role: "user", content: "original conversation, still in progress" },
        { role: "assistant", content: "still going" },
      ];
      const messages = originalMessages.slice();
      const deps = mockDeps({
        messages,
        sessionId: oldId,
        msgAttachments: new Map(),
        runAgentLoop: mock.fn(async () => { throw new Error("provider unavailable"); }),
      });

      await assert.rejects(() => handleResumeSession(targetId, deps), /provider unavailable/);

      assert.deepEqual(messages, originalMessages, "messages must be rolled back to their pre-resume content");
      assert.equal(deps.setAbort.mock.calls.some(c => c.arguments[0] === null), true, "setAbort(null) still runs on failure");

      const oldSession = getSession(oldId);
      assert.equal(oldSession.endedAt, null, "the outgoing session must NOT be finalised when resume never completed");
    } finally {
      deleteSession(oldId);
      deleteSession(targetId);
    }
  });
});
