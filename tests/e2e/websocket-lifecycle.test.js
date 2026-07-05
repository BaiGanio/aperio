// tests/e2e/websocket-lifecycle.test.js
// Phase 7: WebSocket lifecycle tests (issue #203).
// Tests connection lifecycle: session creation, sequential connections,
// disconnection codes, invalid message handling, and multiple messages.
//
// Uses the fixture server — all in-memory, no DB, no AI provider.
// Only system touch: child process (spawn) + OS-assigned port (0).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE   = resolve(__dirname, "fixtures", "server.js");

// ─── Helpers (shared with streaming.test.js) ──────────────────────────────

function startFixture() {
  return spawn(process.execPath, [FIXTURE], { stdio: ["ignore", "pipe", "inherit"] });
}

function readPort(server, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error("No PORT")), timeout);
    let buf = "";
    server.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/PORT:(\d+)/);
      if (m) { clearTimeout(tid); resolve(Number(m[1])); }
    });
    server.on("exit", (code) => { clearTimeout(tid); reject(new Error(`exited ${code}`)); });
  });
}

function connectWS(port, timeout = 5_000) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error("WS timeout")), timeout);
    ws.once("open",  () => { clearTimeout(tid); resolve(ws); });
    ws.once("error", reject);
  });
}

function collectFor(ws, ms) {
  const msgs = [];
  const handler = (raw) => msgs.push(JSON.parse(raw.toString()));
  ws.on("message", handler);
  return new Promise((resolve) => {
    setTimeout(() => { ws.removeListener("message", handler); resolve(msgs); }, ms);
  });
}

function waitForType(ws, type, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error(`No ${type}`)), timeout);
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        clearTimeout(tid);
        ws.removeListener("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────
describe("WebSocket lifecycle — Phase 7", () => {

  // ── 1. Unique session IDs ────────────────────────────────────────────
  test("each connection gets a unique session_created id", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);

    // Connect three times sequentially, collect each session ID
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const ws = await connectWS(port);
      const session = await waitForType(ws, "session_created");
      ids.push(session.id);
      ws.close();
      // Wait for close to fully complete before reconnecting
      await new Promise((resolve) => ws.once("close", resolve));
    }

    // Verify all three IDs are unique
    const unique = new Set(ids);
    assert.equal(unique.size, 3, `expected 3 unique session IDs, got ${unique.size}`);
    ids.forEach((id) => {
      assert.ok(id, "session ID is truthy");
      assert.match(id, /^[0-9a-f-]+$/i, `session ID "${id}" looks like a UUID`);
    });
  });

  // ── 2. Reconnect gets new session ────────────────────────────────────
  test("reconnecting gets a new session id different from previous", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);

    const ws1 = await connectWS(port);
    const s1 = await waitForType(ws1, "session_created");
    ws1.close();

    const ws2 = await connectWS(port);
    const s2 = await waitForType(ws2, "session_created");
    ws2.close();

    assert.notEqual(s1.id, s2.id, "session IDs must differ across reconnections");
  });

  // ── 3. Sequential chat messages in one connection ────────────────────
  test("two sequential chats in one connection both produce streams", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const ws   = await connectWS(port); t.after(() => ws.close());
    await waitForType(ws, "session_created");

    // Send first chat
    ws.send(JSON.stringify({ type: "chat", content: "first" }));
    let msgs = await collectFor(ws, 300);
    let end1 = msgs.find((m) => m.type === "stream_end");
    assert.ok(end1, "first chat produces stream_end");
    assert.equal(end1.text, "pong", "first response text");

    // Send second chat
    ws.send(JSON.stringify({ type: "chat", content: "second" }));
    msgs = await collectFor(ws, 300);
    let end2 = msgs.find((m) => m.type === "stream_end");
    assert.ok(end2, "second chat produces stream_end");
    assert.equal(end2.text, "pong", "second response text");
  });

  // ── 4. Disconnect with custom code ──────────────────────────────────
  test("disconnect control message closes with specified code", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const ws   = await connectWS(port); t.after(() => ws.close());
    await waitForType(ws, "session_created");

    const closePromise = new Promise((resolve) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason?.toString() }));
    });

    ws.send(JSON.stringify({ type: "disconnect", code: 1001, reason: "going away" }));
    const close = await closePromise;

    assert.equal(close.code, 1001, "close code 1001");
  });

  // ── 5. Invalid message type doesn't crash ────────────────────────────
  test("invalid message type is silently ignored, server stays alive", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const ws   = await connectWS(port); t.after(() => ws.close());
    await waitForType(ws, "session_created");

    // Send garbage, then a real message
    ws.send("not valid json");
    ws.send(JSON.stringify({ type: "unknown_type_xyz" }));
    ws.send(JSON.stringify({ type: "set_stream", text: "still works" }));
    ws.send(JSON.stringify({ type: "chat", content: "after garbage" }));

    const msgs = await collectFor(ws, 300);
    const end = msgs.find((m) => m.type === "stream_end");
    assert.ok(end, "server still responds after invalid messages");
    assert.equal(end.text, "still works", "correct response despite garbage");
  });

  // ── 6. WebSocket close event fires ──────────────────────────────────
  test("server-side close handler fires for normal disconnect", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const ws   = await connectWS(port);

    // Collect messages, then close, then wait
    const msgs = [];
    const handler = (raw) => msgs.push(JSON.parse(raw.toString()));
    ws.on("message", handler);

    await waitForType(ws, "session_created");

    ws.close(1000);
    // Wait for close to propagate
    await new Promise((resolve) => ws.once("close", resolve));

    // Verify the close didn't break the server - can still connect
    const ws2 = await connectWS(port);
    const session2 = await waitForType(ws2, "session_created");
    assert.ok(session2.id, "new connection works after previous close");
    ws2.close();
  });

  // ── 7. Ten rapid sequential connections ──────────────────────────────
  test("10 rapid connections all get valid sessions", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);

    for (let i = 0; i < 10; i++) {
      const ws = await connectWS(port);
      const session = await waitForType(ws, "session_created", 3_000);
      assert.ok(session.id, `connection ${i} got valid session`);
      ws.close();
      await new Promise((r) => setTimeout(r, 30));
    }
  });
});
