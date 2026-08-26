// tests/e2e/real-app-sessions.test.js
//
// Group C: session lifecycle (plan e2e-coverage-expansion, Step WS-C).
// createSession() (lib/helpers/sessions.js) writes a var/sessions/<id>.json
// file the instant a WebSocket connects — before any chat happens — so the
// session is visible via GET /api/sessions right after the handshake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { startRealApp, request } from "../helpers/real-app-helper.js";

/** Connect to the fixture's WebSocket and wait for the handshake to complete. */
async function connect(fixture) {
  const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}`);
  const handshake = [];
  await new Promise((resolvePromise, reject) => {
    const tid = setTimeout(() => reject(new Error("WS didn't open")), 5_000);
    ws.on("open", () => { clearTimeout(tid); });
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString());
      handshake.push(parsed);
      if (parsed.type === "session_created") resolvePromise();
    });
    ws.once("close", () => reject(new Error("WS closed during handshake")));
  });
  return { ws, handshake };
}

function waitForMessage(ws, predicate, timeout = 8_000) {
  return new Promise((resolvePromise, reject) => {
    const tid = setTimeout(() => reject(new Error("Timeout waiting for message")), timeout);
    const handler = (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (predicate(parsed)) {
        clearTimeout(tid);
        ws.off("message", handler);
        resolvePromise(parsed);
      }
    };
    ws.on("message", handler);
    ws.once("close", () => { clearTimeout(tid); reject(new Error("WS closed")); });
  });
}

function closeWs(ws) {
  try { ws.close(); } catch { /* already closed */ }
}

let fixture;
let scratchRoot;

test("Session lifecycle tests", async (t) => {
  scratchRoot = mkdtempSync(join(tmpdir(), "aperio-sessions-"));
  const dbPath = join(scratchRoot, "aperio-test.db");

  fixture = await startRealApp(t, {
    readyTimeout: 25_000,
    env: {
      APERIO_E2E_SKIP_BOOT: "0",
      APERIO_E2E_INJECT_AGENT: "1",
      DB_BACKEND: "sqlite",
      SQLITE_PATH: dbPath,
      AI_PROVIDER: "stub",
      EMBEDDING_PROVIDER: "none",
      APERIO_CODEGRAPH: "off",
      APERIO_DOCGRAPH: "off",
      IDLE_SHUTDOWN: "off",
      APERIO_CONFIG_PRECEDENCE: "env",
    },
  });

  t.after(async () => {
    try { await fixture.stop(); } catch {}
    try { rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
  });

  let sharedSessionId;

  await t.test("C1: chat creates a session visible in list", async () => {
    const { ws, handshake } = await connect(fixture);
    sharedSessionId = handshake[2]?.id;
    assert.ok(sharedSessionId, "Session ID present in handshake");

    // finaliseSession() (called on WS close) discards "trivial" sessions —
    // fewer than 7 real messages (lib/helpers/sessions.js's isMeaningful(),
    // counted via messages.slice(1)). The test-agent stub only ever pushes
    // the user's turn onto `messages` (unlike a real agent, it never appends
    // its own reply — see test-agent.js's runAgentLoop), so each turn adds
    // exactly one message; 8 turns are needed to clear the >= 7 threshold
    // after slice(1) drops the first one.
    for (let i = 0; i < 8; i++) {
      const turnId = `c1-${i}-${randomUUID().slice(0, 8)}`;
      ws.send(JSON.stringify({ type: "chat", text: `substantive message number ${i}`, turnId }));
      await waitForMessage(ws, (m) => m.type === "turn_complete" && m.turnId === turnId);
    }
    closeWs(ws);
    // finaliseSession() runs synchronously in the ws "close" handler, but the
    // close event itself is delivered asynchronously — give it a beat.
    await new Promise((r) => setTimeout(r, 300));

    const listRes = await request(fixture, "/api/sessions");
    assert.equal(listRes.status, 200, "List succeeds");
    const found = listRes.json.sessions.find(s => s.id === sharedSessionId);
    assert.ok(found, `Session ${sharedSessionId} appears in the list`);
  });

  await t.test("C2: get session by ID returns conversation data", async () => {
    const getRes = await request(fixture, `/api/sessions/${sharedSessionId}`);
    assert.equal(getRes.status, 200, "Get succeeds");
    assert.ok(Array.isArray(getRes.json.messages), "messages array present");
    assert.ok(getRes.json.messages.length > 0, "At least one message stored");

    // Edge: non-existent session ID → 404
    const missingRes = await request(fixture, "/api/sessions/does-not-exist");
    assert.equal(missingRes.status, 404, "Missing session returns 404");
  });

  await t.test("C4: pin a session", async () => {
    const pinRes = await request(fixture, `/api/sessions/${sharedSessionId}/pin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(pinRes.status, 200, "Pin succeeds");
    assert.equal(pinRes.json.pinned, true, "Pin flag returned true");

    const getRes = await request(fixture, `/api/sessions/${sharedSessionId}`);
    assert.equal(getRes.json.pinned, true, "Pinned flag persisted");

    // Unpin
    const unpinRes = await request(fixture, `/api/sessions/${sharedSessionId}/pin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ pinned: false }),
    });
    assert.equal(unpinRes.status, 200, "Unpin succeeds");
    assert.equal(unpinRes.json.pinned, false, "Pin flag cleared");
  });

  await t.test("C3: delete session removes it from list", async () => {
    const deleteRes = await request(fixture, `/api/sessions/${sharedSessionId}`, {
      method: "DELETE",
      headers: { "X-Aperio-Client": "e2e" },
    });
    assert.equal(deleteRes.status, 200, "Delete succeeds");

    const listRes = await request(fixture, "/api/sessions");
    const found = listRes.json.sessions.find(s => s.id === sharedSessionId);
    assert.ok(!found, "Session no longer in the list");

    // Edge: delete already-deleted session → 404
    const againRes = await request(fixture, `/api/sessions/${sharedSessionId}`, {
      method: "DELETE",
      headers: { "X-Aperio-Client": "e2e" },
    });
    assert.equal(againRes.status, 404, "Deleting an already-deleted session returns 404");
  });
});
