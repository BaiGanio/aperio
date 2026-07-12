import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import { makeWsHandler } from "../../../../lib/emitters/handlers/wsHandler.js";
import logger from "../../../../lib/helpers/logger.js";

// Suppress llama-server session log creation during tests. beginSessionLog()
// guards against this env var so tests never write {uuid}.log files to the
// real var/llamacpp/ directory regardless of module ordering or caching.
process.env.APERIO_NO_LLAMA_LOG = "1";

const TEST_DIR = os.tmpdir();

// ─── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Minimal mock WebSocket.
 * - sent[]  accumulates every parsed JSON payload ws.send() was called with.
 * - emit()  fires the registered "message" listener and awaits it.
 */
function makeWs(t) {
  const sent      = [];
  const listeners = {};
  return {
    sent,
    send: t.mock.fn((raw) => sent.push(JSON.parse(raw))),
    on:   (event, handler) => { listeners[event] = handler; },
    emit: async (data) => {
      const result = listeners["message"]?.(Buffer.from(JSON.stringify(data)));
      if (result instanceof Promise) await result;
    },
  };
}

/** Collects every "message" payload whose type matches the given type. */
function sentOf(ws, type) {
  return ws.sent.filter(m => m.type === type);
}

function makeAgent(overrides = {}) {
  return {
    provider:             { name: "anthropic", model: "claude-haiku-4-5", contextWindow: 200000 },
    callTool:             async () => "OK",
    runAgentLoop:         async () => "",
    handleRememberIntent: async () => {},
    fetchMemories:        async () => ({ raw: "", parsed: [] }),
    buildGreeting:        async () => ({ prompt: "Greet me", memCtx: "", preloadedMemCount: 0 }),
    NO_TOOLS:      false,
    THINKS:        false,
    mcpTools:             [],
    alwaysOnSkillNames:   [],
    greetingToolCount:    0,
    getToolCount:         () => 0,
    ...overrides,
  };
}

function makeHandler(agentOverrides = {}) {
  return makeWsHandler({
    agent:      makeAgent(agentOverrides),
    store:      { listAll: async () => [] },
    __dirname:  TEST_DIR,
  });
}

function makeInterruptStore(row) {
  const current = JSON.parse(JSON.stringify(row));
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  return {
    listAll: async () => [],
    async getAgentInterrupt(id) {
      return id === current.id ? clone(current) : null;
    },
    async listAgentInterrupts({ status = "pending" } = {}) {
      return !status || current.status === status ? [clone(current)] : [];
    },
    async expireAgentInterrupts() {
      return 0;
    },
    async updateAgentInterruptStatus(_id, status) {
      current.status = status;
      return clone(current);
    },
    async decideAgentInterrupt(id, { decision, status, decisionPayload = null, now = new Date().toISOString() }) {
      if (id !== current.id || current.status !== "pending") return null;
      current.decision = decision;
      current.decision_payload = clone(decisionPayload);
      current.status = status;
      current.decided_at = now;
      current.updated_at = now;
      return clone(current);
    },
  };
}

// ─── On connection ─────────────────────────────────────────────────────────────

describe("onConnection — immediate sends", () => {
  test("sends { type: 'status', text: 'connected' } as the first message", (t) => {
    const ws = makeWs(t);
    makeHandler()(ws);

    assert.strictEqual(ws.sent[0].type, "status");
    assert.strictEqual(ws.sent[0].text, "connected");
  });

  test("sends provider info as the second message", (t) => {
    const ws = makeWs(t);
    makeHandler({ provider: { name: "ollama", model: "llama3.1" } })(ws);

    const p = ws.sent[1];
    assert.strictEqual(p.type,  "provider");
    assert.strictEqual(p.name,  "ollama");
    assert.strictEqual(p.model, "llama3.1");
    assert.ok(["postgres", "sqlite"].includes(p.db));
  });

  test("provider message includes the current THINKS flag", (t) => {
    const ws = makeWs(t);
    makeHandler({ THINKS: true })(ws);

    assert.strictEqual(ws.sent[1].thinks, true);
  });

  test("registers a 'message' listener on the socket", (t) => {
    const listeners = {};
    const ws = { sent: [], send: () => {}, on: (e, h) => { listeners[e] = h; } };
    makeHandler()(ws);

    assert.ok(typeof listeners["message"] === "function");
  });
});

