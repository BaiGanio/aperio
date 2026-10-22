import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingWorkerClient } from "../../../lib/helpers/embedding-worker-client.js";

const fixtureUrl = new URL("../../fixtures/cpu-embedding-worker.js", import.meta.url);
const exitingFixtureUrl = new URL("../../fixtures/exiting-embedding-worker.js", import.meta.url);

describe("embedding worker client", () => {
  test("keeps the main event loop responsive during CPU-bound inference", async () => {
    const client = createEmbeddingWorkerClient({ workerUrl: fixtureUrl });
    try {
      const started = performance.now();
      const timer = new Promise((resolve) => setTimeout(() => resolve(performance.now() - started), 25));
      const embedding = client.embed("fresh install", "query");

      const timerDelay = await timer;
      assert.ok(timerDelay < 125, `main-thread timer was delayed ${timerDelay.toFixed(1)}ms`);
      assert.deepEqual(await embedding, [13, 1]);
    } finally {
      await client.dispose();
    }
  });

  test("reuses one worker for concurrent requests and resolves by request id", async () => {
    const client = createEmbeddingWorkerClient({ workerUrl: fixtureUrl });
    try {
      const [first, second] = await Promise.all([
        client.embed("one", "document"),
        client.embed("second", "query"),
      ]);
      assert.deepEqual(first, [3, 0]);
      assert.deepEqual(second, [6, 1]);
      assert.equal(client.pendingSize(), 0);
    } finally {
      await client.dispose();
    }
  });

  test("rejects new requests after disposal", async () => {
    const client = createEmbeddingWorkerClient({ workerUrl: fixtureUrl });
    await client.dispose();
    await assert.rejects(client.embed("late", "document"), /disposed/i);
  });

  test("rejects pending work when a worker exits cleanly but unexpectedly", async () => {
    const client = createEmbeddingWorkerClient({ workerUrl: exitingFixtureUrl });
    try {
      await assert.rejects(client.embed("orphaned", "document"), /exited with code 0/i);
      assert.equal(client.pendingSize(), 0);
    } finally {
      await client.dispose();
    }
  });

  test("cancels active work cooperatively during disposal", async () => {
    const client = createEmbeddingWorkerClient({ workerUrl: fixtureUrl });
    const active = client.embed("shutdown", "document");
    const rejected = assert.rejects(active, /disposed/i);
    await client.dispose();
    await rejected;
    assert.equal(client.pendingSize(), 0);
  });
});
