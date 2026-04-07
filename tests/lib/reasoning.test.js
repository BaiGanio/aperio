import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveReasoningAdapter, REASONING_ADAPTERS } from "../../lib/reasoning.js";

describe("reasoning.js", () => {
  
  describe("Adapter Resolution", () => {
    test("matches specific models", () => {
      const adapter = resolveReasoningAdapter("DeepSeek-R1-Distill");
      assert.strictEqual(adapter.match, "deepseek-r1");
      assert.strictEqual(adapter.thinks, true);
    });

    test("falls back to noopAdapter for unknown models", () => {
      const adapter = resolveReasoningAdapter("my-custom-model-v1");
      assert.strictEqual(adapter.match, "__noop__");
      assert.strictEqual(adapter.thinks, false);
      
      // Test noop functionality
    const res = adapter.processDelta({ content: "hello" });
      assert.strictEqual(res.contentToken, "hello");
    });
    
    test("Gemma adapter: processes reasoning and content", () => {
    const adapter = resolveReasoningAdapter("gemma-2b");
    const state = adapter.createState();
    const events = [];
    const emit = (e) => events.push(e);

    adapter.processDelta({ reasoning: "Thinking" }, state, emit);
    const res = adapter.processDelta({ content: "Hi" }, state, emit);
    
    assert.strictEqual(adapter.match, "gemma");
    assert.strictEqual(res.contentToken, "Hi");
    assert.strictEqual(events[events.length-1].type, "reasoning_done");
  });

  test("DeepSeek-R1 adapter: sets noTools to true", () => {
    const adapter = resolveReasoningAdapter("deepseek-r1");
    assert.strictEqual(adapter.noTools, true);
    // Exercise its processDelta (even if logic is identical to Qwen)
    const res = adapter.processDelta({ content: "direct" }, adapter.createState(), () => {});
    assert.strictEqual(res.contentToken, "direct");
  });

  test("Llama adapter: handles content and nulls", () => {
    const adapter = resolveReasoningAdapter("llama-3");
    assert.strictEqual(adapter.thinks, false);
    const res = adapter.processDelta({ content: "hello" }, {}, () => {});
    const resEmpty = adapter.processDelta({}, {}, () => {});
    assert.strictEqual(res.contentToken, "hello");
    assert.strictEqual(resEmpty.contentToken, null);
  });

  test("No-op adapter: handles missing content", () => {
    const adapter = resolveReasoningAdapter("unknown-model");
    const res = adapter.processDelta({}, {}, () => {});
    assert.strictEqual(res.contentToken, null);
  });

  // --- TRICKY PART: Covering the unused makeTagSplitter ---
  // Since it's not exported, we test it through an adapter that uses it.
  // If NO adapter uses it yet, we can temporarily add a test-only adapter 
  // to your reasoning.js file OR just test the resolve logic.
  // Assuming you might add an O1/Claude adapter later, let's hit the 
  // logic if you're willing to add "export" to makeTagSplitter.

    
  });

  describe("Reasoning Field Logic (Qwen/DeepSeek/Gemma style)", () => {
    const adapter = resolveReasoningAdapter("qwen3");

    test("emits start, tokens, and done in sequence", () => {
      const state = adapter.createState();
      const events = [];
      const emit = (e) => events.push(e);

      // 1. First reasoning token triggers start
      adapter.processDelta({ reasoning: "Thinking" }, state, emit);
      assert.deepEqual(events[0], { type: "reasoning_start" });
      assert.deepEqual(events[1], { type: "reasoning_token", text: "Thinking" });

      // 2. Subsequent reasoning tokens don't trigger start again
      adapter.processDelta({ reasoning: "..." }, state, emit);
      assert.strictEqual(events.length, 3);

      // 3. Content token closes reasoning
      const res = adapter.processDelta({ content: "Hello" }, state, emit);
      assert.deepEqual(events[3], { type: "reasoning_done" });
      assert.strictEqual(res.contentToken, "Hello");
    });

    test("handles content without any prior reasoning", () => {
      const state = adapter.createState();
      const events = [];
      const res = adapter.processDelta({ content: "Direct answer" }, state, (e) => events.push(e));
      assert.strictEqual(res.contentToken, "Direct answer");
      assert.strictEqual(events.length, 0);
    });
  });

  describe("Llama Adapter", () => {
    test("simply passes content through", () => {
      const adapter = resolveReasoningAdapter("llama-3-8b");
      const res = adapter.processDelta({ content: "hi" }, {}, () => {});
      assert.strictEqual(res.contentToken, "hi");
      assert.strictEqual(adapter.stripReasoning("test"), "test");
    });
  });

  // This hits the internal helper that isn't used by the adapters yet
  // but exists in your file.
  describe("Internal makeTagSplitter (Coverage for unused helper)", () => {
    // We have to test this if we want 100% coverage on the file
    // Since it's not exported, we'd normally export it, 
    // but if it's strictly internal, you can skip or add a temporary export.
  });
});
