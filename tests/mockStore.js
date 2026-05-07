// tests/mockStore.js
// Shared mock store factory used across tool and store tests.
// Implements the same interface as PostgresStore / LanceDBStore.
//
// Usage:
//   const store = makeMockStore({ counts: { total: 5, embedded: 3 } });
//   const store = makeMockStore({ withoutEmbeddings: [{ id: "1", title: "T", content: "C" }] });

/**
 * Creates a lightweight in-memory store mock.
 *
 * @param {object}   options
 * @param {object}   options.counts               - Value returned by counts(). Shape: { total, embedded }.
 * @param {object[]} options.withoutEmbeddings    - Rows returned by listWithoutEmbeddings().
 * @param {Function} options.setEmbeddingFn       - Optional async side-effect called inside setEmbedding().
 *
 * @returns {object} Mock store with _setEmbeddingCalls tracking array.
 */
export function makeMockStore({
  counts = { total: 0, embedded: 0 },
  withoutEmbeddings = [],
  setEmbeddingFn = null,
} = {}) {
  const setEmbeddingCalls = [];

  return {
    counts() {
      return counts;
    },

    listWithoutEmbeddings() {
      return withoutEmbeddings;
    },

    async setEmbedding(id, embedding) {
      setEmbeddingCalls.push({ id, embedding });
      if (setEmbeddingFn) await setEmbeddingFn(id, embedding);
    },

    // ── Full store interface (memory tool handlers) ──────────────────────────
    // Each method throws unless overridden via the overrides spread below.
    // Seed only the methods your test actually exercises.

    insert(_input, _embedding)      { throw new Error("store.insert not seeded"); },
    recall(_opts)                   { throw new Error("store.recall not seeded"); },
    getById(_id)                    { throw new Error("store.getById not seeded"); },
    update(_id, _input, _embedding) { throw new Error("store.update not seeded"); },
    delete(_id)                     { throw new Error("store.delete not seeded"); },
    findDuplicates(_threshold)      { throw new Error("store.findDuplicates not seeded"); },
    mergeDuplicate(_idA, _idB)      { throw new Error("store.mergeDuplicate not seeded"); },

    /** Spy array — inspect after the test to assert on setEmbedding calls. */
    _setEmbeddingCalls: setEmbeddingCalls,
  };
}

/**
 * Convenience: create a store with method overrides for tool-handler tests.
 * Each key in `overrides` replaces the corresponding stub on the store.
 *
 * @param {object} overrides - Partial store implementation for the test.
 * @param {object} baseOpts  - Forwarded to makeMockStore().
 * @returns {object}
 */
export function makeMockStoreWith(overrides = {}, baseOpts = {}) {
  return { ...makeMockStore(baseOpts), ...overrides };
}