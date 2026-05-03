import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeWsHandler } from "../../../../lib/emitters/handlers/wsHandler.js";

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
    provider:             { name: "anthropic", model: "claude-haiku-4-5" },
    callTool:             async () => "OK",
    runAgentLoop:         async () => "",
    handleRememberIntent: async () => {},
    fetchMemories:        async () => ({ raw: "", parsed: [] }),
    buildGreeting:        async () => "Greet me",
    OLLAMA_NO_TOOLS:      false,
    OLLAMA_THINKS:        false,
    ...overrides,
  };
}

function makeHandler(agentOverrides = {}) {
  return makeWsHandler({
    agent:      makeAgent(agentOverrides),
    store:      {},
    __dirname:  "/test",
  });
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
    assert.ok(["postgres", "lancedb"].includes(p.db));
  });

  test("provider message includes the current OLLAMA_THINKS flag", (t) => {
    const ws = makeWs(t);
    makeHandler({ OLLAMA_THINKS: true })(ws);

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
        buildGreeting:  async () => { greetSpy.push(1); return "Hello!"; },
        runAgentLoop:   async () => { loopSpy.push(1); return ""; },
        fetchMemories:  async () => ({ raw: "", parsed: [{ id: "1" }] }),
      }),
      store:     {},
      __dirname: "/test",
    });

    handler(ws);
    await ws.emit({ type: "init" });

    // greeting and loop each called once
    assert.strictEqual(greetSpy.length, 1);
    assert.strictEqual(loopSpy.length,  1);
    // two memories events (before and after the loop)
    assert.strictEqual(sentOf(ws, "memories").length, 2);
  });

  test("passes noTools:true to runAgentLoop for non-anthropic providers", async (t) => {
    const ws       = makeWs(t);
    const loopArgs = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        provider:       { name: "ollama", model: "llama3.1" },
        runAgentLoop:   async (msgs, _emitter, opts) => { loopArgs.push(opts); return ""; },
      }),
      store:     {},
      __dirname: "/test",
    });

    handler(ws);
    await ws.emit({ type: "init" });

    assert.deepStrictEqual(loopArgs[0], { noTools: true });
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
      __dirname: "/test",
    });

    handler(ws);
    await ws.emit({ type: "init" });

    assert.deepStrictEqual(loopArgs[0], {});
  });

  test("ignores subsequent init messages (runs only once)", async (t) => {
    const ws     = makeWs(t);
    const spy    = [];
    const handler = makeWsHandler({
      agent: makeAgent({ buildGreeting: async () => { spy.push(1); return "Hi"; } }),
      store:     {},
      __dirname: "/test",
    });

    handler(ws);
    await ws.emit({ type: "init" });
    await ws.emit({ type: "init" });
    await ws.emit({ type: "init" });

    assert.strictEqual(spy.length, 1);
  });

  test("re-announces provider when OLLAMA_THINKS changes during the greeting loop", async (t) => {
    const ws    = makeWs(t);
    const agent = makeAgent({
      OLLAMA_THINKS: false,
      runAgentLoop:  async function() {
        // simulate the agent auto-detecting thinking mid-stream
        agent.OLLAMA_THINKS = true;
        return "";
      },
    });

    makeWsHandler({ agent, store: {}, __dirname: "/test" })(ws);
    await ws.emit({ type: "init" });

    const providerMsgs = sentOf(ws, "provider");
    // one on connection + one re-announcement
    assert.strictEqual(providerMsgs.length, 2);
    assert.strictEqual(providerMsgs[1].thinks, true);
  });

  test("does NOT re-announce provider when OLLAMA_THINKS stays the same", async (t) => {
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
      __dirname: "/test",
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
      __dirname: "/test",
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
      store: {}, __dirname: "/test",
    });
    handler2(ws2);
    await ws2.emit({ type: "chat", text: "hi" });

    const thinkIdx = sentOrder.indexOf("thinking");
    const loopIdx  = sentOrder.indexOf("loop");
    assert.ok(thinkIdx !== -1, "thinking was sent");
    assert.ok(thinkIdx < loopIdx, "thinking sent before loop runs");
  });

  test("calls handleRememberIntent when OLLAMA_NO_TOOLS is true and text matches", async (t) => {
    const ws           = makeWs(t);
    const rememberCalls = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        OLLAMA_NO_TOOLS:      true,
        handleRememberIntent: async (text) => rememberCalls.push(text),
      }),
      store:     {},
      __dirname: "/test",
    });

    handler(ws);
    await ws.emit({ type: "chat", text: "remember that I prefer dark mode" });

    assert.strictEqual(rememberCalls.length, 1);
    assert.ok(rememberCalls[0].includes("remember that"));
  });

  test("does not call handleRememberIntent when OLLAMA_NO_TOOLS is false", async (t) => {
    const ws            = makeWs(t);
    const rememberCalls = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        OLLAMA_NO_TOOLS:      false,
        handleRememberIntent: async (text) => rememberCalls.push(text),
      }),
      store:     {},
      __dirname: "/test",
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
        OLLAMA_NO_TOOLS:      true,
        handleRememberIntent: async (text) => rememberCalls.push(text),
      }),
      store:     {},
      __dirname: "/test",
    });

    handler(ws);
    await ws.emit({ type: "chat", text: "what is the weather today?" });

    assert.strictEqual(rememberCalls.length, 0);
  });

  test("sends memories after the agent loop completes", async (t) => {
    const ws        = makeWs(t);
    const fetchSpy  = [];

    const handler = makeWsHandler({
      agent: makeAgent({
        fetchMemories: async () => { fetchSpy.push(1); return { raw: "", parsed: [] }; },
      }),
      store:     {},
      __dirname: "/test",
    });

    handler(ws);
    await ws.emit({ type: "chat", text: "hi" });

    assert.ok(fetchSpy.length >= 1);
    assert.ok(sentOf(ws, "memories").length >= 1);
  });
});

// ─── "stop" message ───────────────────────────────────────────────────────────

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
      __dirname: "/test",
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
  test("calls fetchMemories and emits a memories event", async (t) => {
    const ws      = makeWs(t);
    const records = [{ id: "a", title: "test" }];

    const handler = makeWsHandler({
      agent: makeAgent({ fetchMemories: async () => ({ raw: "", parsed: records }) }),
      store:     {},
      __dirname: "/test",
    });

    handler(ws);
    const before = ws.sent.length;
    await ws.emit({ type: "get_memories" });

    const mems = sentOf(ws, "memories");
    assert.ok(mems.length > 0);
    assert.deepStrictEqual(mems[mems.length - 1].memories, records);
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
      __dirname: "/test",
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
      __dirname: "/test",
    });

    handler(ws);
    await ws.emit({ type: "delete_memory", id: "xyz" });

    const errors = sentOf(ws, "error");
    assert.ok(errors.length > 0);
    assert.ok(errors[0].text.includes("Delete failed"));
    assert.ok(errors[0].text.includes("store unreachable"));
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

  test("does not send a ws error when fetchMemories fails — only logs", async (t) => {
    const ws    = makeWs(t);
    const logged = [];
    t.mock.method(console, "error", (...a) => logged.push(a.join(" ")));

    const handler = makeWsHandler({
      agent: makeAgent({
        fetchMemories: async () => { throw new Error("db down"); },
      }),
      store:     {},
      __dirname: "/test",
    });

    handler(ws);
    await ws.emit({ type: "get_memories" });

    // No ws error message sent
    assert.strictEqual(sentOf(ws, "error").length, 0);
    // But it was logged
    assert.ok(logged.some(l => l.includes("db down")));
  });
});
