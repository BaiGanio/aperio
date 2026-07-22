// tests/e2e/real-app-interrupts.test.js
//
// Group G: file-write interrupt confirm/reject (plan e2e-coverage-expansion,
// Step WS-G). interruptService.create() is only ever invoked from
// mcp/tools/files/write.js's writeFileHandler — there's no other trigger path
// — so this group depends on WS-0's scripted MCP tool-call capability in
// tests/e2e/helpers/test-agent.js to produce a real interrupt row.
//
// needsWriteConfirm() only stashes a write when the turn is __tainted AND
// APERIO_BENCHMARK_RUN !== "1" — the shared fixture default (see
// real-app-helper.js) sets APERIO_BENCHMARK_RUN=1 so headless runs never
// deadlock, so this suite explicitly overrides it back to "0".

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { startRealApp, request } from "../helpers/real-app-helper.js";

// ─── WS-0 helper (mirrors real-app-persistence.test.js) ──────────────────────
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

let fixture;
let scratchRoot;

test("Interrupt tests", async (t) => {
  scratchRoot = mkdtempSync(join(tmpdir(), "aperio-interrupts-"));
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
      // Confirmation is skipped entirely under benchmark mode (headless runs
      // have no user to answer) — this suite needs the real confirm path.
      APERIO_BENCHMARK_RUN: "0",
    },
  });

  t.after(async () => {
    try { await fixture.stop(); } catch {}
    try { rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
  });

  // process.cwd() of the fixture child (== its runtimeRoot) is always inside
  // the hard write floor (lib/routes/paths.js), so no extra allowlist config
  // is needed — target a file directly under it.
  function targetPath(name) {
    return join(fixture.runtimeRoot, name);
  }

  await t.test("G1: file write triggers an interrupt", async () => {
    const path = targetPath(`e2e-write-${randomUUID().slice(0, 8)}.txt`);
    const resultText = await callToolViaSentinel(fixture, "write_file", {
      path,
      content: "hello from e2e",
      __tainted: true,
    });
    assert.match(resultText, /pending your confirmation/, `Write is stashed: ${resultText}`);
    assert.ok(!existsSync(path), "File not written yet");

    const listRes = await request(fixture, "/api/interrupts?status=pending");
    assert.equal(listRes.status, 200, "Interrupts list succeeds");
    const found = listRes.json.interrupts.find(i => i.arguments?.path === path);
    assert.ok(found, "Interrupt appears in the pending list");
    assert.equal(found.tool, "write_file", "Tool field is write_file");
    assert.equal(found.status, "pending", "Status is pending");
  });

  await t.test("G2: approve interrupt completes the write", async () => {
    const path = targetPath(`e2e-approve-${randomUUID().slice(0, 8)}.txt`);
    await callToolViaSentinel(fixture, "write_file", {
      path,
      content: "approved content",
      __tainted: true,
    });

    const listRes = await request(fixture, "/api/interrupts?status=pending");
    const interrupt = listRes.json.interrupts.find(i => i.arguments?.path === path);
    assert.ok(interrupt, "Interrupt exists before decision");

    const decisionRes = await request(fixture, `/api/interrupts/${interrupt.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(decisionRes.status, 200, "Decision succeeds");

    assert.ok(existsSync(path), "File now exists on disk");
    assert.equal(readFileSync(path, "utf8"), "approved content", "Content matches");

    // Edge: approve an unknown ID → 404
    const badDecision = await request(fixture, "/api/interrupts/does-not-exist/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(badDecision.status, 404, "Unknown interrupt ID returns 404");
  });

  await t.test("G3: reject interrupt discards the write", async () => {
    const path = targetPath(`e2e-reject-${randomUUID().slice(0, 8)}.txt`);
    await callToolViaSentinel(fixture, "write_file", {
      path,
      content: "should never land",
      __tainted: true,
    });

    const listRes = await request(fixture, "/api/interrupts?status=pending");
    const interrupt = listRes.json.interrupts.find(i => i.arguments?.path === path);
    assert.ok(interrupt, "Interrupt exists before decision");

    const decisionRes = await request(fixture, `/api/interrupts/${interrupt.id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ decision: "reject" }),
    });
    assert.equal(decisionRes.status, 200, "Decision succeeds");
    assert.ok(!existsSync(path), "File was never written");

    // Edge: reject an unknown ID → 404
    const badDecision = await request(fixture, "/api/interrupts/does-not-exist/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ decision: "reject" }),
    });
    assert.equal(badDecision.status, 404, "Unknown interrupt ID returns 404");
  });

  // G4 (expired interrupt): WRITE_TOKEN_TTL_MS is a hard-coded 2-minute
  // constant in mcp/tools/files/interrupt.js with no test override — waiting
  // it out would make this suite 2+ minutes slower for one assertion.
  // Diagnostic skip per the plan's own fallback ("if TTL is not configurable
  // for tests, skip this with a diagnostic").
  await t.test("G4: expired interrupt cannot be approved (skipped — no TTL override)", (t) => {
    t.skip("WRITE_TOKEN_TTL_MS is a fixed 2-minute constant; no test hook to shorten it");
  });
});
