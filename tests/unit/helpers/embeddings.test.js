// tests/embeddings.test.js
// Tests for generateEmbedding and initEmbeddings.
// Imports directly from embeddings.js — no inline copies.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateEmbedding, initEmbeddings, checkEmbeddingProvider, getEmbeddingSignature, validateVoyageDims, _setTransformersPipeline } from "../../../lib/helpers/embeddings.js";
import { getEmbeddingBacklogSize } from "../../../lib/helpers/embedding-backlog.js";

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

  test("honors VOYAGE_MODEL override in the actual API call (Gap 3)", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "test-key", VOYAGE_MODEL: "voyage-3-large" }, () => {
      let capturedBody;
      return withMockFetch(async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ data: [{ embedding: [0.5] }] }) };
      }, async () => {
        await generateEmbedding("test text");
        assert.equal(capturedBody.model, "voyage-3-large");
      });
    })
  );

  test("requests output_dimension when EMBEDDING_DIMS deviates from the 1024 default (Gap 4 P1)", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "test-key", VOYAGE_MODEL: "voyage-3-large", EMBEDDING_DIMS: "512" }, () => {
      let capturedBody;
      return withMockFetch(async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ data: [{ embedding: new Array(512).fill(0.1) }] }) };
      }, async () => {
        await generateEmbedding("test text");
        assert.equal(capturedBody.output_dimension, 512);
      });
    })
  );

  test("omits output_dimension at the 1024 default — plain voyage-3 keeps its original request shape", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "test-key", VOYAGE_MODEL: undefined, EMBEDDING_DIMS: undefined }, () => {
      let capturedBody;
      return withMockFetch(async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ data: [{ embedding: [0.5] }] }) };
      }, async () => {
        await generateEmbedding("test text");
        assert.equal("output_dimension" in capturedBody, false);
      });
    })
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

  test("exposes pending memory and wiki work while startup backfill is active", async () => {
    const baseline = getEmbeddingBacklogSize();
    let finishEmbedding;
    const embeddingGate = new Promise(resolve => { finishEmbedding = resolve; });
    const store = {
      counts: async () => ({ total: 1, embedded: 0 }),
      listWithoutEmbeddings: async () => [{ id: 1, title: "T", content: "C" }],
      setEmbedding: async () => {},
    };
    await initEmbeddings(store, async () => embeddingGate);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getEmbeddingBacklogSize(), baseline + 1);

    finishEmbedding([0.1]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getEmbeddingBacklogSize(), baseline);
  });

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

  test("backfills SQLite wiki body content instead of undefined", async () => {
    const wikiSetCalls = [];
    const store = {
      counts: async () => ({ total: 0, embedded: 0 }),
      listWithoutEmbeddings: async () => [],
      wiki: {
        listWithoutEmbeddings: async () => [{ id: "wiki-1", title: "Architecture", body_md: "The memory layer indexes decisions." }],
        setEmbedding: async (id, embedding) => { wikiSetCalls.push({ id, embedding }); },
      },
    };
    const embedded = [];

    await initEmbeddings(store, async (text) => {
      embedded.push(text);
      return [0.3, 0.4];
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(embedded, ["Architecture. The memory layer indexes decisions."]);
    assert.deepEqual(wikiSetCalls, [{ id: "wiki-1", embedding: [0.3, 0.4] }]);
  });

  test("backfills self-memories too, routed through setSelfEmbedding not setEmbedding (Gap 1 P1)", async () => {
    const selfSetCalls = [];
    const memSetCalls = [];
    const store = {
      counts:                     async () => ({ total: 0, embedded: 0 }),
      listWithoutEmbeddings:      async () => [],
      listSelfWithoutEmbeddings:  async () => [{ id: "s1", title: "Self fact", content: "about the agent" }],
      setEmbedding:               async (id) => { memSetCalls.push(id); },
      setSelfEmbedding:           async (id, embedding) => { selfSetCalls.push({ id, embedding }); },
    };

    await initEmbeddings(store, async () => [0.9, 0.9]);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(selfSetCalls, [{ id: "s1", embedding: [0.9, 0.9] }]);
    assert.equal(memSetCalls.length, 0, "self-memory rows must not go through the memories setEmbedding path");
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

// =============================================================================
function makeFingerprintStore(storedFingerprint, { physicalDims = null } = {}) {
  let fingerprint = storedFingerprint;
  let dims = physicalDims;
  let clearAllEmbeddingsCalled = false;
  let resizeVectorStorageCalledWith = null;
  return {
    getSetting: async (key) => (key === "embedding_provider" ? fingerprint : null),
    setSetting: async (key, value) => { if (key === "embedding_provider") fingerprint = value; },
    clearAllEmbeddings: async () => { clearAllEmbeddingsCalled = true; },
    resizeVectorStorage: async (newDims) => { resizeVectorStorageCalledWith = newDims; dims = newDims; },
    // Only present when the test opts in — mirrors real stores exposing
    // getVectorDims but keeps the no-physical-check code path exercised too.
    ...(physicalDims !== null ? { getVectorDims: async () => dims } : {}),
    get calls() { return { clearAllEmbeddingsCalled, resizeVectorStorageCalledWith }; },
    get fingerprint() { return fingerprint; },
  };
}

describe("checkEmbeddingProvider", () => {
  test("first run — sets the fingerprint without clearing anything", () =>
    withEnv({ EMBEDDING_PROVIDER: "transformers", EMBEDDING_DIMS: undefined }, async () => {
      const store = makeFingerprintStore(null);
      await checkEmbeddingProvider(store);
      assert.equal(store.calls.clearAllEmbeddingsCalled, false);
      assert.equal(store.calls.resizeVectorStorageCalledWith, null);
      assert.equal(store.fingerprint.provider, "transformers");
    })
  );

  test("provider change with same dims — clears embeddings, does not resize (Gap 3 regression guard)", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "k", VOYAGE_MODEL: "voyage-3-large", EMBEDDING_DIMS: "1024" }, async () => {
      const store = makeFingerprintStore({ provider: "transformers", model: "mixedbread-ai/mxbai-embed-large-v1", dims: 1024 });
      await checkEmbeddingProvider(store);
      assert.equal(store.calls.clearAllEmbeddingsCalled, true);
      assert.equal(store.calls.resizeVectorStorageCalledWith, null);
      assert.equal(store.fingerprint.model, "voyage-3-large");
    })
  );

  test("dims change — resizes vector storage instead of a plain clear (Gap 4)", () =>
    // voyage (unlike transformers) actually honors EMBEDDING_DIMS via
    // output_dimension, so it's the right provider to exercise a real dims
    // change against — see the transformers-specific tests below for why
    // transformers itself must never take this path. Uses voyage-3-large
    // (Matryoshka-capable) with a dims value it actually supports — voyage-3
    // itself rejects output_dimension entirely (see validateVoyageDims tests).
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "k", VOYAGE_MODEL: "voyage-3-large", EMBEDDING_DIMS: "512" }, async () => {
      const store = makeFingerprintStore({ provider: "voyage", model: "voyage-3-large", dims: 1024 });
      await checkEmbeddingProvider(store);
      assert.equal(store.calls.resizeVectorStorageCalledWith, 512);
      assert.equal(store.calls.clearAllEmbeddingsCalled, false);
      assert.equal(store.fingerprint.dims, 512);
    })
  );

  test("no change — neither clear nor resize runs", () =>
    withEnv({ EMBEDDING_PROVIDER: "transformers", EMBEDDING_DIMS: "1024" }, async () => {
      const store = makeFingerprintStore({ provider: "transformers", model: "mixedbread-ai/mxbai-embed-large-v1", dims: 1024 });
      await checkEmbeddingProvider(store);
      assert.equal(store.calls.clearAllEmbeddingsCalled, false);
      assert.equal(store.calls.resizeVectorStorageCalledWith, null);
    })
  );

  test("fresh DB with a non-default EMBEDDING_DIMS — resizes on first boot even though there's no stored fingerprint (Gap 4 P2)", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "k", VOYAGE_MODEL: "voyage-3-large", EMBEDDING_DIMS: "512" }, async () => {
      // stored fingerprint is null (never booted before); physical storage is
      // hardcoded 1024 by migrations regardless of EMBEDDING_DIMS.
      const store = makeFingerprintStore(null, { physicalDims: 1024 });
      await checkEmbeddingProvider(store);
      assert.equal(store.calls.resizeVectorStorageCalledWith, 512);
      assert.equal(store.fingerprint.dims, 512);
    })
  );

  test("stale fingerprint already matches config but storage was never actually resized — resizes anyway (Gap 4 P2)", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "k", VOYAGE_MODEL: "voyage-3-large", EMBEDDING_DIMS: "512" }, async () => {
      // Simulates a DB upgraded from before resizeVectorStorage existed: an
      // old checkEmbeddingProvider already recorded dims:512 in the
      // fingerprint without ever touching physical storage, which is still
      // 1024-wide. A fingerprint-only comparison would see "no change" and
      // skip repair forever.
      const store = makeFingerprintStore(
        { provider: "voyage", model: "voyage-3-large", dims: 512 },
        { physicalDims: 1024 }
      );
      await checkEmbeddingProvider(store);
      assert.equal(store.calls.resizeVectorStorageCalledWith, 512);
    })
  );

  test("physical dims already match — no-op even on repeat boots (steady state)", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "k", VOYAGE_MODEL: "voyage-3-large", EMBEDDING_DIMS: "512" }, async () => {
      const store = makeFingerprintStore(
        { provider: "voyage", model: "voyage-3-large", dims: 512 },
        { physicalDims: 512 }
      );
      await checkEmbeddingProvider(store);
      assert.equal(store.calls.clearAllEmbeddingsCalled, false);
      assert.equal(store.calls.resizeVectorStorageCalledWith, null);
    })
  );

  test("transformers ignores a misconfigured EMBEDDING_DIMS — signature always reports the pipeline's real 1024 output (Gap 4 P1)", () =>
    withEnv({ EMBEDDING_PROVIDER: "transformers", EMBEDDING_DIMS: "512" }, async () => {
      // A misconfigured EMBEDDING_DIMS must never reach resizeVectorStorage
      // for transformers — mxbai-embed-large-v1 has no truncation support,
      // so resizing storage to 512 would make every subsequent insert of a
      // real (1024-length) vector fail forever.
      const store = makeFingerprintStore({ provider: "transformers", model: "mixedbread-ai/mxbai-embed-large-v1", dims: 1024 });
      await checkEmbeddingProvider(store);
      assert.equal(store.calls.resizeVectorStorageCalledWith, null);
      assert.equal(store.calls.clearAllEmbeddingsCalled, false);
      assert.equal(store.fingerprint.dims, 1024);
    })
  );

  test("getEmbeddingSignature always reports transformers at 1024 dims regardless of EMBEDDING_DIMS", () =>
    withEnv({ EMBEDDING_PROVIDER: "transformers", EMBEDDING_DIMS: "256" }, () => {
      const sig = getEmbeddingSignature();
      assert.equal(sig.dims, 1024);
      return Promise.resolve();
    })
  );
});

