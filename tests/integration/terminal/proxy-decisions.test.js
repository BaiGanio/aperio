// Proxy mode's confirmation and interrupt flows, over a real socket (#539, P1).
//
// `tests/integration/terminal/proxy.test.js` covered exactly one pure function
// (proxyModelVar). There was no test that ran the proxy's message router or its
// command dispatcher at all, which is how a whole interaction generation went
// missing without anything going red.
//
// This drives the real runProxy() against a stub WebSocket server: not Aperio,
// just something that speaks the handful of frames the flow needs. So there is
// no agent, no provider, no database, no port of ours to collide with (the stub
// binds 0 and reports what it got), and nothing to clean up but the server.
//
// What is asserted is the half the terminal owns: that a proposal is shown with
// its tool and target, that the decision leaves as the frame the server's
// handler accepts, that a reconnect's restored interrupts are listed and
// decidable, and that /discuss refuses to claim a round table the server says
// it cannot run.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { WebSocketServer } from "ws";

const plain = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

let wss, port, serverSocket, root, prevPrefs, prevRealWrite, prevProvider, prevModel, proxyHandle;
let runProxy, stopSpinner, state;
let stdin;

/** Everything printed, from either stream. */
let captured = [];
/** Frames the stub server received from the proxy. */
let received = [];

const output = () => plain(captured.join(""));

/**
 * Start reading output from here on.
 *
 * Asserting against the cumulative buffer is a trap: "2 actions awaiting" from
 * an earlier test satisfies a later wait instantly, and the test then races the
 * loop it was supposed to be waiting for. Every wait below reads a window that
 * starts when the step does.
 */
function watch() {
  const from = captured.length;
  return () => plain(captured.slice(from).join(""));
}

/** Push a frame at the proxy as the server would. */
function serverSend(obj) {
  serverSocket.send(JSON.stringify(obj));
}

