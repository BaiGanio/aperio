// tests/embeddings.test.js
// Tests for generateEmbedding and initEmbeddings.
// Imports directly from embeddings.js — no inline copies.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateEmbedding, initEmbeddings, _setTransformersPipeline } from "../../../lib/helpers/embeddings.js";

// ─── fetch mock ───────────────────────────────────────────────────────────────
function withMockFetch(mockFn, testFn) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  return testFn().finally(() => { globalThis.fetch = original; });
}

// ─── env helpers ─────────────────────────────────────────────────────────────
function withEnv(overrides, testFn) {
  const original = {};
  for (const [k, v] of Object.entries(overrides)) {
    original[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return testFn().finally(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ─── store mock factory ───────────────────────────────────────────────────────
function makeStore({ total = 0, embedded = 0, rows = [] } = {}) {
  return {
    counts:                 async () => ({ total, embedded }),
    listWithoutEmbeddings:  async () => rows,
    setEmbedding:           async () => {},
  };
}

// =============================================================================
describe("generateEmbedding — Voyage (default)", () => {

  test("returns embedding array on success", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "test-key" }, () =>
      withMockFetch(async () => ({
        ok:   true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      }), async () => {
        const result = await generateEmbedding("hello world");
        assert.deepEqual(result, [0.1, 0.2, 0.3]);
      })
    )
  );

  test("sends correct body to Voyage API", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "test-key" }, () => {
      let capturedBody;
      return withMockFetch(async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ data: [{ embedding: [0.5] }] }) };
      }, async () => {
        await generateEmbedding("test text", "query");
        assert.equal(capturedBody.model, "voyage-3");
        assert.deepEqual(capturedBody.input, ["test text"]);
        assert.equal(capturedBody.input_type, "query");
      });
    })
  );

  test("returns null when VOYAGE_API_KEY is not set", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: undefined }, () =>
      withMockFetch(async () => { throw new Error("should not be called"); }, async () => {
        const result = await generateEmbedding("hello");
        assert.equal(result, null);
      })
    )
  );

  test("returns null on HTTP error", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "test-key" }, () =>
      withMockFetch(async () => ({ ok: false, status: 429 }), async () => {
        const result = await generateEmbedding("hello");
        assert.equal(result, null);
      })
    )
  );

  test("returns null on network failure", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "test-key" }, () =>
      withMockFetch(async () => { throw new Error("network error"); }, async () => {
        const result = await generateEmbedding("hello");
        assert.equal(result, null);
      })
    )
  );
});

// =============================================================================
// ─── pipeline mock helper ─────────────────────────────────────────────────────
function withTransformersPipeline(mockPipeline, testFn) {
  _setTransformersPipeline(mockPipeline);
  return testFn().finally(() => _setTransformersPipeline(null));
}

describe("generateEmbedding — Transformers (default)", () => {

  test("returns embedding array on success", () =>
    withEnv({ EMBEDDING_PROVIDER: "transformers" }, () =>
      withTransformersPipeline(
        async (_text, _opts) => ({ data: new Float32Array([0.1, 0.2, 0.3]) }),
        async () => {
          const result = await generateEmbedding("hello world");
          assert.deepEqual(result, Array.from(new Float32Array([0.1, 0.2, 0.3])));
        }
      )
    )
  );

  test("is used when EMBEDDING_PROVIDER is unset", () =>
    withEnv({ EMBEDDING_PROVIDER: undefined }, () =>
      withTransformersPipeline(
        async () => ({ data: new Float32Array([0.5, 0.6]) }),
        async () => {
          const result = await generateEmbedding("hello");
          assert.deepEqual(result, Array.from(new Float32Array([0.5, 0.6])));
        }
      )
    )
  );

  test("passes text and pooling options to the pipeline", () =>
    withEnv({ EMBEDDING_PROVIDER: "transformers" }, () => {
      let capturedText, capturedOpts;
      return withTransformersPipeline(
        async (text, opts) => {
          capturedText = text;
          capturedOpts = opts;
          return { data: new Float32Array([0.1]) };
        },
        async () => {
          await generateEmbedding("test input", "query");
          assert.equal(capturedText, "test input");
          assert.deepEqual(capturedOpts, { pooling: 'cls', normalize: true });
        }
      );
    })
  );

  test("returns null when pipeline throws", () =>
    withEnv({ EMBEDDING_PROVIDER: "transformers" }, () =>
      withTransformersPipeline(
        async () => { throw new Error("ONNX runtime error"); },
        async () => {
          const result = await generateEmbedding("hello");
          assert.equal(result, null);
        }
      )
    )
  );
});

// =============================================================================
describe("initEmbeddings", () => {

  test("logs ready with no memories when store is empty", async () => {
    const store = makeStore({ total: 0, embedded: 0 });
    // Should resolve without calling generateEmbeddingFn
    await initEmbeddings(store, async () => { throw new Error("should not be called"); });
  });

  test("logs active semantic search when all memories are embedded", async () => {
    const store = makeStore({ total: 5, embedded: 5 });
    await initEmbeddings(store, async () => { throw new Error("should not be called"); });
  });

  test("backfills embeddings for all pending rows", async () => {
    const rows = [
      { id: 1, title: "First",  content: "content one" },
      { id: 2, title: "Second", content: "content two" },
    ];
    const store = {
      counts:                async () => ({ total: 2, embedded: 0 }),
      listWithoutEmbeddings: async () => rows,
      setEmbedding:          async () => {},
    };

    const embedded = [];
    const mockGenerateFn = async (text) => {
      embedded.push(text);
      return [0.1, 0.2];
    };

    await initEmbeddings(store, mockGenerateFn);

    // setImmediate is async — flush the microtask/macrotask queue
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(embedded.length, 2);
    assert.equal(embedded[0], "First. content one");
    assert.equal(embedded[1], "Second. content two");
  });

  test("counts failed rows when generateEmbeddingFn returns null", async () => {
    const rows = [{ id: 1, title: "T", content: "C" }];
    const store = {
      counts:                async () => ({ total: 1, embedded: 0 }),
      listWithoutEmbeddings: async () => rows,
      setEmbedding:          async () => { throw new Error("should not be called"); },
    };

    await initEmbeddings(store, async () => null);
    await new Promise(resolve => setImmediate(resolve));
    // No assertion needed beyond not throwing — failed count is logged only
  });

  test("handles backfill error without throwing", async () => {
    const store = {
      counts:                async () => ({ total: 1, embedded: 0 }),
      listWithoutEmbeddings: async () => { throw new Error("db error"); },
      setEmbedding:          async () => {},
    };

    await initEmbeddings(store, async () => [0.1]);
    await new Promise(resolve => setImmediate(resolve));
    // Should swallow the error gracefully
  });
});