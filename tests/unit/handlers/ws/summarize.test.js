import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

// =============================================================================
// handleSummarize — compress conversation into a bullet-point summary
// =============================================================================
describe("handleSummarize", () => {
  function makeDeps(overrides = {}) {
    // Build a realistic message array (≥3 entries to satisfy the guard)
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is TypeScript?" },
      { role: "assistant", content: "TypeScript is a typed superset of JavaScript." },
    ];
    return {
      messages,
      ragStore: {
        index: mock.fn(async () => {}),
      },
      runAgentLoop: mock.fn(async () => "- Key point about TypeScript\n- Another key point"),
      currentLang: "en",
      sessionId: "session-1",
      providerSessionSourceId: "ps-1",
      provider: () => ({ name: "anthropic", model: "claude-3" }),
      resetProviderSession: mock.fn(),
      callTool: mock.fn(async () => "OK"),
      emitter: mock.fn(),
      makeSinkEmitter: () => ({ emitter: mock.fn() }),
      send: mock.fn(),
      sessionLogger: { error: mock.fn(), warn: mock.fn() },
      store: { listAll: async () => [] },
      ...overrides,
    };
  }

  test("sends ok:false when messages.length < 3", async () => {
    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const deps = makeDeps({ messages: [{ role: "user", content: "hi" }] });
    await handleSummarize({}, deps);

    assert.equal(deps.send.mock.calls.length, 1);
    const [type, payload] = deps.send.mock.calls[0].arguments;
    assert.equal(type, "context_summarized");
    assert.equal(payload.ok, false);
    assert.match(payload.reason, /Not enough history/);
  });

  test("sends thinking signal when not in auto mode", async () => {
    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const deps = makeDeps();
    await handleSummarize({ auto: false }, deps);

    const sendTypes = deps.send.mock.calls.map(c => c.arguments[0]);
    assert.ok(sendTypes.includes("thinking"));
  });

  test("does NOT send thinking signal in auto mode", async () => {
    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const deps = makeDeps();
    await handleSummarize({ auto: true }, deps);

    const sendTypes = deps.send.mock.calls.map(c => c.arguments[0]);
    assert.equal(sendTypes.includes("thinking"), false);
  });

  test("uses sink emitter in auto mode so summary never renders as a chat bubble", async () => {
    const sinkEmitter = { emitter: { send: mock.fn() } };
    const makeSinkEmitter = mock.fn(() => sinkEmitter);

    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const deps = makeDeps({ makeSinkEmitter });
    await handleSummarize({ auto: true }, deps);

    // makeSinkEmitter was called to create the sink emitter
    assert.equal(makeSinkEmitter.mock.calls.length, 1);
    // runAgentLoop was called with the sink emitter, not the regular one
    assert.equal(deps.runAgentLoop.mock.calls.length, 1);
  });

  test("calls runAgentLoop with noTools:true and the correct language", async () => {
    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const deps = makeDeps({ currentLang: "es" });
    await handleSummarize({}, deps);

    assert.equal(deps.runAgentLoop.mock.calls.length, 1);
    const [, , opts] = deps.runAgentLoop.mock.calls[0].arguments;
    assert.equal(opts.noTools, true);
    assert.equal(opts.lang, "es");
  });

  test("persists summary to memory via callTool(remember)", async () => {
    const callTool = mock.fn(async () => "OK");
    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const deps = makeDeps({ callTool });
    await handleSummarize({}, deps);

    // Should have called callTool("remember", ...) with type: "project" and tags including "conversation-summary"
    const rememberCalls = callTool.mock.calls.filter(c => c.arguments[0] === "remember");
    assert.equal(rememberCalls.length, 1);
    const [, args] = rememberCalls[0].arguments;
    assert.equal(args.type, "project");
    assert.deepEqual(args.tags, ["conversation-summary"]);
    assert.equal(args.importance, 3);
  });

  test("persists summary even when summary is empty or minimal", async () => {
    const callTool = mock.fn(async () => "OK");
    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const deps = makeDeps({
      callTool,
      runAgentLoop: mock.fn(async () => ""),
    });
    await handleSummarize({}, deps);

    // Short or empty summary should still be persisted (non-fatal)
    const rememberCalls = callTool.mock.calls.filter(c => c.arguments[0] === "remember");
    assert.equal(rememberCalls.length, 1);
  });

  test("compresses messages array to just the first message + summary block", async () => {
    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const msgs = [
      { role: "system", content: "sys prompt" },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
    ];
    const deps = makeDeps({ messages: msgs });
    await handleSummarize({}, deps);

    // After summarization: [firstMsg, { role: "assistant", content: "[Conversation summary]\n..." }]
    assert.equal(deps.messages.length, 2);
    assert.equal(deps.messages[0], msgs[0]); // first message preserved
    assert.equal(deps.messages[1].role, "assistant");
    assert.match(deps.messages[1].content, /\[Conversation summary\]/);
  });

  test("handles runAgentLoop error gracefully", async () => {
    const runAgentLoop = mock.fn(async () => { throw new Error("Model timeout"); });
    const send = mock.fn();
    const sessionLogger = { error: mock.fn() };

    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    await handleSummarize({}, makeDeps({ runAgentLoop, send, sessionLogger }));

    // Must send ok:false with the error message
    const ctxSummarized = send.mock.calls.find(c => c.arguments[0] === "context_summarized");
    assert.ok(ctxSummarized);
    assert.equal(ctxSummarized.arguments[1].ok, false);
    assert.match(ctxSummarized.arguments[1].reason, /Model timeout/);
  });

  test("calls ragStore.index to index the full transcript", async () => {
    const ragIndex = mock.fn(async () => {});
    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const deps = makeDeps({ ragStore: { index: ragIndex } });
    await handleSummarize({}, deps);

    assert.equal(ragIndex.mock.calls.length, 1);
    assert.equal(ragIndex.mock.calls[0].arguments[0], deps.messages);
  });

  test("rstProviderSession for codex provider", async () => {
    const resetProviderSession = mock.fn();
    const provider = () => ({ name: "codex", model: "codex-cli" });

    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const deps = makeDeps({ resetProviderSession, provider });
    await handleSummarize({}, deps);

    assert.equal(resetProviderSession.mock.calls.length, 1);
    assert.equal(resetProviderSession.mock.calls[0].arguments[0], "ps-1");
    assert.equal(resetProviderSession.mock.calls[0].arguments[1], "codex");
  });

  test("does not reset provider session for non-codex providers", async () => {
    const resetProviderSession = mock.fn();
    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const deps = makeDeps({ resetProviderSession }); // default provider is anthropic
    await handleSummarize({}, deps);

    assert.equal(resetProviderSession.mock.calls.length, 0);
  });

  test("broadcasts memories after saving", async () => {
    const { handleSummarize } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const deps = makeDeps();
    await handleSummarize({}, deps);

    // After sending context_summarized, should also send memories
    const sendTypes = deps.send.mock.calls.map(c => c.arguments[0]);
    const ctxIdx = sendTypes.indexOf("context_summarized");
    const memoriesIdx = sendTypes.indexOf("memories");
    assert.ok(memoriesIdx > ctxIdx, "memories broadcast after context_summarized");
  });
});