/** Wait until `check` holds, or fail with what was actually seen. */
async function until(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}.\nOutput:\n${output()}\nFrames: ${JSON.stringify(received)}`);
}

/** Type one line and wait for the loop to react. See standalone-loop.test.js. */
async function type(line, expect, timeoutMs = 5000) {
  const before = captured.length;
  stdin.write(`${line}\n`);
  const seen = () => plain(captured.slice(before).join(""));
  await until(
    () => (expect instanceof RegExp ? expect.test(seen()) : seen().includes(expect)),
    `${expect} after "${line}"`,
    timeoutMs,
  );
  return seen();
}

/** Wait for `expect` to appear in a window opened by watch(). */
async function waitFor(seen, expect, what, timeoutMs = 5000) {
  await until(
    () => (expect instanceof RegExp ? expect.test(seen()) : seen().includes(expect)),
    what ?? String(expect),
    timeoutMs,
  );
  return seen();
}

/** Wait for a frame of this type and return it. */
async function frame(type_, timeoutMs = 5000) {
  await until(() => received.some(f => f.type === type_), `a ${type_} frame`, timeoutMs);
  return received.find(f => f.type === type_);
}

/**
 * End the turn as the server would.
 *
 * The proxy arms `rl.once("line")` from promptUser(), which the emitter calls on
 * stream_end. A line typed before that is emitted with no listener attached and
 * is silently lost — which is exactly what made this suite hang the first time.
 * Every step that leaves the proxy waiting must close the turn.
 */
function endTurn(text = "") {
  serverSend({ type: "stream_end", text });
}

const PROVIDER_FRAME = {
  type: "provider",
  name: "faketest",
  model: "fake-model",
  roundtableAvailable: false,
  roundtableReason: "no verifier model is configured",
};

before(async () => {
  root = mkdtempSync(join(tmpdir(), "aperio-proxy-decisions-"));

  // Before the import — several modules behind proxy.js read process.env into
  // module-level constants at import time.
  prevPrefs = process.env.APERIO_CLI_PREFS;
  process.env.APERIO_CLI_PREFS = join(root, "cli-prefs.json");
  prevProvider = process.env.AI_PROVIDER;
  prevModel = process.env.ANTHROPIC_MODEL;
  process.env.AI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_MODEL = "fake-model";

  ({ runProxy } = await import("../../../lib/terminal/proxy.js"));
  ({ stopSpinner } = await import("../../../lib/utils/chat-utils.js"));
  ({ state } = await import("../../../lib/terminal/state.js"));

  // Port 0: the OS picks a free one, so this never collides with a running
  // Aperio or another session's test.
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise(r => wss.once("listening", r));
  port = wss.address().port;

  const connected = new Promise(resolve => {
    wss.on("connection", ws => {
      serverSocket = ws;
      ws.on("message", data => { received.push(JSON.parse(data.toString())); });
      resolve();
    });
  });

  // Forwarding is not optional — see the note in standalone-loop.test.js.
  prevRealWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return prevRealWrite(chunk, ...rest);
  };

  stdin = new PassThrough();
  const stdout = new Writable({
    write(chunk, _enc, cb) { captured.push(chunk.toString()); cb(); },
  });

  proxyHandle = await runProxy(port, false, { stdin, stdout });
  await connected;
  await frame("init");

  // The connect handshake, in the order wsHandler.js sends it.
  serverSend({ type: "status", text: "connected" });
  serverSend(PROVIDER_FRAME);
  serverSend({ type: "session_created", id: "sess-1" });
  serverSend({ type: "interrupts", interrupts: [] });
  serverSend({ type: "stream_start" });
  serverSend({ type: "token", text: "hello from the stub" });
  serverSend({ type: "stream_end", text: "hello from the stub" });
  await until(() => output().includes("hello from the stub"), "the greeting");
});

after(() => {
  if (prevRealWrite) process.stdout.write = prevRealWrite;
  // Without this the client re-dials every 1.5s forever and the process never
  // exits — the suite ran green and then hung the first time round.
  try { proxyHandle?.close(); } catch { /* already closed */ }
  try { stopSpinner?.(); } catch { /* already stopped */ }
  if (state) state.proxySafeSend = null;
  try { stdin?.destroy(); } catch { /* already gone */ }
  try { serverSocket?.terminate(); } catch { /* already gone */ }
  if (wss) wss.close();
  for (const [key, prev] of [
    ["APERIO_CLI_PREFS", prevPrefs], ["AI_PROVIDER", prevProvider], ["ANTHROPIC_MODEL", prevModel],
  ]) {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  rmSync(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A live proposal: propose → approve
// ═══════════════════════════════════════════════════════════════════════════════

describe("proxy confirmations", () => {
  test("nothing is pending after a clean connect", async () => {
    await type("/pending", "nothing is awaiting a decision");
  });

  test("a proposal is shown with its tool, target and token", async () => {
    const seen = watch();
    serverSend({
      type: "action_confirm_pending",
      token: "wr_p1",
      tool: "write_file",
      label: "Write report.md",
      summary: "Target: /tmp/report.md",
      destructive: false,
    });
    endTurn();
    await waitFor(seen, "confirmation required", "the confirmation banner");
    assert.match(seen(), /tool:\s*write_file/);
    assert.match(seen(), /Write report\.md/);
    assert.match(seen(), /token:\s*wr_p1/);
    assert.doesNotMatch(seen(), /\[event: action_confirm_pending\]/, "the old dead-end must be gone");
  });

  test("/approve sends confirm_action with the token and tool", async () => {
    received = [];
    const seen = watch();
    stdin.write("/approve\n");
    const sent = await frame("confirm_action");
    assert.deepEqual(sent, { type: "confirm_action", token: "wr_p1", tool: "write_file" });

    // The server's reply to that frame, and the receipt it renders.
    serverSend({
      type: "interrupt_decided",
      decision: "approve",
      interrupt: { id: "wr_p1", tool: "write_file" },
      result: "wrote 12 bytes",
    });
    endTurn("wrote 12 bytes");
    await waitFor(seen, "approved", "the approval receipt");
    assert.match(seen(), /write_file/);
  });

  test("the approved action does not stay pending", async () => {
    const seen = watch();
    stdin.write("/pending\n");
    await waitFor(seen, "nothing is awaiting a decision", "the empty listing");
  });

  test("/reject on a live proposal runs nothing and sends nothing", async () => {
    const proposed = watch();
    serverSend({
      type: "action_confirm_pending",
      token: "del_p2", tool: "delete_file", label: "Delete old.md",
      summary: "Target: /tmp/old.md", destructive: true,
    });
    endTurn();
    await waitFor(proposed, "del_p2", "the second proposal");

    received = [];
    const seen = watch();
    stdin.write("/reject\n");
    await waitFor(seen, "rejected", "the rejection");
    assert.match(seen(), /delete_file did not run/);
    // There is no reject_action message: dropping the one-shot token IS the
    // rejection, so the proxy must not invent a frame for it.
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(received, [], "rejecting a live proposal sends nothing");

    const empty = watch();
    stdin.write("/pending\n");
    await waitFor(empty, "nothing is awaiting a decision", "the empty listing");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Durable interrupts: the restored-after-connect path
// ═══════════════════════════════════════════════════════════════════════════════

describe("proxy durable interrupts", () => {
  const ROWS = [
    {
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      tool: "write_file", status: "pending",
      allowedDecisions: ["approve", "edit", "reject", "respond"],
      arguments: { path: "/tmp/restored.md", content: "x" },
    },
    {
      id: "bbbbbbbb-1111-2222-3333-444444444444",
      tool: "db_execute", status: "pending",
      allowedDecisions: ["approve", "reject"],
      arguments: { sql: "DELETE FROM memories" },
    },
  ];

  /** Replay the given rows and wait for the proxy to list them. */
  async function replay(rows, expect) {
    const seen = watch();
    serverSend({ type: "interrupts", interrupts: rows });
    endTurn();
    await waitFor(seen, expect, "the restored list");
    return seen;
  }

  test("a restored interrupts replay is listed with each tool and target", async () => {
    const seen = await replay(ROWS, "2 actions awaiting your decision");
    assert.match(seen(), /write_file/);
    assert.match(seen(), /\/tmp\/restored\.md/);
    assert.match(seen(), /DELETE FROM memories/);
  });

  test("/approve with two pending refuses rather than guessing which", async () => {
    const seen = watch();
    stdin.write("/approve\n");
    await waitFor(seen, "2 items are awaiting", "the ambiguity refusal");
    assert.match(seen(), /\/approve 1/);
  });

  test("/respond carries the text in interrupt_decision", async () => {
    received = [];
    stdin.write("/respond 1 use the other path\n");
    const sent = await frame("interrupt_decision");
    assert.equal(sent.id, ROWS[0].id);
    assert.equal(sent.decision, "respond");
    assert.equal(sent.response, "use the other path");
    endTurn("Response recorded. Nothing was executed.");
  });

  test("/edit sends the parsed arguments", async () => {
    await replay(ROWS, "2 actions awaiting your decision");
    received = [];
    stdin.write('/edit 1 {"path":"/tmp/elsewhere.md"}\n');
    const sent = await frame("interrupt_decision");
    assert.equal(sent.decision, "edit");
    assert.deepEqual(sent.editedArguments, { path: "/tmp/elsewhere.md" });
    endTurn("Done.");
  });

  test("/edit is refused on a row that does not allow it", async () => {
    await replay([ROWS[1]], "1 action awaiting your decision");
    received = [];
    const seen = watch();
    stdin.write('/edit {"sql":"SELECT 1"}\n');
    await waitFor(seen, "does not accept", "the refusal");
    assert.match(seen(), /db_execute/);
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(received, [], "a refused decision must not reach the server");
  });

  test("/reject on a durable row goes through interrupt_decision", async () => {
    received = [];
    stdin.write("/reject 1\n");
    const sent = await frame("interrupt_decision");
    assert.equal(sent.id, ROWS[1].id);
    assert.equal(sent.decision, "reject");
    endTurn("Action rejected. Nothing was executed.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// /discuss may not claim a round table the server cannot run
// ═══════════════════════════════════════════════════════════════════════════════

describe("proxy /discuss capability", () => {
  test("/discuss on is refused with the server's own reason", async () => {
    const seen = watch();
    stdin.write("/discuss on\n");
    await waitFor(seen, "round table is unavailable", "the refusal");
    assert.match(seen(), /no verifier model is configured/);
    assert.doesNotMatch(seen(), /discuss mode: on/);
  });

  test("a refused /discuss does not flag the next chat as a round table", async () => {
    received = [];
    stdin.write("just a normal question\n");
    const sent = await frame("chat");
    assert.equal(sent.roundtable, undefined, "the turn must not claim a round table");
    endTurn("ok");
  });

  test("/discuss on is accepted once the server says it is available", async () => {
    const available = watch();
    serverSend({ ...PROVIDER_FRAME, roundtableAvailable: true, roundtableReason: null });
    // `provider` prints nothing when the capability is gained, so there is no
    // output to wait on — give the frame a tick to be processed.
    await new Promise(r => setTimeout(r, 100));
    available;
    const seen = watch();
    stdin.write("/discuss on\n");
    await waitFor(seen, "discuss mode: on", "the enabled notice");
    assert.doesNotMatch(seen(), /unavailable/);
  });

  test("the next chat then carries the round-table flag", async () => {
    received = [];
    stdin.write("deliberate on this\n");
    const sent = await frame("chat");
    assert.equal(sent.roundtable, true);
    endTurn("ok");
  });

  test("losing the capability mid-session turns the mode off with the reason", async () => {
    const seen = watch();
    serverSend(PROVIDER_FRAME);
    await waitFor(seen, "no verifier model is configured", "the auto-off notice");
    received = [];
    stdin.write("another question\n");
    const sent = await frame("chat");
    assert.equal(sent.roundtable, undefined, "a mode the server dropped must not ride along");
    endTurn("ok");
  });
});
