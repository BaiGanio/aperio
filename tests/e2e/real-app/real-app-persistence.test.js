// tests/e2e/real-app-persistence.test.js
//
// Group E: SQLite persistence and configuration (plan Step 5)
// Tests real data flow through the production API routes and store.
//
// Uses a shared fixture started once for the entire group, to avoid
// port-contention and startup overhead from sequential process spawns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { startRealApp, request } from "../helpers/real-app-helper.js";

// ─── WS-0 helper: invoke a real MCP tool over WS chat via the test-agent's
// sentinel (see tests/e2e/helpers/test-agent.js). Opens a connection, sends
// the sentinel chat message, waits for the tool result, and closes.
async function callToolViaSentinel(fixture, toolName, args) {
  const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}`);
  await new Promise((resolvePromise, reject) => {
    const tid = setTimeout(() => reject(new Error("WS didn't open")), 5_000);
    ws.on("open", () => { clearTimeout(tid); });
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type === "session_created") resolvePromise();
    });
    ws.once("close", () => reject(new Error("WS closed during handshake")));
  });

  const text = await new Promise((resolvePromise, reject) => {
    const tid = setTimeout(() => reject(new Error("No stream_end within timeout")), 15_000);
    const handler = (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type === "stream_end") {
        clearTimeout(tid);
        ws.off("message", handler);
        resolvePromise(parsed.text ?? "");
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({
      type: "chat",
      text: `__e2e_call_tool__:${toolName}:${JSON.stringify(args)}`,
      turnId: `sentinel-${randomUUID().slice(0, 8)}`,
    }));
  });

  ws.close();
  return text;
}

// ─── Suite-level state (shared fixture) ──────────────────────────────────────
let fixture;
let dbPath;
let scratchRoot;
let suiteReady = false;

test("Persistence tests", async (t) => {
  // ── Suite setup: start one fixture for all sub-tests ─────────────────────
  scratchRoot = mkdtempSync(join(tmpdir(), "aperio-persist-"));
  dbPath = join(scratchRoot, "aperio-test.db");

  fixture = await startRealApp(t, {
    readyTimeout: 20_000,
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

  // ── Suite teardown ───────────────────────────────────────────────────────
  t.after(async () => {
    try { await fixture.stop(); } catch {}
    try { rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T24: Memory import
  // ══════════════════════════════════════════════════════════════════════════
  await t.test("T24: POST /api/memories/import creates a memory visible via GET", async () => {
    const marker = `e2e-test-${randomUUID().slice(0, 8)}`;

    const importRes = await request(fixture, "/api/memories/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({
        memories: [{
          title: marker,
          content: `E2E persistence test memory: ${marker}`,
          type: "fact",
          tags: ["e2e", "test"],
          importance: 3,
        }],
      }),
    });
    assert.equal(importRes.status, 200, "Import succeeds");
    assert.equal(importRes.json.imported, 1, "One memory imported");

    const listRes = await request(fixture, "/api/memories");
    assert.equal(listRes.status, 200, "List succeeds");
    const found = listRes.json.raw.find(m => m.title === marker);
    assert.ok(found, `Memory "${marker}" found in list`);
    assert.equal(found.type, "fact", "Type round-trips");
    assert.equal(found.importance, 3, "Importance round-trips");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T27: Settings round-trip
  // ══════════════════════════════════════════════════════════════════════════
  await t.test("T27: PUT /api/settings/:key round-trips through GET", async () => {
    const testKey = "config.LLAMACPP_MODEL";
    const testValue = `e2e-test-model-${randomUUID().slice(0, 8)}`;

    const putRes = await request(fixture, `/api/settings/${testKey}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ value: testValue }),
    });
    assert.equal(putRes.status, 200, "PUT setting succeeds");
    assert.equal(putRes.json.value, testValue, "Value returned from PUT");

    const getRes = await request(fixture, `/api/settings/${testKey}`);
    assert.equal(getRes.status, 200, "GET setting succeeds");
    assert.equal(getRes.json.key, testKey, "Key round-trips");
    assert.equal(getRes.json.value, testValue, "Value round-trips");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T30: Data export
  // ══════════════════════════════════════════════════════════════════════════
  await t.test("T30: POST /api/data/export returns self-consistent data", async () => {
    const marker = `e2e-export-${randomUUID().slice(0, 8)}`;

    await request(fixture, "/api/memories/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({
        memories: [{ title: marker, content: `Export test: ${marker}`, type: "fact" }],
      }),
    });

    const exportRes = await request(fixture, "/api/data/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({
        include_wiki: false,
        include_agent_jobs: false,
        include_self_memories: false,
      }),
    });
    assert.equal(exportRes.status, 200, "Export succeeds");
    assert.equal(exportRes.json.aperio_export, 1, "Export version marker present");
    assert.ok(Array.isArray(exportRes.json.memories), "memories is an array");
    assert.equal(exportRes.json.counts?.memories, exportRes.json.memories.length,
      "Count matches array length");
    const found = exportRes.json.memories.find(m => m.title === marker);
    assert.ok(found, `Marker "${marker}" found in export`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T31: Invalid inputs are rejected
  // ══════════════════════════════════════════════════════════════════════════
  await t.test("T31: invalid inputs are rejected", async () => {
    // Empty memories array
    const emptyRes = await request(fixture, "/api/memories/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ memories: [] }),
    });
    assert.equal(emptyRes.status, 400, "Empty array is rejected");

    // Missing title
    const noTitleRes = await request(fixture, "/api/memories/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ memories: [{ content: "content but no title" }] }),
    });
    assert.equal(noTitleRes.status, 200, "Import succeeds but reports errors");
    assert.equal(noTitleRes.json.imported, 0, "Zero imported");
    assert.equal(noTitleRes.json.errors.length, 1, "One error reported");

    // Unknown setting key
    const badSetting = await request(fixture, "/api/settings/does.not.exist", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ value: "test" }),
    });
    assert.equal(badSetting.status, 400, "Unknown setting key rejected");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group F: Memory inbox flow (WS-0 → propose_memory → approve/reject)
  // Runs before T28 — that test stops and replaces the shared `fixture`
  // handle for the restart check, so anything using the original fixture
  // must run first.
  // ══════════════════════════════════════════════════════════════════════════
  await t.test("F1: propose_memory via WS-0 appears in pending count", async () => {
    const marker = `e2e-pending-${randomUUID().slice(0, 8)}`;
    const resultText = await callToolViaSentinel(fixture, "propose_memory", {
      title: marker,
      content: "test pending memory content",
      type: "fact",
    });
    assert.ok(!resultText.startsWith("❌"), `Tool call succeeded: ${resultText}`);
    assert.match(resultText, /Memory proposed for review/, "Confirms proposal");

    const countRes = await request(fixture, "/api/memories/pending/count");
    assert.equal(countRes.status, 200, "Pending count succeeds");
    assert.ok(countRes.json.count >= 1, "At least one pending memory");

    const listRes = await request(fixture, "/api/memories/pending");
    assert.equal(listRes.status, 200, "Pending list succeeds");
    const found = listRes.json.pending.find(p => p.title === marker);
    assert.ok(found, "Proposed memory appears in pending list");
  });

  await t.test("F2: pending memory does not appear in regular list", async () => {
    const marker = `e2e-pending-notlisted-${randomUUID().slice(0, 8)}`;
    await callToolViaSentinel(fixture, "propose_memory", {
      title: marker,
      content: "should stay pending",
      type: "fact",
    });

    const listRes = await request(fixture, "/api/memories");
    assert.equal(listRes.status, 200, "Regular list succeeds");
    const found = listRes.json.raw.find(m => m.title === marker);
    assert.ok(!found, "Pending memory is absent from the regular list");
  });

  await t.test("F3: approve pending memory promotes it", async () => {
    const marker = `e2e-approve-${randomUUID().slice(0, 8)}`;
    await callToolViaSentinel(fixture, "propose_memory", {
      title: marker,
      content: "to be approved",
      type: "fact",
    });

    const pendingRes = await request(fixture, "/api/memories/pending");
    const pendingRow = pendingRes.json.pending.find(p => p.title === marker);
    assert.ok(pendingRow, "Pending row exists before approval");

    const countBefore = (await request(fixture, "/api/memories/pending/count")).json.count;

    const approveRes = await request(fixture, `/api/memories/pending/${pendingRow.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
    });
    assert.equal(approveRes.status, 200, "Approve succeeds");

    const countAfter = (await request(fixture, "/api/memories/pending/count")).json.count;
    assert.ok(countAfter < countBefore, "Pending count dropped");

    const listRes = await request(fixture, "/api/memories");
    const found = listRes.json.raw.find(m => m.title === marker);
    assert.ok(found, "Approved memory now appears in the regular list");

    // Edge: approve non-existent ID → 404
    const badApprove = await request(fixture, "/api/memories/pending/does-not-exist/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
    });
    assert.equal(badApprove.status, 404, "Approving unknown ID returns 404");
  });

  await t.test("F4: reject pending memory removes it from pending", async () => {
    const marker = `e2e-reject-${randomUUID().slice(0, 8)}`;
    await callToolViaSentinel(fixture, "propose_memory", {
      title: marker,
      content: "to be rejected",
      type: "fact",
    });

    const pendingRes = await request(fixture, "/api/memories/pending");
    const pendingRow = pendingRes.json.pending.find(p => p.title === marker);
    assert.ok(pendingRow, "Pending row exists before rejection");

    const rejectRes = await request(fixture, `/api/memories/pending/${pendingRow.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
    });
    assert.equal(rejectRes.status, 200, "Reject succeeds");

    const listRes = await request(fixture, "/api/memories/pending");
    const stillPending = listRes.json.pending.find(p => p.id === pendingRow.id);
    assert.ok(!stillPending, "Rejected row no longer pending");

    const regularRes = await request(fixture, "/api/memories");
    const inRegular = regularRes.json.raw.find(m => m.title === marker);
    assert.ok(!inRegular, "Rejected memory does not appear in the regular list");

    // Edge: reject already-rejected ID → 404
    const badReject = await request(fixture, `/api/memories/pending/${pendingRow.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
    });
    assert.equal(badReject.status, 404, "Rejecting an already-decided row returns 404");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // T28: Restart survival
  // ══════════════════════════════════════════════════════════════════════════
  await t.test("T28: data survives a full process restart", async () => {
    const marker = `e2e-survive-${randomUUID().slice(0, 8)}`;
    const settingValue = `e2e-survived-${randomUUID().slice(0, 8)}`;

    // Save data in the shared fixture
    await request(fixture, "/api/memories/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({
        memories: [{ title: marker, content: `Survival test: ${marker}`, type: "fact" }],
      }),
    });

    await request(fixture, "/api/settings/config.LLAMACPP_MODEL", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ value: settingValue }),
    });

    // Stop the shared fixture
    await fixture.stop();

    // Start a new fixture with the same SQLite file (isolated from shared fixture)
    const restartFixture = await startRealApp(t, {
      readyTimeout: 20_000,
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
    t.after(async () => { try { await restartFixture.stop(); } catch {} });

    // Verify memory survived
    const listRes = await request(restartFixture, "/api/memories");
    assert.equal(listRes.status, 200, "List succeeds after restart");
    const found = listRes.json.raw.find(m => m.title === marker);
    assert.ok(found, `Memory "${marker}" survived restart`);

    // Verify setting survived
    const getRes = await request(restartFixture, "/api/settings/config.LLAMACPP_MODEL");
    assert.equal(getRes.status, 200, "Setting readable after restart");
    assert.equal(getRes.json.value, settingValue, "Setting value survived restart");

    // New data works after restart
    const marker2 = `e2e-after-restart-${randomUUID().slice(0, 8)}`;
    await request(restartFixture, "/api/memories/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({
        memories: [{ title: marker2, content: `After restart: ${marker2}`, type: "decision" }],
      }),
    });
    const listRes2 = await request(restartFixture, "/api/memories");
    const found2 = listRes2.json.raw.find(m => m.title === marker2);
    assert.ok(found2, "New memory after restart works");
  });
});