// =============================================================================
// handleDiscussStart — produce a framing summary for round-table discussions
// =============================================================================
describe("handleDiscussStart", () => {
  function makeDeps(overrides = {}) {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Should we use Postgres or SQLite?" },
      { role: "assistant", content: "Both have trade-offs for our use case." },
    ];
    return {
      messages,
      runAgentLoop: mock.fn(async () => "The team is evaluating Postgres vs SQLite for the memory store."),
      currentLang: "en",
      makeSinkEmitter: () => ({ emitter: mock.fn() }),
      send: mock.fn(),
      sessionLogger: { error: mock.fn() },
      ...overrides,
    };
  }

  test("sends ok:false when messages.length < 3", async () => {
    const { handleDiscussStart } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const result = await handleDiscussStart(makeDeps({ messages: [{ role: "user", content: "hi" }] }));
    assert.deepEqual(result, { ok: false, summary: null });
  });

  test("returns ok:true with generated summary on success", async () => {
    const { handleDiscussStart } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const result = await handleDiscussStart(makeDeps());
    assert.equal(result.ok, true);
    assert.ok(typeof result.summary === "string" && result.summary.length > 0);
  });

  test("calls send(discuss_summary) with the generated text", async () => {
    const send = mock.fn();
    const { handleDiscussStart } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    await handleDiscussStart(makeDeps({ send }));
    assert.ok(send.mock.calls.length >= 1);
    const discussCall = send.mock.calls.find(c => c.arguments[0] === "discuss_summary");
    assert.ok(discussCall);
    assert.equal(discussCall.arguments[1].ok, true);
    assert.ok(typeof discussCall.arguments[1].text === "string");
  });

  test("returns ok:false when runAgentLoop returns empty string", async () => {
    const runAgentLoop = mock.fn(async () => "");
    const { handleDiscussStart } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const result = await handleDiscussStart(makeDeps({ runAgentLoop }));
    assert.deepEqual(result, { ok: false, summary: null });
  });

  test("returns ok:false when runAgentLoop returns whitespace-only string", async () => {
    const runAgentLoop = mock.fn(async () => "  \n  ");
    const { handleDiscussStart } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const result = await handleDiscussStart(makeDeps({ runAgentLoop }));
    assert.deepEqual(result, { ok: false, summary: null });
  });

  test("uses sink emitter so summary never renders as a chat bubble", async () => {
    const sinkEmitter = { send: mock.fn() };
    const makeSinkEmitter = mock.fn(() => ({ emitter: sinkEmitter }));
    const { handleDiscussStart } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    await handleDiscussStart(makeDeps({ makeSinkEmitter }));
    assert.equal(makeSinkEmitter.mock.calls.length, 1);
  });

  test("calls send(discuss_summary ok:false) and returns on runAgentLoop error", async () => {
    const runAgentLoop = mock.fn(async () => { throw new Error("API error"); });
    const send = mock.fn();
    const { handleDiscussStart } = await import(
      "../../../../lib/emitters/handlers/ws/summarize.js"
    );
    const result = await handleDiscussStart(makeDeps({ runAgentLoop, send }));
    assert.deepEqual(result, { ok: false, summary: null });
    const discussCall = send.mock.calls.find(c => c.arguments[0] === "discuss_summary");
    assert.ok(discussCall);
    assert.equal(discussCall.arguments[1].ok, false);
  });
});
