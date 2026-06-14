import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ollamaContextWindow } from "../../lib/providers/index.js";

// #2 — the app talks to Ollama over /v1 (which can't set num_ctx), so
// OLLAMA_NUM_CTX is only the trim-math assumption. When it exceeds Ollama's real
// serving window (OLLAMA_CONTEXT_LENGTH), capToolResults over-keeps and the
// prompt is silently truncated. ollamaContextWindow clamps to the real window.

describe("ollamaContextWindow", () => {
  test("defaults to 32768 when nothing is set", () => {
    assert.equal(ollamaContextWindow({}), 32768);
  });

  test("uses OLLAMA_NUM_CTX when no real window is known", () => {
    assert.equal(ollamaContextWindow({ OLLAMA_NUM_CTX: "98304" }), 98304);
  });

  test("clamps to OLLAMA_CONTEXT_LENGTH when the assumption is too large", () => {
    assert.equal(
      ollamaContextWindow({ OLLAMA_NUM_CTX: "98304", OLLAMA_CONTEXT_LENGTH: "32768" }),
      32768,
    );
  });

  test("keeps the smaller assumption when it already fits the real window", () => {
    assert.equal(
      ollamaContextWindow({ OLLAMA_NUM_CTX: "16384", OLLAMA_CONTEXT_LENGTH: "32768" }),
      16384,
    );
  });
});