// ─── "init" message ────────────────────────────────────────────────────────────

describe("message type: init", () => {
  test("sends memories, runs the greeting loop, then sends memories again", async (t) => {
    const ws      = makeWs(t);
    const greetSpy = [];
    const loopSpy  = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        buildGreeting:  async () => { greetSpy.push(1); return { prompt: "Hello!", memCtx: "", preloadedMemCount: 0 }; },
        runAgentLoop:   async () => { loopSpy.push(1); return ""; },
      }),
      store:     { listAll: async () => [{ id: "1", type: "fact", title: "t", content: "c", tags: [], importance: 3, created_at: null, pinned: false }] },
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "init" });

    // greeting and loop each called once
    assert.strictEqual(greetSpy.length, 1);
    assert.strictEqual(loopSpy.length,  1);
    // two memories events (before and after the loop)
    assert.strictEqual(sentOf(ws, "memories").length, 2);
  });

  test("static greeting: skips the loop and sends the greeting as stream_end text", async (t) => {
    const ws      = makeWs(t);
    const loopSpy = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        buildGreeting: async () => ({ prompt: "Hello!", memCtx: "", preloadedMemCount: 0, staticGreeting: "Hi! How can I help you today?" }),
        runAgentLoop:  async () => { loopSpy.push(1); return ""; },
      }),
      store:     { listAll: async () => [] },
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "init" });

    // No inference: the greeting loop must not run.
    assert.strictEqual(loopSpy.length, 0);
    // The static line is rendered via a stream_end carrying the text.
    const ends = sentOf(ws, "stream_end");
    assert.strictEqual(ends.length, 1);
    assert.strictEqual(ends[0].text, "Hi! How can I help you today?");
    // Memories are still sent (preview path is unchanged).
    assert.ok(sentOf(ws, "memories").length >= 1);
  });

  test("default identity greeting runs the loop but is NOT seeded into session history", async (t) => {
    const ws       = makeWs(t);
    const loopMsgs = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        // No staticGreeting and no seedGreeting → model-gen, throwaway array.
        buildGreeting: async () => ({ prompt: "GREETING_PROMPT", memCtx: "", preloadedMemCount: 0 }),
        runAgentLoop:  async (msgs) => { loopMsgs.push([...msgs]); return ""; },
      }),
      store:     { listAll: async () => [] },
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "init" });                       // greeting loop
    await ws.emit({ type: "chat", text: "hello world" });  // first real turn

    // The greeting ran on its own array…
    assert.ok(loopMsgs[0].some(m => m.content === "GREETING_PROMPT"));
    // …but the following real turn does not carry the greeting exchange.
    assert.ok(!loopMsgs[1].some(m => m.content === "GREETING_PROMPT"));
    assert.ok(loopMsgs[1].some(m => m.role === "user" && m.content === "hello world"));
  });

  test("persona/character greeting IS seeded into session history", async (t) => {
    const ws       = makeWs(t);
    const loopMsgs = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        buildGreeting: async () => ({ prompt: "GREETING_PROMPT", memCtx: "", preloadedMemCount: 0, seedGreeting: true }),
        runAgentLoop:  async (msgs) => { loopMsgs.push([...msgs]); return ""; },
      }),
      store:     { listAll: async () => [] },
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "init" });
    await ws.emit({ type: "chat", text: "hello world" });

    // Seeded: the greeting exchange persists into the next real turn.
    assert.ok(loopMsgs[1].some(m => m.content === "GREETING_PROMPT"));
  });

  test("passes noTools:true and suppressThinking:true to runAgentLoop for non-anthropic providers", async (t) => {
    const ws       = makeWs(t);
    const loopArgs = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        provider:       { name: "ollama", model: "llama3.1" },
        runAgentLoop:   async (msgs, _emitter, opts) => { loopArgs.push(opts); return ""; },
      }),
      store:     {},
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "init" });

    // suppressThinking keeps a local reasoning model from ruminating over the
    // cosmetic "say hello in one sentence" greeting turn.
    assert.deepStrictEqual(loopArgs[0], { noTools: true, lang: "en", suppressThinking: true });
  });

  test("passes empty opts to runAgentLoop for the anthropic provider", async (t) => {
    const ws       = makeWs(t);
    const loopArgs = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        provider:     { name: "anthropic", model: "claude-haiku-4-5" },
        runAgentLoop: async (msgs, _emitter, opts) => { loopArgs.push(opts); return ""; },
      }),
      store:     {},
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "init" });

    assert.deepStrictEqual(loopArgs[0], { lang: "en" });
  });

  test("scopes Codex turns to the connection's Aperio session", async (t) => {
    const ws = makeWs(t);
    const loopArgs = [];
    const handler = makeWsHandler({
      agent: makeAgent({
        provider: { name: "codex", model: "gpt-5.5", contextWindow: 200000 },
        runAgentLoop: async (_msgs, _emitter, opts) => { loopArgs.push(opts); return ""; },
      }),
      store: { listAll: async () => [] },
      __dirname: TEST_DIR,
    });

    handler(ws);
    const announcedId = sentOf(ws, "session_created")[0].id;
    await ws.emit({ type: "init" });

    assert.equal(loopArgs[0].aperioSessionId, announcedId);
  });

  test("ignores subsequent init messages (runs only once)", async (t) => {
    const ws     = makeWs(t);
    const spy    = [];
    const handler = makeWsHandler({
      agent: makeAgent({ buildGreeting: async () => { spy.push(1); return { prompt: "Hi", memCtx: "", preloadedMemCount: 0 }; } }),
      store:     {},
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "init" });
    await ws.emit({ type: "init" });
    await ws.emit({ type: "init" });

    assert.strictEqual(spy.length, 1);
  });

  test("re-announces provider when THINKS changes during the greeting loop", async (t) => {
    const ws    = makeWs(t);
    const agent = makeAgent({
      THINKS: false,
      runAgentLoop:  async function() {
        // simulate the agent auto-detecting thinking mid-stream
        agent.THINKS = true;
        return "";
      },
    });

    makeWsHandler({ agent, store: {}, __dirname: TEST_DIR })(ws);
    await ws.emit({ type: "init" });

    const providerMsgs = sentOf(ws, "provider");
    // one on connection + one re-announcement
    assert.strictEqual(providerMsgs.length, 2);
    assert.strictEqual(providerMsgs[1].thinks, true);
  });

  test("does NOT re-announce provider when THINKS stays the same", async (t) => {
    const ws = makeWs(t);
    makeHandler()(ws);
    await ws.emit({ type: "init" });

    assert.strictEqual(sentOf(ws, "provider").length, 1);
  });
});

