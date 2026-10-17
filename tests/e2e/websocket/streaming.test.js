// tests/e2e/streaming.test.js
// Phase 5: Streaming protocol e2e tests (issue #203).
// Spawns the fixture server, opens WebSocket connections, and verifies the
// streaming protocol (token, stream_end, error messages) works correctly.
//
// No DB, no AI provider, no external network — the fixture is fully in-memory.
// Only system touch: child process (spawn) + OS-assigned port (0).
//
// Uses shared buffered-connect helpers to eliminate handshake races — the
// message listener is attached before `open` resolves, so handshake messages
// (status, provider, session_created) are captured without racing.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { startFixture, readPort, connectBuffered } from "../helpers/ws-helper.js";

// ─── Tests ────────────────────────────────────────────────────────────────
describe("Streaming protocol — Phase 5", () => {

  // ── 1. Single token ─────────────────────────────────────────────────
  test("single token response arrives correctly", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const conn = await connectBuffered(port); t.after(() => conn.close());
    const ws = conn.ws;
    await conn.waitForType("session_created");

    ws.send(JSON.stringify({ type: "set_stream", text: "hello" }));
    ws.send(JSON.stringify({ type: "chat", content: "ping" }));

    const msgs = await conn.collectUntil("stream_end");
    const tokens = msgs.filter((m) => m.type === "token").map((m) => m.text);
    const streamEnd = msgs.find((m) => m.type === "stream_end");

    assert.equal(tokens.length, 1, "one token");
    assert.equal(tokens[0], "hello", "token text matches");
    assert.ok(streamEnd, "stream_end present");
    assert.equal(streamEnd.text, "hello", "stream_end text matches");
    assert.ok(streamEnd.usage, "usage present");
  });

  // ── 2. Multi-word streaming ─────────────────────────────────────────
  test("multi-word response streams each word as a separate token", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const conn = await connectBuffered(port); t.after(() => conn.close());
    const ws = conn.ws;
    await conn.waitForType("session_created");

    ws.send(JSON.stringify({ type: "set_stream", text: "hello world from aperio" }));
    ws.send(JSON.stringify({ type: "chat", content: "test" }));

    const msgs = await conn.collectUntil("stream_end");
    const tokens = msgs.filter((m) => m.type === "token").map((m) => m.text);
    const streamEnd = msgs.find((m) => m.type === "stream_end");

    assert.ok(tokens.length >= 4, `at least 4 tokens, got ${tokens.length}`);
    assert.equal(tokens.join(""), "hello world from aperio", "tokens reassemble correctly");
    assert.equal(streamEnd.text, "hello world from aperio", "stream_end has full text");
  });

  // ── 3. Concurrent connections ───────────────────────────────────────
  test("three concurrent connections each get independent responses", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);

    const responses = ["alpha", "beta", "gamma"];
    const NUM = responses.length;

    // Connect all, set responses, fire all chats, collect all msgs
    const results = await Promise.all(responses.map(async (resp) => {
      const conn = await connectBuffered(port);
      await conn.waitForType("session_created");
      conn.ws.send(JSON.stringify({ type: "set_stream", text: resp }));
      conn.ws.send(JSON.stringify({ type: "chat", content: "concurrent" }));
      const msgs = await conn.collectUntil("stream_end");
      conn.close();
      return { resp, msgs };
    }));

    for (const { resp, msgs } of results) {
      const tokens = msgs.filter((m) => m.type === "token").map((m) => m.text);
      assert.equal(tokens.join(""), resp, `connection got response "${resp}"`);
    }
  });

  // ── 4. Error response ───────────────────────────────────────────────
  test("set_error before chat produces error instead of stream", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const conn = await connectBuffered(port); t.after(() => conn.close());
    const ws = conn.ws;
    await conn.waitForType("session_created");

    ws.send(JSON.stringify({ type: "set_error", message: "custom error" }));
    ws.send(JSON.stringify({ type: "chat", content: "trigger" }));

    const msgs = await conn.collectUntil("error");
    const err = msgs.find((m) => m.type === "error");
    const tokens = msgs.filter((m) => m.type === "token");

    assert.ok(err, "error message received");
    assert.equal(err.message, "custom error", "error message matches");
    assert.equal(tokens.length, 0, "no tokens after error");
  });

  // ── 5. Provider info update ─────────────────────────────────────────
  test("set_provider emits a fresh provider message", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const conn = await connectBuffered(port); t.after(() => conn.close());
    const ws = conn.ws;
    await conn.waitForType("session_created");

    // Clear any handshake leftovers from the buffer so collectUntil doesn't
    // find the initial stub-provider message.
    conn.buffer.splice(0);

    ws.send(JSON.stringify({ type: "set_provider", name: "ollama", model: "llama3.1", thinks: true, contextWindow: 8192 }));

    const msgs = await conn.collectUntil("provider");
    const prov = msgs.find((m) => m.type === "provider");
    assert.ok(prov, "provider message received");
    assert.equal(prov.name, "ollama");
    assert.equal(prov.model, "llama3.1");
    assert.equal(prov.thinks, true);
    assert.equal(prov.contextWindow, 8192);
  });

  // ── 6. Handshake messages ───────────────────────────────────────────
  test("handshake includes status, provider, session_created", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const conn = await connectBuffered(port); t.after(() => conn.close());

    // With buffered connect, handshake messages are already in the buffer —
    // no race between `open` and listener attachment.
    const msgs = conn.buffer;

    assert.ok(msgs.length >= 3, `handshake has >=3 msgs, got ${msgs.length}`);
    assert.equal(msgs[0].type, "status", "first is status");
    assert.equal(msgs[0].text, "connected", "status='connected'");
    assert.equal(msgs[1].type, "provider", "second is provider");
    assert.equal(msgs[2].type, "session_created", "third is session_created");
    assert.ok(msgs[2].id, "session_created has id");
  });

  // ── 7. Message ordering ─────────────────────────────────────────────
  test("stream_start → tokens → stream_end arrive in order", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const conn = await connectBuffered(port); t.after(() => conn.close());
    const ws = conn.ws;
    await conn.waitForType("session_created");

    ws.send(JSON.stringify({ type: "set_stream", text: "a bc def" }));
    ws.send(JSON.stringify({ type: "chat", content: "ordered" }));

    const msgs = await conn.collectUntil("stream_end");
    const types = msgs.map((m) => m.type);

    // Find the chat response in the messages
    const startIdx = types.indexOf("stream_start");
    assert.ok(startIdx >= 0, "has stream_start");
    assert.equal(types[startIdx], "stream_start", "stream_start first");
    assert.equal(types[startIdx + 1], "token", "token follows stream_start");
    assert.equal(types[types.length - 1], "stream_end", "stream_end last");
  });

  // ── 8. Empty response ───────────────────────────────────────────────
  test("empty response produces stream_end with empty text", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const conn = await connectBuffered(port); t.after(() => conn.close());
    const ws = conn.ws;
    await conn.waitForType("session_created");

    ws.send(JSON.stringify({ type: "set_stream", text: "" }));
    ws.send(JSON.stringify({ type: "chat", content: "empty" }));

    const msgs = await conn.collectUntil("stream_end");
    const end = msgs.find((m) => m.type === "stream_end");
    assert.ok(end, "stream_end present for empty response");
    assert.equal(end.text, "", "stream_end.text is empty string");
  });
});
