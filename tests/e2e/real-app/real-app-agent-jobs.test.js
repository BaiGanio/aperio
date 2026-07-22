// tests/e2e/real-app-agent-jobs.test.js
//
// Group B: agent job lifecycle (plan e2e-coverage-expansion, Step WS-B).
// Job definition CRUD is always available; only *running* a job is gated by
// APERIO_AGENT_JOBS=on. A "steps" job calls agent.callTool() directly — the
// injected test-agent stub has no callTool method at all (it's a chat-only
// stub), so running any job under this fixture always records an "error"
// verdict rather than "ok". That's still a real, deterministic outcome: the
// run gets persisted to agent_runs either way, which is what this group
// verifies (run history exists with a verdict), not that the job's business
// logic succeeded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRealApp, request } from "../helpers/real-app-helper.js";

test("Agent job lifecycle tests", async (t) => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "aperio-agent-jobs-"));
  const dbPath = join(scratchRoot, "aperio-test.db");

  const fixture = await startRealApp(t, {
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
      APERIO_AGENT_JOBS: "on",
    },
  });

  t.after(async () => {
    try { await fixture.stop(); } catch {}
    try { rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
  });

  const jobId = `e2e-job-${randomUUID().slice(0, 8)}`;

  await t.test("B1: create an agent job", async () => {
    const createRes = await request(fixture, "/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({
        id: jobId,
        steps: [{ tool: "recall", input: { limit: 1 } }],
        trigger: { kind: "manual" },
      }),
    });
    assert.equal(createRes.status, 201, "Create succeeds");
    assert.equal(createRes.json.id, jobId, "Returned job has the requested ID");

    // Edge: a job with neither steps nor prompt is rejected
    const invalidRes = await request(fixture, "/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ id: `${jobId}-empty` }),
    });
    assert.equal(invalidRes.status, 400, "Job with no work is rejected");
  });

  await t.test("B2: run the job and verify history", async () => {
    const runRes = await request(fixture, `/api/agents/${jobId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: "{}",
    });
    // The stub agent has no callTool — a "steps" job errors deterministically,
    // recorded as verdict "error" (see file header). Either verdict is a
    // legitimate outcome; what matters is that a run was recorded at all.
    assert.ok([200, 500].includes(runRes.status), `Run responds with a job result: ${runRes.status}`);
    assert.ok(["ok", "error"].includes(runRes.json.verdict), "Response reports a verdict");

    const runsRes = await request(fixture, `/api/agents/${jobId}/runs`);
    assert.equal(runsRes.status, 200, "Run history succeeds");
    assert.ok(runsRes.json.runs.length >= 1, "At least one run recorded");
    assert.ok(["ok", "error"].includes(runsRes.json.runs[0].verdict), "Recorded run has a verdict");

    // Edge: running a non-existent job → 404
    const missingRes = await request(fixture, "/api/agents/does-not-exist/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: "{}",
    });
    assert.equal(missingRes.status, 404, "Running an unknown job returns 404");
  });

  await t.test("B4: feature-gate-off returns error", async () => {
    // Flip the master switch off at runtime via the dedicated endpoint rather
    // than a second fixture — the gate check reads process.env at request time.
    const toggleRes = await request(fixture, "/api/agents/enabled", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(toggleRes.status, 200, "Toggle succeeds");
    assert.equal(toggleRes.json.enabled, false, "Gate reports disabled");

    const runRes = await request(fixture, `/api/agents/${jobId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: "{}",
    });
    assert.equal(runRes.status, 403, "Run is refused while the gate is off");

    // Restore for B5's assertions further down
    await request(fixture, "/api/agents/enabled", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ enabled: true }),
    });

    // Edge: toggle without a boolean body → 400
    const badToggle = await request(fixture, "/api/agents/enabled", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({}),
    });
    assert.equal(badToggle.status, 400, "Toggle without a boolean enabled field is rejected");
  });

  await t.test("B5: enable/disable toggle reflected in job list", async () => {
    const listRes = await request(fixture, "/api/agents");
    assert.equal(listRes.status, 200, "List succeeds");
    assert.equal(listRes.json.enabled, true, "Gate is enabled (restored by B4)");
    assert.ok(listRes.json.jobs.some(j => j.id === jobId), "Created job appears in the list");
  });

  await t.test("B3: delete the job", async () => {
    const deleteRes = await request(fixture, `/api/agents/${jobId}`, {
      method: "DELETE",
      headers: { "X-Aperio-Client": "e2e" },
    });
    assert.equal(deleteRes.status, 200, "Delete succeeds");

    const listRes = await request(fixture, "/api/agents");
    assert.ok(!listRes.json.jobs.some(j => j.id === jobId), "Deleted job no longer listed");

    // Edge: delete already-deleted job → 404
    const againRes = await request(fixture, `/api/agents/${jobId}`, {
      method: "DELETE",
      headers: { "X-Aperio-Client": "e2e" },
    });
    assert.equal(againRes.status, 404, "Deleting an already-deleted job returns 404");
  });
});
