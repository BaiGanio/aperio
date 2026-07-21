/**
 * ragStore.test.js — Tests for the in-memory RAG store used during session
 * compression. The store indexes user+assistant message pairs via embedding
 * and retrieves the most relevant past exchanges for context injection.
 */

import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { createRagStore } from "../../lib/context/ragStore.js";

// ─── Helper: deterministic embedding mock ───────────────────────────────────
// Returns unit vectors so cosine similarity is predictable:
//   "weather" → [0, 1, 0]  (y-axis)
//   "hello"   → [1, 0, 0]  (x-axis)
//   anything  → [0.1, 0.1, 0.1] (near-origin — low similarity to both)
function mockEmbed(text, _type) {
  const lower = text.toLowerCase();
  if (lower.includes("weather")) return [0, 1, 0];
  if (lower.includes("hello") || lower.includes("hi")) return [1, 0, 0];
  return [0.1, 0.1, 0.1];
}

// ─── Test message fixtures ──────────────────────────────────────────────────

function makeMessages(overrides = {}) {
  return [
    { role: "system", content: "You are a helpful assistant." },
    {
      role: "user",
      content: overrides.userText ?? "Hello there, how are you doing today?",
    },
    {
      role: "assistant",
      content: overrides.assistantText ?? "I'm doing great, thank you for asking! How can I help you today?",
    },
  ];
}

function makeWeatherMessages() {
  return [
    { role: "system", content: "You are a weather bot." },
    { role: "user", content: "What's the weather like outside today?" },
    { role: "assistant", content: "It's sunny and warm with a gentle breeze." },
  ];
}

// =============================================================================
// Store creation
// =============================================================================

describe("createRagStore", () => {
  test("returns an object with index, retrieve, and size", () => {
    const store = createRagStore();
    assert.ok(store, "store should exist");
    assert.strictEqual(typeof store.index, "function");
    assert.strictEqual(typeof store.retrieve, "function");
    assert.ok("size" in store, "store should have a size property");
    assert.strictEqual(typeof store.size, "number");
  });

  test("initial size is 0", () => {
    const store = createRagStore();
    assert.strictEqual(store.size, 0);
  });
});

// =============================================================================
// store.index()
// =============================================================================

