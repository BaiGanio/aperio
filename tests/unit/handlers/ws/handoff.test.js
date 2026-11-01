import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const HANDOFFS_DIR = join(process.cwd(), "var/handoffs");

// =============================================================================
// handleHandoff — generate handoff document, write to disk, rotate context
// =============================================================================
describe("handleHandoff", () => {
  function makeDeps(overrides = {}) {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Work on the authentication module." },
      { role: "assistant", content: "I've implemented the JWT middleware." },
    ];
    return {
      messages,
      sessionId: "session-1",
      currentLang: "en",
      runAgentLoop: mock.fn(async () =>
        "# Handoff — Auth Module\n**Created:** 2025-07-01T12:00:00.000Z\n## Active task\nComplete authentication\n## State of play\nJWT middleware done",
      ),
      emitter: mock.fn(),
      send: mock.fn(),
      sessionLogger: { info: mock.fn(), error: mock.fn() },
      ...overrides,
    };
  }

  test("sends handoff_written ok:false when messages.length < 2", async () => {
    const { handleHandoff } = await import(
      "../../../../lib/emitters/handlers/ws/handoff.js"
    );
    const deps = makeDeps({ messages: [{ role: "user", content: "hi" }] });
    await handleHandoff(null, deps);

    assert.equal(deps.send.mock.calls.length, 1);
    const [type, payload] = deps.send.mock.calls[0].arguments;
    assert.equal(type, "handoff_written");
    assert.equal(payload.ok, false);
    assert.match(payload.reason, /Not enough conversation/);
  });

  test("sends thinking signal before generating", async () => {
    const { handleHandoff } = await import(
      "../../../../lib/emitters/handlers/ws/handoff.js"
    );
    const deps = makeDeps();
    await handleHandoff("Continue auth work", deps);

    const sendTypes = deps.send.mock.calls.map(c => c.arguments[0]);
    assert.ok(sendTypes.includes("thinking"));
  });

  test("generates handoff, writes to disk, and rotates context", async () => {
    const { handleHandoff } = await import(
      "../../../../lib/emitters/handlers/ws/handoff.js"
    );
    // Ensure clean state
    mkdirSync(HANDOFFS_DIR, { recursive: true });

    const deps = makeDeps();
    await handleHandoff("Continue auth work", deps);

    // 1. runAgentLoop was called with a handoff prompt
    assert.equal(deps.runAgentLoop.mock.calls.length, 1);
    const [promptMsgs] = deps.runAgentLoop.mock.calls[0].arguments;
    assert.ok(promptMsgs.length > 0);
    assert.match(promptMsgs[0].content, /Produce a handoff document/);

    // 2. A handoff file was written to var/handoffs/
    const handoffCall = deps.send.mock.calls.find(
      c => c.arguments[0] === "handoff_written" && c.arguments[1].ok === true,
    );
    assert.ok(handoffCall, "handoff_written with ok:true was sent");
    const { path, rotated } = handoffCall.arguments[1];
    assert.ok(path, "handoff file path is present");
    assert.ok(path.includes("var/handoffs/"), `handoff path is in var/handoffs/: ${path}`);
    assert.equal(rotated, true);
    assert.ok(existsSync(path), `handoff file was written: ${path}`);

    // 3. The file content starts with a handoff document
    const content = readFileSync(path, "utf8");
    assert.match(content, /# Handoff/);
    assert.match(content, /Auth Module|authentication/i);

    // 4. Messages rotated: [firstMsg, assistant with handoff brief]
    assert.equal(deps.messages.length, 2);
    assert.equal(deps.messages[0].role, "system");
    assert.equal(deps.messages[1].role, "assistant");
    assert.match(deps.messages[1].content, /\[Handoff brief/);

    // Cleanup the test artifact
    try { rmSync(path, { force: true }); } catch { /* best-effort */ }
  });

  test("includes user-specified focus in the handoff prompt", async () => {
    const { handleHandoff } = await import(
      "../../../../lib/emitters/handlers/ws/handoff.js"
    );
    const deps = makeDeps();
    await handleHandoff("  Fix the WebSocket reconnection bug  ", deps);

    const [promptMsgs] = deps.runAgentLoop.mock.calls[0].arguments;
    assert.match(promptMsgs[0].content, /Fix the WebSocket reconnection bug/);
  });

  test("defaults focus to 'Continue the current task' when none is given", async () => {
    const { handleHandoff } = await import(
      "../../../../lib/emitters/handlers/ws/handoff.js"
    );
    const deps = makeDeps();
    await handleHandoff(null, deps);

    const [promptMsgs] = deps.runAgentLoop.mock.calls[0].arguments;
    assert.match(promptMsgs[0].content, /Continue the current task/);
  });

  test("defaults focus to 'Continue the current task' when focus is whitespace", async () => {
    const { handleHandoff } = await import(
      "../../../../lib/emitters/handlers/ws/handoff.js"
    );
    const deps = makeDeps();
    await handleHandoff("   ", deps);

    const [promptMsgs] = deps.runAgentLoop.mock.calls[0].arguments;
    assert.match(promptMsgs[0].content, /Continue the current task/);
  });

  test("handles runAgentLoop error gracefully", async () => {
    const runAgentLoop = mock.fn(async () => { throw new Error("Generation failed"); });
    const send = mock.fn();
    const sessionLogger = { error: mock.fn(), info: mock.fn() };

    const { handleHandoff } = await import(
      "../../../../lib/emitters/handlers/ws/handoff.js"
    );
    await handleHandoff("test", { ...makeDeps(), runAgentLoop, send, sessionLogger });

    const handoffCall = send.mock.calls.find(c => c.arguments[0] === "handoff_written");
    assert.ok(handoffCall);
    assert.equal(handoffCall.arguments[1].ok, false);
    assert.match(handoffCall.arguments[1].reason, /Generation failed/);
  });

  test("does not write a handoff file when runAgentLoop throws", async () => {
    const runAgentLoop = mock.fn(async () => { throw new Error("fail") });
    const send = mock.fn();
    const { handleHandoff } = await import(
      "../../../../lib/emitters/handlers/ws/handoff.js"
    );
    await handleHandoff("test", makeDeps({ send, runAgentLoop }));

    // Must send ok:false without a path
    const handoffCall = send.mock.calls.find(c => c.arguments[0] === "handoff_written");
    assert.ok(handoffCall);
    assert.equal(handoffCall.arguments[1].ok, false);
    assert.equal(handoffCall.arguments[1].path, undefined);
  });

  test("generates a filesystem path with ISO timestamp and slug", async () => {
    const { handleHandoff } = await import(
      "../../../../lib/emitters/handlers/ws/handoff.js"
    );
    const deps = makeDeps();
    await handleHandoff("fix-login", deps);

    const handoffCall = deps.send.mock.calls.find(
      c => c.arguments[0] === "handoff_written" && c.arguments[1].ok === true,
    );
    assert.ok(handoffCall);
    const { path } = handoffCall.arguments[1];
    assert.match(path, /aperio-handoff-/);
    assert.match(path, /-fix-login\.md$/);

    // Cleanup
    try { rmSync(path, { force: true }); } catch { /* best-effort */ }
  });
});
