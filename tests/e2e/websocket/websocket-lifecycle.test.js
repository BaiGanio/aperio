// tests/e2e/websocket-lifecycle.test.js
// Phase 7: WebSocket lifecycle tests (issue #203).
// Tests connection lifecycle: session creation, sequential connections,
// disconnection codes, invalid message handling, and multiple messages.
//
// Uses the fixture server — all in-memory, no DB, no AI provider.
// Only system touch: child process (spawn) + OS-assigned port (0).
//
// Uses shared buffered-connect helpers to eliminate handshake races — the
// message listener is attached before `open` resolves, so handshake messages
// (status, provider, session_created) are captured without racing.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { startFixture, readPort, connectBuffered } from "../helpers/ws-helper.js";

// ─── Tests ────────────────────────────────────────────────────────────────
describe("WebSocket lifecycle — Phase 7", () => {

  // ── 1. Unique session IDs ────────────────────────────────────────────
  test("each connection gets a unique session_created id", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);

    // Connect three times sequentially, collect each session ID
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const conn = await connectBuffered(port);
      const session = await conn.waitForType("session_created");
      ids.push(session.id);
      conn.close();
      // Wait for close to fully complete before reconnecting
      await new Promise((resolve) => conn.ws.once("close", resolve));
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

    const conn1 = await connectBuffered(port);
    const s1 = await conn1.waitForType("session_created");
    conn1.close();

    const conn2 = await connectBuffered(port);
    const s2 = await conn2.waitForType("session_created");
    conn2.close();

    assert.notEqual(s1.id, s2.id, "session IDs must differ across reconnections");
  });

  // ── 3. Sequential chat messages in one connection ────────────────────
  test("two sequential chats in one connection both produce streams", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const conn = await connectBuffered(port); t.after(() => conn.close());
    const ws = conn.ws;
    await conn.waitForType("session_created");

    // Send first chat
    ws.send(JSON.stringify({ type: "chat", content: "first" }));
    let msgs = await conn.collectUntil("stream_end");
    let end1 = msgs.find((m) => m.type === "stream_end");
    assert.ok(end1, "first chat produces stream_end");
    assert.equal(end1.text, "pong", "first response text");

    // Send second chat
    ws.send(JSON.stringify({ type: "chat", content: "second" }));
    msgs = await conn.collectUntil("stream_end");
    let end2 = msgs.find((m) => m.type === "stream_end");
    assert.ok(end2, "second chat produces stream_end");
    assert.equal(end2.text, "pong", "second response text");
  });

  // ── 4. Disconnect with custom code ──────────────────────────────────
  test("disconnect control message closes with specified code", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const conn = await connectBuffered(port); t.after(() => conn.close());
    const ws = conn.ws;
    await conn.waitForType("session_created");

    const closePromise = new Promise((resolve) => {
      ws.once("close", (code) => resolve({ code }));
    });

    ws.send(JSON.stringify({ type: "disconnect", code: 1001, reason: "going away" }));
    const close = await closePromise;

    assert.equal(close.code, 1001, "close code 1001");
  });

  // ── 5. Invalid message type doesn't crash ────────────────────────────
  test("invalid message type is silently ignored, server stays alive", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const conn = await connectBuffered(port); t.after(() => conn.close());
    const ws = conn.ws;
    await conn.waitForType("session_created");

    // Send garbage, then a real message
    ws.send("not valid json");
    ws.send(JSON.stringify({ type: "unknown_type_xyz" }));
    ws.send(JSON.stringify({ type: "set_stream", text: "still works" }));
    ws.send(JSON.stringify({ type: "chat", content: "after garbage" }));

    const msgs = await conn.collectUntil("stream_end");
    const end = msgs.find((m) => m.type === "stream_end");
    assert.ok(end, "server still responds after invalid messages");
    assert.equal(end.text, "still works", "correct response despite garbage");
  });

  // ── 6. Server-side close handler ─────────────────────────────────────
  test("server-side close handler fires for normal disconnect", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const conn = await connectBuffered(port);
    const ws = conn.ws;

    // Collect messages, then close, then wait
    await conn.waitForType("session_created");

    ws.close(1000);
    // Wait for close to propagate
    await new Promise((resolve) => ws.once("close", resolve));

    // Verify the close didn't break the server - can still connect
    const conn2 = await connectBuffered(port);
    const session2 = await conn2.waitForType("session_created");
    assert.ok(session2.id, "new connection works after previous close");
    conn2.close();
  });

  // ── 7. Ten rapid sequential connections ──────────────────────────────
  test("10 rapid connections all get valid sessions", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);

    for (let i = 0; i < 10; i++) {
      const conn = await connectBuffered(port, 3_000);
      const session = await conn.waitForType("session_created", 3_000);
      assert.ok(session.id, `connection ${i} got valid session`);
      conn.close();
      // Wait for full close instead of a fixed 30ms sleep
      await new Promise((resolve) => conn.ws.once("close", resolve));
    }
  });
});