describe("store.index()", () => {
  test("indexes a user+assistant pair", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);

    await store.index(makeMessages(), spy);

    assert.strictEqual(store.size, 1);
    assert.strictEqual(spy.mock.calls.length, 1);
  });

  test("passes 'document' type to generateEmbedding during index", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);

    await store.index(makeMessages(), spy);

    assert.strictEqual(spy.mock.calls[0].arguments[1], "document");
  });

  test("does not index when messages array is empty", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);

    await store.index([], spy);

    assert.strictEqual(store.size, 0);
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test("does not index when there is only a single message (no pair)", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);

    await store.index([{ role: "user", content: "hello" }], spy);

    assert.strictEqual(store.size, 0);
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test("skips pairs where the first message is not a user", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const messages = [
      { role: "system", content: "You are a bot." },
      { role: "system", content: "More instructions." },
      { role: "assistant", content: "Hello, how can I help?" },
    ];

    await store.index(messages, spy);

    assert.strictEqual(store.size, 0);
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test("skips pairs where the second message is not an assistant", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const messages = [
      { role: "system", content: "You are a bot." },
      { role: "user", content: "Hello there!" },
      { role: "user", content: "Are you there?" },
    ];

    await store.index(messages, spy);

    assert.strictEqual(store.size, 0);
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test("skips pairs where combined text is shorter than 50 characters", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const messages = [
      { role: "system", content: "You are a bot." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ];

    await store.index(messages, spy);

    // "User: Hi\nAssistant: Hello" = short — combined < 50
    assert.strictEqual(store.size, 0);
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test("deduplicates identical pairs", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const msgs = makeMessages();

    await store.index(msgs, spy);
    await store.index(msgs, spy);

    // Second call should skip because text is identical
    assert.strictEqual(store.size, 1);
    assert.strictEqual(spy.mock.calls.length, 1);
  });

  test("skips pair when generateEmbedding returns null", async () => {
    const store = createRagStore();
    const nullEmbedder = mock.fn(() => null);

    await store.index(makeMessages(), nullEmbedder);

    assert.strictEqual(store.size, 0);
    assert.strictEqual(nullEmbedder.mock.calls.length, 1);
  });

  test("handles array content blocks (e.g., tool-style messages)", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const messages = [
      { role: "system", content: "You are a bot." },
      {
        role: "user",
        content: [{ type: "text", text: "Can you write code for me?" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Sure! Here's a simple Python function that calculates fibonacci numbers." }],
      },
    ];

    await store.index(messages, spy);

    assert.strictEqual(store.size, 1);
    assert.strictEqual(spy.mock.calls.length, 1);
    // Verify the text was extracted properly from content blocks
    const indexedText = spy.mock.calls[0].arguments[0];
    assert.ok(indexedText.includes("write code"), "should include user text from content blocks");
    assert.ok(indexedText.includes("fibonacci"), "should include assistant text from content blocks");
  });

  test("indexes multiple pairs in sequence", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const messages = [
      { role: "system", content: "You are a bot." },
      { role: "user", content: "Hello! How are you?" },
      { role: "assistant", content: "I'm doing great, thanks for asking! How can I help you today?" },
      { role: "user", content: "What's the weather like outside today?" },
      { role: "assistant", content: "It's sunny and warm with a gentle breeze." },
    ];

    await store.index(messages, spy);

    assert.strictEqual(store.size, 2);
    assert.strictEqual(spy.mock.calls.length, 2);
  });

  test("extractText handles array content blocks with missing text", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const messages = [
      { role: "system", content: "Bot." },
      {
        role: "user",
        content: [
          { type: "text", text: "Hello there, how are you doing today?" },
          { type: "image", source: { url: "https://example.com/img.png" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'm doing great, thank you for asking! How can I help you today?" },
          { type: "tool_result", content: "some result" },
        ],
      },
    ];

    await store.index(messages, spy);

    // Should still extract and index — non-text blocks are filtered out
    assert.strictEqual(store.size, 1);
  });

  test("extractText handles content blocks with falsy text property", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const messages = [
      { role: "system", content: "Bot." },
      {
        role: "user",
        content: [
          { type: "text", text: "Hello there, how are you doing today? This is long enough to pass the threshold." },
          { type: "text", text: "" }, // empty text — should produce ""
          { type: "text", text: null }, // null text — should produce ""
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'm doing great, thank you for asking! How can I help you today?" },
        ],
      },
    ];

    await store.index(messages, spy);

    // Should still extract and index (falsy text blocks produce empty strings)
    assert.strictEqual(store.size, 1);
  });

  test("extractText returns empty string for non-string, non-array content", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const messages = [
      { role: "system", content: "You are a bot." },
      { role: "user", content: null },
      { role: "assistant", content: "Response with nothing to pair with." },
    ];

    await store.index(messages, spy);
    assert.strictEqual(store.size, 0);
  });

  test("advances i past assistant even when extractText returns empty (short first half)", async () => {
    // If user has content but assistant extractText returns empty,
    // i still advances so we don't get stuck.
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const messages = [
      { role: "system", content: "You are a bot." },
      { role: "user", content: "This is a sufficiently long user message that should pass the length check by itself." },
      { role: "assistant", content: null },
      { role: "user", content: "Hello there, how are you doing today?" },
      { role: "assistant", content: "I'm doing great, thank you for asking! How can I help you?" },
    ];

    await store.index(messages, spy);

    // First pair (index 1,2) should be skipped (assistant has null content)
    // Second pair (index 3,4) should be indexed
    assert.strictEqual(store.size, 1);
    assert.strictEqual(spy.mock.calls.length, 1);
  });
});

// =============================================================================
// store.retrieve()
// =============================================================================