// ─── "chat" message ────────────────────────────────────────────────────────────

describe("message type: chat", () => {
  test("pushes the user message to history and calls runAgentLoop", async (t) => {
    const ws       = makeWs(t);
    const loopMsgs = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        runAgentLoop: async (msgs) => { loopMsgs.push([...msgs]); return ""; },
      }),
      store:     {},
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "chat", text: "hello world" });

    const last = loopMsgs[0];
    assert.ok(last.some(m => m.role === "user" && m.content === "hello world"));
  });

  test("sends 'thinking' before running the agent loop", async (t) => {
    const ws    = makeWs(t);
    const order = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        runAgentLoop: async () => { order.push("loop"); return ""; },
      }),
      store:     {},
      __dirname: TEST_DIR,
    });

    handler(ws);
    // patch send to track order
    const origSend = ws.send.mock.calls;
    handler(ws);

    // simpler: just check thinking was sent before stream events
    const ws2   = makeWs(t);
    const sentOrder = [];
    const origWsSend = ws2.send;
    ws2.send = t.mock.fn((raw) => {
      const msg = JSON.parse(raw);
      sentOrder.push(msg.type);
      origWsSend.call(ws2, raw);
    });

    const handler2 = makeWsHandler({
      agent: makeAgent({ runAgentLoop: async () => { sentOrder.push("loop"); return ""; } }),
      store: {}, __dirname: TEST_DIR,
    });
    handler2(ws2);
    await ws2.emit({ type: "chat", text: "hi" });

    const thinkIdx = sentOrder.indexOf("thinking");
    const loopIdx  = sentOrder.indexOf("loop");
    assert.ok(thinkIdx !== -1, "thinking was sent");
    assert.ok(thinkIdx < loopIdx, "thinking sent before loop runs");
  });

  test("calls handleRememberIntent when NO_TOOLS is true and text matches", async (t) => {
    const ws           = makeWs(t);
    const rememberCalls = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        NO_TOOLS:      true,
        handleRememberIntent: async (text) => rememberCalls.push(text),
      }),
      store:     {},
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "chat", text: "remember that I prefer dark mode" });

    assert.strictEqual(rememberCalls.length, 1);
    assert.ok(rememberCalls[0].includes("remember that"));
  });

  test("does not call handleRememberIntent when NO_TOOLS is false", async (t) => {
    const ws            = makeWs(t);
    const rememberCalls = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        NO_TOOLS:      false,
        handleRememberIntent: async (text) => rememberCalls.push(text),
      }),
      store:     {},
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "chat", text: "remember that I prefer dark mode" });

    assert.strictEqual(rememberCalls.length, 0);
  });

  test("does not call handleRememberIntent when text does not match the intent", async (t) => {
    const ws            = makeWs(t);
    const rememberCalls = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        NO_TOOLS:      true,
        handleRememberIntent: async (text) => rememberCalls.push(text),
      }),
      store:     {},
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "chat", text: "what is the weather today?" });

    assert.strictEqual(rememberCalls.length, 0);
  });

  test("sends memories after the agent loop completes", async (t) => {
    const ws        = makeWs(t);
    const listAllSpy = [];

    const handler = makeWsHandler({
      agent: makeAgent(),
      store:     { listAll: async () => { listAllSpy.push(1); return []; } },
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "chat", text: "hi" });

    assert.ok(listAllSpy.length >= 1);
    assert.ok(sentOf(ws, "memories").length >= 1);
  });

  test("summarizes Codex in isolation and resets its persisted thread", async (t) => {
    const ws = makeWs(t);
    const loopOpts = [];
    const resets = [];
    const agent = makeAgent({
      provider: { name: "codex", model: "gpt-5.4-mini", contextWindow: 200000 },
      runAgentLoop: async (messages, _emitter, opts) => {
        loopOpts.push(opts);
        if (opts.isolatedProviderSession) return "- Compact summary";
        messages.push({ role: "assistant", content: "Answer" });
        return "Answer";
      },
      resetProviderSession: (...args) => resets.push(args),
    });
    const handler = makeWsHandler({
      agent,
      store: { listAll: async () => [] },
      __dirname: TEST_DIR,
    });

    handler(ws);
    const sessionId = sentOf(ws, "session_created")[0].id;
    await ws.emit({ type: "chat", text: "First topic" });
    await ws.emit({ type: "chat", text: "Second topic" });
    await ws.emit({ type: "chat", text: "summarize the conversation" });

    assert.equal(loopOpts.at(-1).isolatedProviderSession, true);
    assert.deepEqual(resets, [[sessionId, "codex"]]);
    assert.equal(sentOf(ws, "context_summarized").at(-1).ok, true);
  });
});

