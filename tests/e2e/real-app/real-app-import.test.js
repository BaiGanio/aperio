// tests/e2e/real-app-import.test.js
//
// Group D: data import round-trip (plan e2e-coverage-expansion, Step WS-D).
// Export from one booted fixture, import into a second fixture with a clean
// DB, and confirm the data survives the round trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRealApp, request } from "../helpers/real-app-helper.js";

function fixtureEnv(dbPath) {
  return {
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
  };
}

test("Data import round-trip tests", async (t) => {
  const rootA = mkdtempSync(join(tmpdir(), "aperio-import-src-"));
  const rootB = mkdtempSync(join(tmpdir(), "aperio-import-dst-"));

  const source = await startRealApp(t, {
    readyTimeout: 25_000,
    env: fixtureEnv(join(rootA, "aperio-test.db")),
  });
  const dest = await startRealApp(t, {
    readyTimeout: 25_000,
    env: fixtureEnv(join(rootB, "aperio-test.db")),
  });

  t.after(async () => {
    try { await source.stop(); } catch {}
    try { await dest.stop(); } catch {}
    try { rmSync(rootA, { recursive: true, force: true }); } catch {}
    try { rmSync(rootB, { recursive: true, force: true }); } catch {}
  });

  const marker = `e2e-import-${randomUUID().slice(0, 8)}`;
  let exportPayload;

  await t.test("D1: export returns valid JSON with expected structure", async () => {
    await request(source, "/api/memories/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({
        memories: [{ title: marker, content: `Round-trip test: ${marker}`, type: "fact", tags: ["e2e"] }],
      }),
    });

    const exportRes = await request(source, "/api/data/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ include_wiki: false, include_agent_jobs: false, include_self_memories: false }),
    });
    assert.equal(exportRes.status, 200, "Export succeeds");
    assert.equal(exportRes.json.aperio_export, 1, "Export version marker present");
    assert.ok(Array.isArray(exportRes.json.memories), "memories is an array");
    assert.equal(exportRes.json.counts.memories, exportRes.json.memories.length, "Count matches array length");
    exportPayload = exportRes.json;
  });

  await t.test("D2: import into a clean DB restores memories", async () => {
    const importRes = await request(dest, "/api/data/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify(exportPayload),
    });
    assert.equal(importRes.status, 200, "Import succeeds");
    assert.ok(importRes.json.imported.memories >= 1, "At least one memory imported");
    assert.equal(importRes.json.imported.memories, exportPayload.counts.memories, "Imported count matches export count");

    // Edge: import an empty export → 200, zero imported
    const emptyRes = await request(dest, "/api/data/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ memories: [], wiki_articles: [], self_memories: [] }),
    });
    assert.equal(emptyRes.status, 200, "Empty import succeeds");
    assert.equal(emptyRes.json.imported.memories, 0, "Zero memories imported from empty payload");
  });

  await t.test("D3: imported memories are queryable", async () => {
    const listRes = await request(dest, "/api/memories");
    assert.equal(listRes.status, 200, "List succeeds");
    const found = listRes.json.raw.find(m => m.title === marker);
    assert.ok(found, `Marker "${marker}" present in the destination DB`);
    assert.equal(found.content, `Round-trip test: ${marker}`, "Content matches the original");

    // Edge: import the same export again → idempotent (INSERT OR IGNORE), no duplicates
    const beforeCount = listRes.json.raw.length;
    await request(dest, "/api/data/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify(exportPayload),
    });
    const afterRes = await request(dest, "/api/memories");
    assert.equal(afterRes.json.raw.length, beforeCount, "Re-importing the same export is idempotent");
  });

  await t.test("D4: invalid import JSON is rejected", async () => {
    const badRes = await request(dest, "/api/data/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ not_valid: true }),
    });
    assert.equal(badRes.status, 400, "Missing memories array is rejected, not a 500");

    const emptyBodyRes = await request(dest, "/api/data/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: "",
    });
    assert.equal(emptyBodyRes.status, 400, "Empty body is rejected, not a 500");
  });
});