describe("store.retrieve()", () => {
  test("returns empty array when store is empty", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);

    const results = await store.retrieve("hello", spy);

    assert.deepStrictEqual(results, []);
    assert.strictEqual(spy.mock.calls.length, 0);
  });

  test("returns empty array when generateEmbedding returns null for query", async () => {
    const store = createRagStore();
    const embedder = mock.fn((text, type) => {
      // Return embedding for index, null for query
      if (type === "document") return [1, 0, 0];
      return null;
    });

    await store.index(makeMessages(), embedder);
    assert.strictEqual(store.size, 1);

    const results = await store.retrieve("hello", embedder);
    assert.deepStrictEqual(results, []);
  });

  test("passes 'query' type to generateEmbedding during retrieve", async () => {
    const store = createRagStore();
    const embedder = mock.fn((text, type) => {
      if (type === "document") return [1, 0, 0];
      return [1, 0, 0]; // same vector for query
    });

    await store.index(makeMessages(), embedder);
    embedder.mock.resetCalls(); // clear index calls

    await store.retrieve("hello", embedder);
    assert.strictEqual(embedder.mock.calls.length, 1);
    assert.strictEqual(embedder.mock.calls[0].arguments[1], "query");
  });

  test("retrieves the most relevant chunk by cosine similarity", async () => {
    const store = createRagStore();
    const embedder = mock.fn(mockEmbed);

    // Index weather messages first
    await store.index(makeWeatherMessages(), embedder);
    embedder.mock.resetCalls();

    // Retrieve with weather-related query
    const results = await store.retrieve("tell me about the weather", embedder);

    assert.strictEqual(results.length, 1);
    assert.ok(results[0].includes("weather"), "should return weather-related result");
    assert.ok(results[0].includes("User:"), "should be in User/Assistant format");
  });

  test("retrieves correct chunk when multiple chunks exist", async () => {
    const store = createRagStore();
    const embedder = mock.fn(mockEmbed);

    // Index both weather and hello using a single multi-message array
    const messages = [
      { role: "system", content: "Bot." },
      { role: "user", content: "Hello there, how are you doing today?" },
      { role: "assistant", content: "I'm doing great, thank you for asking! How can I help you?" },
      { role: "user", content: "What's the weather like outside today?" },
      { role: "assistant", content: "It's sunny and warm outside, perfect for a walk." },
    ];
    await store.index(messages, embedder);
    assert.strictEqual(store.size, 2);

    embedder.mock.resetCalls();

    // Retrieve with weather query — should get the weather chunk
    const weatherResults = await store.retrieve("weather outside", embedder);
    assert.strictEqual(weatherResults.length, 1);
    assert.ok(weatherResults[0].includes("weather"), "weather query should return weather result");

    embedder.mock.resetCalls();

    // Retrieve with hello query — should get the hello chunk
    const helloResults = await store.retrieve("hello", embedder);
    assert.strictEqual(helloResults.length, 1);
    assert.ok(helloResults[0].includes("Hello"), "hello query should return hello result");
  });

  test("respects custom topK parameter", async () => {
    const store = createRagStore();
    const embedder = mock.fn((text, _type) => {
      // Return the same vector for everything so all chunks match
      return [1, 0, 0];
    });

    // Index three different pairs
    const messages = [
      { role: "system", content: "Bot." },
      { role: "user", content: "Hello there, how are you doing today?" },
      { role: "assistant", content: "I'm doing great, thank you for asking! How can I help you?" },
      { role: "user", content: "What's the weather like outside today?" },
      { role: "assistant", content: "It's sunny and warm outside, perfect for a walk." },
      { role: "user", content: "Tell me about machine learning algorithms." },
      { role: "assistant", content: "Machine learning is a subset of artificial intelligence that enables systems to learn from data." },
    ];
    await store.index(messages, embedder);
    assert.strictEqual(store.size, 3);

    embedder.mock.resetCalls();

    // Retrieve with topK=2 — should return 2 results
    const results = await store.retrieve("anything", embedder, 2);
    assert.strictEqual(results.length, 2);
  });

  test("uses default topK=3 when not specified", async () => {
    const store = createRagStore();
    const embedder = mock.fn((text, _type) => [1, 0, 0]);

    // Index 5 pairs
    const manyMessages = [ { role: "system", content: "Bot." } ];
    for (let i = 0; i < 5; i++) {
      manyMessages.push(
        { role: "user", content: `Message pair number ${i} with enough text to pass the length check for indexing.` },
        { role: "assistant", content: `This is the assistant response for message pair ${i} with enough text.` },
      );
    }
    await store.index(manyMessages, embedder);
    assert.strictEqual(store.size, 5);

    embedder.mock.resetCalls();

    // Default topK=3
    const results = await store.retrieve("any query", embedder);
    assert.strictEqual(results.length, 3);
  });

  test("handles zero-vector embeddings (cosine early-return)", async () => {
    const store = createRagStore();
    const embedder = mock.fn((text, type) => {
      if (type === "document") return [0, 0, 0]; // zero vector → na === 0
      return [1, 0, 0];
    });

    await store.index(makeMessages(), embedder);
    assert.strictEqual(store.size, 1);

    // Query embedding is [1,0,0] but document embedding is [0,0,0]
    // cosine([1,0,0], [0,0,0]) → na=1, nb=0 → returns 0 (early return)
    const results = await store.retrieve("testing zero vector", embedder);
    assert.deepStrictEqual(results, []);
  });

  test("handles query with zero-vector embedding", async () => {
    const store = createRagStore();
    const embedder = mock.fn((text, type) => {
      if (type === "document") return [1, 0, 0];
      return [0, 0, 0]; // zero vector → nb === 0
    });

    await store.index(makeMessages(), embedder);
    assert.strictEqual(store.size, 1);

    // Document embedding is [1,0,0] but query embedding is [0,0,0]
    // cosine([0,0,0], [1,0,0]) → na=0, nb=1 → returns 0 (early return)
    const results = await store.retrieve("zero query", embedder);
    assert.deepStrictEqual(results, []);
  });

  test("filters out results below cosine similarity 0.3", async () => {
    const store = createRagStore();
    // Embedder that returns orthogonal vectors so cosine is 0
    const embedder = mock.fn((text, type) => {
      if (type === "document") return [1, 0, 0]; // x-axis
      return [0, 1, 0]; // y-axis — orthogonal = cosine 0 < 0.3
    });

    await store.index(makeMessages(), embedder);
    assert.strictEqual(store.size, 1);

    const results = await store.retrieve("something else", embedder);
    assert.deepStrictEqual(results, []);
  });

  test("sorts results by score descending", async () => {
    const store = createRagStore();
    const embedder = mock.fn((text, _type) => {
      // Return different vectors for each chunk
      if (text.includes("weather")) return [1, 0, 0];
      if (text.includes("hello")) return [0.9, 0.1, 0];
      return [0.8, 0.2, 0.1];
    });

    const messages = [
      { role: "system", content: "Bot." },
      { role: "user", content: "Hello there, how are you doing today?" },
      { role: "assistant", content: "I'm doing great, thank you for asking! How can I help you?" },
      { role: "user", content: "What's the weather like outside today?" },
      { role: "assistant", content: "It's sunny and warm outside, perfect for a walk." },
      { role: "user", content: "Tell me about machine learning algorithms." },
      { role: "assistant", content: "Machine learning is a subset of artificial intelligence that enables systems to learn from data." },
    ];
    await store.index(messages, embedder);
    assert.strictEqual(store.size, 3);

    embedder.mock.resetCalls();

    // Query vector [1, 0, 0] — most similar to weather ([1,0,0])
    const queryEmbedder = mock.fn(() => [1, 0, 0]);
    const results = await store.retrieve("weather", queryEmbedder, 3);

    // Should return 3 results sorted by score descending
    assert.strictEqual(results.length, 3);
    // First result should be the one most similar to [1,0,0]
    assert.ok(results[0].includes("weather"), "top result should be the weather chunk");
  });
});

