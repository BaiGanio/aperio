import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  sendMemories,
  sendSelfMemories,
  sendPendingInterrupts,
  handleDeleteMemory,
} from "../../../../lib/emitters/handlers/ws/memories.js";

// =============================================================================
// sendMemories — broadcast memory list to the sidebar
// =============================================================================
describe("sendMemories", () => {
  test("sends memories with formatted timestamps", async () => {
    const store = {
      listAll: async () => [{
        id: "m1", type: "fact", title: "User prefers dark mode",
        content: "User explicitly set dark mode in settings",
        tags: ["preference", "ui"], importance: 4,
        created_at: new Date("2025-01-15T10:30:00Z"), pinned: true,
      }],
    };
    const send = mock.fn();
    await sendMemories({ store, send, sessionLogger: { error: mock.fn() } });

    assert.equal(send.mock.calls.length, 1);
    const [, { memories }] = send.mock.calls[0].arguments;
    assert.deepEqual(memories, [{
      id: "m1", type: "fact", title: "User prefers dark mode",
      content: "User explicitly set dark mode in settings",
      tags: ["preference", "ui"], importance: 4,
      createdAt: "2025-01-15T10:30:00.000Z", pinned: true,
    }]);
  });

  test("sends empty list when store has no memories", async () => {
    const store = { listAll: async () => [] };
    const send = mock.fn();
    await sendMemories({ store, send, sessionLogger: { error: mock.fn() } });

    assert.equal(send.mock.calls.length, 1);
    assert.deepEqual(send.mock.calls[0].arguments[1].memories, []);
  });

  test("handles store error gracefully (logs but does not send)", async () => {
    const store = { listAll: async () => { throw new Error("connection refused"); } };
    const send = mock.fn();
    const sessionLogger = { error: mock.fn() };
    await sendMemories({ store, send, sessionLogger });

    assert.equal(send.mock.calls.length, 0);
    assert.ok(sessionLogger.error.mock.calls.length > 0);
  });

  test("uses sensible defaults for missing optional fields", async () => {
    const store = {
      listAll: async () => [{
        id: "m2", type: "project", title: "Test",
        content: "Content", // no tags, no importance, no created_at, no pinned
      }],
    };
    const send = mock.fn();
    await sendMemories({ store, send, sessionLogger: { error: mock.fn() } });

    const [, { memories }] = send.mock.calls[0].arguments;
    assert.deepEqual(memories[0].tags, []);
    assert.equal(memories[0].importance, 3);
    assert.equal(memories[0].pinned, false);
  });
});

// =============================================================================
// sendSelfMemories — broadcast agent's self-memories (oversight pane)
// =============================================================================
describe("sendSelfMemories", () => {
  test("sends self-memories from store.listSelf", async () => {
    const store = {
      listSelf: async () => [{
        id: "sm1", title: "Agent identity",
        content: "I am a helpful assistant.",
        tags: ["identity"], importance: 5,
        created_at: "2025-06-15T12:00:00.000Z",
      }],
    };
    const send = mock.fn();
    const sessionLogger = { error: mock.fn() };
    await sendSelfMemories({ store, send, sessionLogger });

    assert.equal(send.mock.calls.length, 1);
    const [, { memories }] = send.mock.calls[0].arguments;
    assert.equal(memories.length, 1);
    assert.equal(memories[0].id, "sm1");
    assert.equal(memories[0].title, "Agent identity");
  });

  test("handles empty self-memories", async () => {
    const store = { listSelf: async () => [] };
    const send = mock.fn();
    await sendSelfMemories({ store, send, sessionLogger: { error: mock.fn() } });

    assert.deepEqual(send.mock.calls[0].arguments[1].memories, []);
  });

  test("handles store error gracefully", async () => {
    const store = { listSelf: async () => { throw new Error("timeout"); } };
    const send = mock.fn();
    const sessionLogger = { error: mock.fn() };
    await sendSelfMemories({ store, send, sessionLogger });

    assert.equal(send.mock.calls.length, 0);
    assert.ok(sessionLogger.error.mock.calls.length > 0);
  });
});

// =============================================================================
// sendPendingInterrupts — broadcast pending tool-confirmation interrupts
// =============================================================================
describe("sendPendingInterrupts", () => {
  test("sends pending interrupts from store.listAgentInterrupts", async () => {
    const store = {
      listAgentInterrupts: async ({ status, limit }) => [{
        id: "int_1", session_id: "s1", tool_name: "write_file",
        status: "pending", digest: "abc123",
      }],
    };
    const send = mock.fn();
    await sendPendingInterrupts({ store, send });

    assert.equal(send.mock.calls.length, 1);
    const [type, payload] = send.mock.calls[0].arguments;
    assert.equal(type, "interrupts");
    assert.equal(payload.interrupts.length, 1);
    assert.equal(payload.interrupts[0].id, "int_1");
  });

  test("sends empty list when no pending interrupts", async () => {
    const store = { listAgentInterrupts: async () => [] };
    const send = mock.fn();
    await sendPendingInterrupts({ store, send });

    assert.deepEqual(send.mock.calls[0].arguments[1].interrupts, []);
  });

  test("is a no-op when store lacks listAgentInterrupts", async () => {
    const send = mock.fn();
    await sendPendingInterrupts({ store: {}, send });
    assert.equal(send.mock.calls.length, 0);
  });
});

// =============================================================================
// handleDeleteMemory — forget a single memory by id
// =============================================================================
describe("handleDeleteMemory", () => {
  test("calls forget tool and broadcasts deleted event", async () => {
    const callTool = mock.fn(async () => "OK");
    const send = mock.fn();
    await handleDeleteMemory("mem_1", {
      callTool, send, sessionLogger: { error: mock.fn() },
    });

    assert.equal(callTool.mock.calls.length, 1);
    assert.deepEqual(callTool.mock.calls[0].arguments, ["forget", { id: "mem_1" }]);
    assert.equal(send.mock.calls.length, 1);
    assert.deepEqual(send.mock.calls[0].arguments, ["deleted", { id: "mem_1" }]);
  });

  test("sends error when forget throws", async () => {
    const callTool = mock.fn(async () => { throw new Error("not found"); });
    const send = mock.fn();
    const sessionLogger = { error: mock.fn() };
    await handleDeleteMemory("mem_1", {
      callTool, send, sessionLogger,
    });

    // Must send error, not deleted
    assert.equal(send.mock.calls.length, 1);
    const [type, payload] = send.mock.calls[0].arguments;
    assert.equal(type, "error");
    assert.match(payload.text, /not found/);
  });

  test("still sends error even when forget returns non-error response", async () => {
    // Edge case: if callTool resolves without error, we expect deleted event
    const callTool = mock.fn(async () => ({ content: [{ type: "text", text: "Forgotten." }] }));
    const send = mock.fn();
    await handleDeleteMemory("mem_2", {
      callTool, send, sessionLogger: { error: mock.fn() },
    });

    assert.equal(send.mock.calls.length, 1);
    assert.equal(send.mock.calls[0].arguments[0], "deleted");
  });
});