// ─── "stop" message ───────────────────────────────────────────────────────────

describe("message type: confirm_action", () => {
  test("db_execute write: runs the tool with the confirmation token", async (t) => {
    const ws = makeWs(t);
    const callTool = t.mock.fn(async () => "Wrote 1 row.");
    makeHandler({ callTool })(ws);

    await ws.emit({ type: "confirm_action", token: "db_918ap8", tool: "db_execute" });

    assert.strictEqual(callTool.mock.calls.length, 1);
    assert.deepStrictEqual(callTool.mock.calls[0].arguments,
      ["db_execute", { confirmation_token: "db_918ap8" }]);
    assert.strictEqual(sentOf(ws, "error").length, 0);
    const end = sentOf(ws, "stream_end");
    assert.strictEqual(end.at(-1).text, "Wrote 1 row.");
  });

  test("rejects an unknown tool as an invalid confirmation request", async (t) => {
    const ws = makeWs(t);
    const callTool = t.mock.fn(async () => "OK");
    makeHandler({ callTool })(ws);

    await ws.emit({ type: "confirm_action", token: "db_918ap8", tool: "db_query" });

    assert.strictEqual(callTool.mock.calls.length, 0);
    assert.strictEqual(sentOf(ws, "error").at(-1).text, "Invalid confirmation request.");
  });

  test("rejects a malformed token prefix", async (t) => {
    const ws = makeWs(t);
    const callTool = t.mock.fn(async () => "OK");
    makeHandler({ callTool })(ws);

    await ws.emit({ type: "confirm_action", token: "xx_918ap8", tool: "db_execute" });

    assert.strictEqual(callTool.mock.calls.length, 0);
    assert.strictEqual(sentOf(ws, "error").at(-1).text, "Invalid confirmation request.");
  });
});