// =============================================================================
// store.size
// =============================================================================

describe("store.size", () => {
  test("size increases when a pair is indexed", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);

    assert.strictEqual(store.size, 0);
    await store.index(makeMessages(), spy);
    assert.strictEqual(store.size, 1);
  });

  test("size does not increase when indexing fails (embedding returns null)", async () => {
    const store = createRagStore();
    const nullEmbedder = mock.fn(() => null);

    assert.strictEqual(store.size, 0);
    await store.index(makeMessages(), nullEmbedder);
    assert.strictEqual(store.size, 0);
  });

  test("size does not increase for duplicate pairs", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const msgs = makeMessages();

    await store.index(msgs, spy);
    assert.strictEqual(store.size, 1);

    await store.index(msgs, spy);
    assert.strictEqual(store.size, 1);
  });

  test("size correctly counts multiple indexed pairs", async () => {
    const store = createRagStore();
    const spy = mock.fn(mockEmbed);
    const messages = [
      { role: "system", content: "Bot." },
      { role: "user", content: "Hello there, how are you doing today?" },
      { role: "assistant", content: "I'm doing great, thank you for asking! How can I help you?" },
      { role: "user", content: "What's the weather like outside today?" },
      { role: "assistant", content: "It's sunny and warm outside, perfect for a walk." },
    ];

    await store.index(messages, spy);
    assert.strictEqual(store.size, 2);
  });
});
