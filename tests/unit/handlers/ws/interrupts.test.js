import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

// =============================================================================
// handleConfirmAction — approve a stashed tool-confirmation
// =============================================================================
describe("handleConfirmAction", () => {
  function makeDeps(overrides) {
    return Object.assign({
      store: {},
      callTool: mock.fn(async function () { return "Done."; }),
      messages: [],
      send: mock.fn(),
      sessionLogger: { error: mock.fn() },
    }, overrides);
  }

  test("sends error when tool is not in CONFIRMABLE_TOOLS", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const deps = makeDeps();
    await mod.handleConfirmAction({ token: "wr_abc", tool: "unknown_tool" }, deps);

    assert.equal(deps.send.mock.calls.length, 1);
    assert.equal(deps.send.mock.calls[0].arguments[0], "error");
    assert.match(deps.send.mock.calls[0].arguments[1].text, /Invalid confirmation/);
  });

  test("sends error when token is not a string", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const deps = makeDeps();
    await mod.handleConfirmAction({ token: 12345, tool: "write_file" }, deps);

    assert.equal(deps.send.mock.calls[0].arguments[0], "error");
    assert.match(deps.send.mock.calls[0].arguments[1].text, /Invalid confirmation/);
  });

  test("sends error when token format is invalid", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const deps = makeDeps();
    await mod.handleConfirmAction({ token: "bad-format-xxx", tool: "write_file" }, deps);

    assert.equal(deps.send.mock.calls[0].arguments[0], "error");
    assert.match(deps.send.mock.calls[0].arguments[1].text, /Invalid confirmation/);
  });

  test("sends error when token is missing", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const deps = makeDeps();
    await mod.handleConfirmAction({ tool: "write_file" }, deps);

    assert.equal(deps.send.mock.calls[0].arguments[0], "error");
  });

  test("falls back to callTool when decideAndMaybeExecute returns 404", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const send = mock.fn();
    const callTool = mock.fn(async function () { return "Done."; });
    await mod.handleConfirmAction(
      { token: "wr_abc123", tool: "write_file" },
      { store: {}, callTool, messages: [], send, sessionLogger: { error: mock.fn() } },
    );

    // 404 triggers the callTool fallback, which succeeds
    assert.equal(callTool.mock.calls.length, 1);
    assert.equal(callTool.mock.calls[0].arguments[0], "write_file");

    // stream_end is sent on success
    const streamEnd = send.mock.calls.find(function (c) { return c.arguments[0] === "stream_end"; });
    assert.ok(streamEnd, "stream_end sent on successful fallback execution");
  });

  test("sends thinking signal after validation passes", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const send = mock.fn();
    await mod.handleConfirmAction(
      { token: "wr_abc123", tool: "write_file" },
      { store: {}, callTool: mock.fn(), messages: [], send, sessionLogger: { error: mock.fn() } },
    );

    assert.ok(send.mock.calls.some(function (c) { return c.arguments[0] === "thinking"; }));
  });
});

// =============================================================================
// handleInterruptDecision — approve/edit/reject/respond to an interrupt
// =============================================================================
describe("handleInterruptDecision", () => {
  function makeDeps(overrides) {
    return Object.assign({
      store: {},
      messages: [],
      send: mock.fn(),
      sessionLogger: { error: mock.fn() },
    }, overrides);
  }

  test("sends error when decision is invalid", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const deps = makeDeps();
    await mod.handleInterruptDecision({ id: "int_1", decision: "invalid" }, deps);

    assert.equal(deps.send.mock.calls[0].arguments[0], "error");
    assert.match(deps.send.mock.calls[0].arguments[1].text, /Invalid interrupt decision/);
  });

  test("ignores invalid id field name — uses undefined which is not a string", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const send = mock.fn();
    await mod.handleInterruptDecision(
      { decision: "approve" },
      { store: {}, messages: [], send, sessionLogger: { error: mock.fn() } },
    );

    assert.equal(send.mock.calls[0].arguments[0], "error");
  });

  test("uses id field for decision", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const send = mock.fn();
    await mod.handleInterruptDecision(
      { id: "del_xyz99", decision: "reject" },
      { store: {}, messages: [], send, sessionLogger: { error: mock.fn() } },
    );

    // Should not send "Invalid interrupt decision"
    const invalidCalls = send.mock.calls.filter(function (c) {
      return c.arguments[0] === "error";
    });
    // decideAndMaybeExecute will fail, so there WILL be an error, but
    // it should be about the execution failure, not "Invalid interrupt decision"
    const onlyInvalid = invalidCalls.filter(function (c) {
      return c.arguments[1].text === "Invalid interrupt decision.";
    });
    assert.equal(onlyInvalid.length, 0);
  });

  test("sends thinking for approve decision", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const send = mock.fn();
    await mod.handleInterruptDecision(
      { id: "del_xyz99", decision: "approve" },
      { store: {}, messages: [], send, sessionLogger: { error: mock.fn() } },
    );

    assert.ok(send.mock.calls.some(function (c) { return c.arguments[0] === "thinking"; }));
  });

  test("sends thinking for edit decision", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const send = mock.fn();
    await mod.handleInterruptDecision(
      { id: "del_xyz99", decision: "edit", editedArguments: { content: "new" } },
      { store: {}, messages: [], send, sessionLogger: { error: mock.fn() } },
    );

    assert.ok(send.mock.calls.some(function (c) { return c.arguments[0] === "thinking"; }));
  });

  test("does NOT send thinking for reject decision", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const send = mock.fn();
    await mod.handleInterruptDecision(
      { id: "del_xyz99", decision: "reject" },
      { store: {}, messages: [], send, sessionLogger: { error: mock.fn() } },
    );

    assert.equal(send.mock.calls.some(function (c) { return c.arguments[0] === "thinking"; }), false);
  });

  test("does NOT send thinking for respond decision", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const send = mock.fn();
    await mod.handleInterruptDecision(
      { id: "del_xyz99", decision: "respond", response: "checking now" },
      { store: {}, messages: [], send, sessionLogger: { error: mock.fn() } },
    );

    assert.equal(send.mock.calls.some(function (c) { return c.arguments[0] === "thinking"; }), false);
  });

  test("sends error when decideAndMaybeExecute fails", async function () {
    const mod = await import("../../../../lib/emitters/handlers/ws/interrupts.js");
    const send = mock.fn();
    await mod.handleInterruptDecision(
      { id: "del_xyz99", decision: "approve" },
      { store: {}, messages: [], send, sessionLogger: { error: mock.fn() } },
    );

    const errorCall = send.mock.calls.find(function (c) { return c.arguments[0] === "error"; });
    assert.ok(errorCall, "error was sent on failure");
  });
});
