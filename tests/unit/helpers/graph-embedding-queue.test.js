import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createGraphEmbeddingQueue } from "../../../lib/helpers/graph-embedding-queue.js";
import { getEmbeddingBacklogSize } from "../../../lib/helpers/embedding-backlog.js";

const tick = () => new Promise(resolve => setImmediate(resolve));

describe("graph embedding queue", () => {
  test("coalesces overlapping flushes into one serial drain", async () => {
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    let active = 0;
    let maxActive = 0;
    let generated = 0;
    const stored = [];
    const queue = createGraphEmbeddingQueue({
      store: {},
      intervalMs: 60_000,
      label: "testgraph",
      itemLabel: "item",
      generateEmbedding: async () => {
        generated++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (generated === 1) await firstGate;
        active--;
        return [generated];
      },
      setEmbedding: async (_store, id) => stored.push(id),
    });
    queue.enqueue(1, "one");
    queue.enqueue(2, "two");

    const firstFlush = queue.flush();
    const overlappingFlush = queue.flush();
    await tick();
    assert.equal(generated, 1);

    releaseFirst();
    await Promise.all([firstFlush, overlappingFlush]);
    assert.equal(maxActive, 1);
    assert.equal(generated, 2);
    assert.deepEqual(stored, [1, 2]);
    queue.shutdown();
  });

  test("stops an active drain without writing or starting the next item", async () => {
    const baseline = getEmbeddingBacklogSize();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let generated = 0;
    let stored = 0;
    const queue = createGraphEmbeddingQueue({
      store: {},
      intervalMs: 60_000,
      label: "testgraph",
      itemLabel: "item",
      generateEmbedding: async () => { generated++; await gate; return [0.1]; },
      setEmbedding: async () => { stored++; },
    });
    queue.enqueue(1, "one");
    queue.enqueue(2, "two");
    assert.equal(getEmbeddingBacklogSize(), baseline + 2);

    const flushing = queue.flush();
    await tick();
    queue.shutdown();
    release();
    await flushing;

    assert.equal(generated, 1);
    assert.equal(stored, 0);
    assert.equal(getEmbeddingBacklogSize(), baseline);
  });
});