describe("message type: interrupt_decision", () => {
  test("records reject decisions and refreshes pending interrupt cards", async (t) => {
    const ws = makeWs(t);
    const store = makeInterruptStore({
      id: "wr_reject1",
      session_id: "session-a",
      run_id: null,
      tool_name: "write_file",
      canonical_arguments: { path: "/tmp/example.txt", content: "hello", targetDigest: null },
      protected_payload_ref: null,
      digest: "sha256:abc",
      allowed_decisions: ["approve", "edit", "reject", "respond"],
      decision: null,
      decision_payload: null,
      status: "pending",
      created_at: "2026-07-07T00:00:00.000Z",
      updated_at: "2026-07-07T00:00:00.000Z",
      decided_at: null,
      claimed_at: null,
      completed_at: null,
      expires_at: null,
    });
    const handler = makeWsHandler({
      agent: makeAgent(),
      store,
      __dirname: TEST_DIR,
    });

    handler(ws);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(sentOf(ws, "interrupts").at(-1).interrupts.length, 1);

    await ws.emit({ type: "interrupt_decision", id: "wr_reject1", decision: "reject", response: "wrong target" });

    const decided = sentOf(ws, "interrupt_decided").at(-1);
    assert.strictEqual(decided.interrupt.status, "rejected");
    assert.strictEqual(decided.interrupt.decision, "reject");
    assert.strictEqual(sentOf(ws, "interrupts").at(-1).interrupts.length, 0);
    assert.strictEqual(sentOf(ws, "stream_end").at(-1).text, "Action rejected. Nothing was executed.");
  });
});

describe("message type: stop", () => {
  test("sends stream_end with empty text", async (t) => {
    const ws = makeWs(t);
    makeHandler()(ws);
    await ws.emit({ type: "stop" });

    const end = sentOf(ws, "stream_end");
    assert.strictEqual(end.length, 1);
    assert.strictEqual(end[0].text, "");
  });

  test("aborts the in-flight controller when one has been set", async (t) => {
    const ws       = makeWs(t);
    let capturedSetAbort;

    const handler = makeWsHandler({
      agent: makeAgent({
        runAgentLoop: async (_msgs, _emitter, _opts, _getAbort, setAbort) => {
          capturedSetAbort = setAbort;
          return "";
        },
      }),
      store:     {},
      __dirname: TEST_DIR,
    });

    handler(ws);
    // Run a chat so runAgentLoop receives the setAbort callback
    await ws.emit({ type: "chat", text: "hi" });

    // Manually inject a controller via the captured setter
    const controller = new AbortController();
    capturedSetAbort(controller);

    await ws.emit({ type: "stop" });

    assert.ok(controller.signal.aborted);
  });
});

// ─── "get_memories" message ───────────────────────────────────────────────────

describe("message type: get_memories", () => {
  test("calls store.listAll and emits a memories event", async (t) => {
    const ws   = makeWs(t);
    const rows = [{ id: "a", type: "fact", title: "test", content: "c", tags: ["x"], importance: 4, created_at: null, pinned: true }];
    const expected = [{ id: "a", type: "fact", title: "test", content: "c", tags: ["x"], importance: 4, createdAt: null, pinned: true }];

    const handler = makeWsHandler({
      agent: makeAgent(),
      store:     { listAll: async () => rows },
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "get_memories" });

    const mems = sentOf(ws, "memories");
    assert.ok(mems.length > 0);
    assert.deepStrictEqual(mems[mems.length - 1].memories, expected);
  });
});

// ─── "delete_memory" message ──────────────────────────────────────────────────

