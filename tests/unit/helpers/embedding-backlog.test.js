import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingBacklogTracker, getEmbeddingBacklogSize } from "../../../lib/helpers/embedding-backlog.js";

describe("embedding backlog tracker", () => {
  test("aggregates independent queues and releases their retained count", () => {
    const baseline = getEmbeddingBacklogSize();
    const code = createEmbeddingBacklogTracker();
    const documents = createEmbeddingBacklogTracker();

    code.set(12);
    documents.set(7);
    assert.equal(getEmbeddingBacklogSize(), baseline + 19);

    code.set(3);
    assert.equal(getEmbeddingBacklogSize(), baseline + 10);

    code.release();
    documents.release();
    assert.equal(getEmbeddingBacklogSize(), baseline);
  });
});
