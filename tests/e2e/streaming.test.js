// tests/e2e/streaming.test.js
// Phase 5: Streaming protocol e2e tests (issue #203).
// Spawns the fixture server, opens WebSocket connections, and verifies the
// streaming protocol (token, stream_end, error messages) works correctly.
//
// No DB, no AI provider, no external network — the fixture is fully in-memory.
// Only system touch: child process (spawn) + OS-assigned port (0).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE   = resolve(__dirname, "fixtures", "server.js");

// ─── Helpers ──────────────────────────────────────────────────────────────

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

// Collect messages for a given duration, then return all of them.
function collectFor(ws, ms) {
  const msgs = [];
  const handler = (raw) => msgs.push(JSON.parse(raw.toString()));
  ws.on("message", handler);
  return new Promise((resolve) => {
    setTimeout(() => {
      ws.removeListener("message", handler);
      resolve(msgs);
    }, ms);
  });
}

// Wait for a specific message type, returning it.
function waitForType(ws, type, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error(`No ${type} within timeout`)), timeout);
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
describe("Streaming protocol — Phase 5", () => {

  // ── 1. Single token ─────────────────────────────────────────────────
  test("single token response arrives correctly", async (t) => {
    const srv = startFixture(); t.after(() => srv.kill());
    const port = await readPort(srv);
    const ws   = await connectWS(port); t.after(() => ws.close());
    await waitForType(ws, "session_created");

    ws.send(JSON.stringify({ type: "set_stream", text: "hello" }));
    ws.send(JSON.stringify({ type: "chat", content: "ping" }));

    const msgs = await collectFor(ws, 300);
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
    const ws   = await connectWS(port); t.after(() => ws.close());
    await waitForType(ws, "session_created");

    ws.send(JSON.stringify({ type: "set_stream", text: "hello world from aperio" }));
    ws.send(JSON.stringify({ type: "chat", content: "test" }));

    const msgs = await collectFor(ws, 300);
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
    const results = await Promise.all(responses.map(async (resp, i) => {
      const ws = await connectWS(port);
      await waitForType(ws, "session_created");
      ws.send(JSON.stringify({ type: "set_stream", text: resp }));
      ws.send(JSON.stringify({ type: "chat", content: "concurrent" }));
      const msgs = await collectFor(ws, 300);
      ws.close();
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
    const ws   = await connectWS(port); t.after(() => ws.close());
    await waitForType(ws, "session_created");

    ws.send(JSON.stringify({ type: "set_error", message: "custom error" }));
    ws.send(JSON.stringify({ type: "chat", content: "trigger" }));

    const msgs = await collectFor(ws, 300);
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
    const ws   = await connectWS(port); t.after(() => ws.close());
    await waitForType(ws, "session_created");

    ws.send(JSON.stringify({ type: "set_provider", name: "ollama", model: "llama3.1", thinks: true, contextWindow: 8192 }));

    const msgs = await collectFor(ws, 300);
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
    const ws   = await connectWS(port); t.after(() => ws.close());

    const msgs = await collectFor(ws, 300);

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
    const ws   = await connectWS(port); t.after(() => ws.close());
    await waitForType(ws, "session_created");

    ws.send(JSON.stringify({ type: "set_stream", text: "a bc def" }));
    ws.send(JSON.stringify({ type: "chat", content: "ordered" }));

    const msgs = await collectFor(ws, 300);
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
    const ws   = await connectWS(port); t.after(() => ws.close());
    await waitForType(ws, "session_created");

    ws.send(JSON.stringify({ type: "set_stream", text: "" }));
    ws.send(JSON.stringify({ type: "chat", content: "empty" }));

    const msgs = await collectFor(ws, 300);
    const end = msgs.find((m) => m.type === "stream_end");
    assert.ok(end, "stream_end present for empty response");
    assert.equal(end.text, "", "stream_end.text is empty string");
  });
});