describe("message type: delete_memory", () => {
  test("calls callTool('forget', { id }) and sends deleted event", async (t) => {
    const ws        = makeWs(t);
    const toolCalls = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        callTool: async (name, args) => { toolCalls.push({ name, args }); return "OK"; },
      }),
      store:     {},
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "delete_memory", id: "abc-123" });

    assert.strictEqual(toolCalls.length, 1);
    assert.strictEqual(toolCalls[0].name, "forget");
    assert.deepStrictEqual(toolCalls[0].args, { id: "abc-123" });

    const deleted = sentOf(ws, "deleted");
    assert.strictEqual(deleted.length, 1);
    assert.strictEqual(deleted[0].id, "abc-123");
  });

  test("sends an error event when callTool throws", async (t) => {
    const ws = makeWs(t);

    const handler = makeWsHandler({
      agent: makeAgent({
        callTool: async () => { throw new Error("store unreachable"); },
      }),
      store:     {},
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "delete_memory", id: "xyz" });

    const errors = sentOf(ws, "error");
    assert.ok(errors.length > 0);
    assert.ok(errors[0].text.includes("Delete failed"));
    assert.ok(errors[0].text.includes("store unreachable"));
  });
});

// ─── "set_paths" message ──────────────────────────────────────────────────────

describe("message type: set_paths", () => {
  test("sends paths_updated with the new allowlist when a valid array is supplied", async (t) => {
    const ws      = makeWs(t);
    const tmpdir  = os.tmpdir();
    makeHandler()(ws);

    await ws.emit({ type: "set_paths", paths: [tmpdir] });

    const updated = sentOf(ws, "paths_updated");
    assert.ok(updated.length >= 1, "paths_updated was sent");
    assert.ok(Array.isArray(updated[0].paths), "payload carries a paths array");
  });

  test("is silently ignored when paths is not an array", async (t) => {
    const ws = makeWs(t);
    makeHandler()(ws);

    await ws.emit({ type: "set_paths", paths: "/not-an-array" });

    assert.strictEqual(sentOf(ws, "paths_updated").length, 0);
  });

  test("is silently ignored when a path entry is not a non-empty string", async (t) => {
    const ws = makeWs(t);
    makeHandler()(ws);

    await ws.emit({ type: "set_paths", paths: [123] });

    assert.strictEqual(sentOf(ws, "paths_updated").length, 0);
  });

  test("each connection gets its own paths_updated echo", async (t) => {
    const wsA    = makeWs(t);
    const wsB    = makeWs(t);
    const tmpdir = os.tmpdir();
    const handler = makeHandler();
    handler(wsA);
    handler(wsB);

    // The allowlist is app-wide now; set_paths echoes paths_updated only to the
    // emitting connection (send() is per-ws), so neither stream gets the other's.
    await wsA.emit({ type: "set_paths", paths: [tmpdir] });
    await wsB.emit({ type: "set_paths", paths: [tmpdir] });

    assert.strictEqual(wsA.sent.filter(m => m.type === "paths_updated").length, 1);
    assert.strictEqual(wsB.sent.filter(m => m.type === "paths_updated").length, 1);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("error handling", () => {
  test("sends error event when message is not valid JSON", async (t) => {
    const ws = makeWs(t);
    makeHandler()(ws);

    // Emit raw bytes that are not valid JSON
    const listeners = {};
    const ws2 = {
      sent: [],
      send: t.mock.fn((raw) => ws2.sent.push(JSON.parse(raw))),
      on:   (e, h) => { listeners[e] = h; },
    };
    makeHandler()(ws2);
    await listeners["message"]?.(Buffer.from("not { json"));

    const errors = ws2.sent.filter(m => m.type === "error");
    assert.ok(errors.length > 0);
  });

  test("does not send a ws error when store.listAll fails — only logs", async (t) => {
    const ws    = makeWs(t);
    const logged = [];
    t.mock.method(logger, "error", (...a) => logged.push(a.map(String).join(" ")));

    const handler = makeWsHandler({
      agent: makeAgent(),
      store:     { listAll: async () => { throw new Error("db down"); } },
      __dirname: TEST_DIR,
    });

    handler(ws);
    await ws.emit({ type: "get_memories" });

    // No ws error message sent
    assert.strictEqual(sentOf(ws, "error").length, 0);
    // But it was logged
    assert.ok(logged.some(l => l.includes("db down")));
  });
});