// ─── validateVoyageDims (review finding P1: validate before resizing/requesting) ──
describe("validateVoyageDims", () => {
  test("accepts a Matryoshka-capable model at one of its documented dims", () => {
    for (const dims of [256, 512, 1024, 2048]) {
      assert.doesNotThrow(() => validateVoyageDims("voyage-3-large", dims));
    }
  });

  test("rejects a Matryoshka-capable model at an undocumented dims value", () => {
    assert.throws(() => validateVoyageDims("voyage-3-large", 768), /not supported/);
  });

  test("accepts a fixed-width model only at its own native dims", () => {
    assert.doesNotThrow(() => validateVoyageDims("voyage-3", 1024));
    // voyage-large-2's native width is 1536, not the 1024 every other
    // fixed-width model happens to share — the review's P2 finding.
    assert.doesNotThrow(() => validateVoyageDims("voyage-large-2", 1536));
    assert.doesNotThrow(() => validateVoyageDims("voyage-code-2", 1536));
  });

  test("rejects a fixed-width model at any dims other than its own native width", () => {
    assert.throws(() => validateVoyageDims("voyage-3", 768), /fixed-width at 1024/);
    assert.throws(() => validateVoyageDims("voyage-3", 512), /fixed-width at 1024/);
    // 1024 looks like the "default", but it's wrong for this specific model.
    assert.throws(() => validateVoyageDims("voyage-large-2", 1024), /fixed-width at 1536/);
  });

  test("does not throw for a model absent from both known-model tables — VOYAGE_MODEL is a free-form override", () => {
    assert.doesNotThrow(() => validateVoyageDims("some-future-voyage-model", 999));
  });

  test("checkEmbeddingProvider rejects an invalid voyage config before doing anything destructive", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "k", VOYAGE_MODEL: "voyage-3", EMBEDDING_DIMS: "768" }, async () => {
      const store = makeFingerprintStore({ provider: "transformers", model: "mixedbread-ai/mxbai-embed-large-v1", dims: 1024 });
      await assert.rejects(() => checkEmbeddingProvider(store), /fixed-width at 1024/);
      assert.equal(store.calls.resizeVectorStorageCalledWith, null, "must not resize storage on an invalid config");
      assert.equal(store.calls.clearAllEmbeddingsCalled, false, "must not clear embeddings on an invalid config");
    })
  );

  test("getEmbeddingSignature defaults dims to a known fixed-width model's own native width, not a shared 1024", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_MODEL: "voyage-large-2", EMBEDDING_DIMS: undefined }, () => {
      const sig = getEmbeddingSignature();
      assert.equal(sig.dims, 1536);
      return Promise.resolve();
    })
  );

  test("generateEmbedding never sends output_dimension for a fixed-width model, even when its native dims differ from 1024", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "test-key", VOYAGE_MODEL: "voyage-large-2", EMBEDDING_DIMS: undefined }, () => {
      let capturedBody;
      return withMockFetch(async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ data: [{ embedding: new Array(1536).fill(0.1) }] }) };
      }, async () => {
        await generateEmbedding("test text");
        assert.equal("output_dimension" in capturedBody, false, "voyage-large-2 doesn't accept output_dimension even though its dims (1536) != 1024");
      });
    })
  );

  test("generateEmbedding still sends output_dimension for an unrecognized (future/custom) Matryoshka model — review P2 regression", () =>
    // validateVoyageDims trusts a model absent from both known-model tables
    // (free-form VOYAGE_MODEL override) and lets a non-1024 EMBEDDING_DIMS
    // through unvalidated. The API call must honor that same trust — if it
    // silently drops output_dimension for an unknown model, storage gets
    // resized to the configured width while Voyage keeps returning its
    // default-width vector, and every subsequent insert fails.
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "test-key", VOYAGE_MODEL: "voyage-4-hypothetical", EMBEDDING_DIMS: "512" }, () => {
      let capturedBody;
      return withMockFetch(async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ data: [{ embedding: new Array(512).fill(0.1) }] }) };
      }, async () => {
        await generateEmbedding("test text");
        assert.equal(capturedBody.output_dimension, 512, "an unrecognized model with a non-default EMBEDDING_DIMS must still request that width");
      });
    })
  );

  test("generateEmbedding rejects an invalid voyage config before issuing the request", () =>
    withEnv({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "test-key", VOYAGE_MODEL: "voyage-3", EMBEDDING_DIMS: "768" }, () => {
      let fetchCalled = false;
      return withMockFetch(async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ data: [{ embedding: [0.5] }] }) };
      }, async () => {
        const result = await generateEmbedding("test text");
        assert.equal(result, null, "generateEmbedding logs and returns null rather than throwing, matching its other error paths");
        assert.equal(fetchCalled, false, "must not send the HTTP request for an invalid dims/model pair");
      });
    })
  );
});
