import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveReasoningAdapter, REASONING_ADAPTERS } from "../../../lib/workers/reasoning.js";

describe("reasoning.js", () => {
  
  describe("Adapter Resolution", () => {
    test("matches specific models", () => {
      const adapter = resolveReasoningAdapter("DeepSeek-R1-Distill");
      assert.strictEqual(adapter.match, "deepseek-r1");
      assert.strictEqual(adapter.thinks, true);
    });

    test("Ornith resolves to an inline-think adapter and strips a headless </think>", () => {
      const adapter = resolveReasoningAdapter("ornith:9b");
      assert.strictEqual(adapter.match, "ornith");
      assert.strictEqual(adapter.thinks, true);
      // Screenshot repro: reasoning leaks inline as "…</think>answer" in content.
      const state = adapter.createState(false);
      const events = [];
      const emit = (e) => events.push(e.type);
      let answer = "";
      for (const chunk of ["I'll fetch the issue.", "</think>Got it, checking now."]) {
        const { contentToken } = adapter.processDelta({ content: chunk }, state, emit);
        if (contentToken) answer += contentToken;
      }
      answer += adapter.flushState(state);
      assert.ok(events.includes("reasoning_done"));
      assert.strictEqual(answer, "Got it, checking now.");
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

  test("no adapter proactively suppresses thinking on tool turns", () => {
    // Thinking is allowed to stream on every turn so the reasoning toggle is
    // honored; Gemma's occasional empty-completion stall is handled by
    // runOllamaLoop's retry, not by a per-adapter suppression flag.
    for (const name of ["gemma4:12b", "qwen3:30b-a3b", "deepseek-r1"]) {
      assert.notStrictEqual(resolveReasoningAdapter(name).noThinkWithTools, true);
    }
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

      // 3. Content token closes reasoning. Content now flows through the inline
      //    <think> splitter, which speculatively buffers a trailing window; the
      //    full answer is the feed result plus the post-stream flush.
      const res = adapter.processDelta({ content: "Hello" }, state, emit);
      assert.deepEqual(events[3], { type: "reasoning_done" });
      assert.strictEqual((res.contentToken ?? "") + adapter.flushState(state), "Hello");
    });

    test("empty-string content does not close an open reasoning block", () => {
      // Ollama sends `content: ""` alongside every reasoning chunk. Each such
      // chunk must keep the single reasoning block open rather than emitting a
      // reasoning_done (which would split each token into its own bubble).
      const state = adapter.createState();
      const events = [];
      const emit = (e) => events.push(e);

      adapter.processDelta({ reasoning: "first", content: "" }, state, emit);
      adapter.processDelta({ reasoning: "second", content: "" }, state, emit);
      adapter.processDelta({ reasoning: "third", content: "" }, state, emit);

      assert.strictEqual(events.filter(e => e.type === "reasoning_start").length, 1);
      assert.strictEqual(events.filter(e => e.type === "reasoning_done").length, 0);
      assert.strictEqual(events.filter(e => e.type === "reasoning_token").length, 3);
    });

    test("handles content without any prior reasoning", () => {
      const state = adapter.createState();
      const events = [];
      const res = adapter.processDelta({ content: "Direct answer" }, state, (e) => events.push(e));
      assert.strictEqual((res.contentToken ?? "") + adapter.flushState(state), "Direct answer");
      assert.strictEqual(events.length, 0);
    });

    test("strips an inline <think> block from content into reasoning events", () => {
      const state = adapter.createState();
      const events = [];
      const emit = (e) => events.push(e);
      const res = adapter.processDelta(
        { content: "<think>weighing options</think>The answer" }, state, emit
      );
      const answer = (res.contentToken ?? "") + adapter.flushState(state);
      assert.strictEqual(answer, "The answer");
      assert.ok(events.some(e => e.type === "reasoning_start"));
      assert.ok(events.some(e => e.type === "reasoning_token" && e.text.includes("weighing options")));
      assert.ok(events.some(e => e.type === "reasoning_done"));
    });

    test("strips a HEADLESS think block (no opening tag) — the leak bug", () => {
      // The chat template pre-fills `<think>`, so the model's content begins
      // inside reasoning and only ever emits the closing `</think>`. The whole
      // reasoning must route to reasoning_* events instead of leaking into the
      // answer (which is what the user reported).
      const state = adapter.createState();
      const events = [];
      const emit = (e) => events.push(e);
      const res = adapter.processDelta(
        { content: "reasoning about planets</think>The final answer" }, state, emit
      );
      const answer = (res.contentToken ?? "") + adapter.flushState(state);
      assert.strictEqual(answer, "The final answer");
      assert.ok(events.some(e => e.type === "reasoning_start"));
      assert.ok(events.some(e => e.type === "reasoning_token" && e.text.includes("reasoning about planets")));
      assert.ok(events.some(e => e.type === "reasoning_done"));
      // The closing tag must never appear in the answer.
      assert.ok(!answer.includes("</think>"));
    });

    test("headless block split across chunks buffers the lead until </think>", () => {
      const state = adapter.createState();
      const events = [];
      const emit = (e) => events.push(e);
      // Lead chunk has no tag yet — must be held, not emitted as answer.
      const r1 = adapter.processDelta({ content: "still think" }, state, emit);
      assert.strictEqual(r1.contentToken, null);
      assert.strictEqual(events.length, 0);
      const r2 = adapter.processDelta({ content: "ing</think>Done" }, state, emit);
      const answer = (r2.contentToken ?? "") + adapter.flushState(state);
      assert.strictEqual(answer, "Done");
      assert.ok(events.some(e => e.type === "reasoning_token" && e.text.includes("still thinking")));
    });

    test("suppressed turn streams content directly without headless buffering", () => {
      // When thinking is suppressed (reasoning_effort:none) the content is the
      // answer; it must stream immediately rather than being held to look for a
      // </think> that will never come.
      const state = adapter.createState(true);
      const events = [];
      const res = adapter.processDelta(
        { content: "Immediate answer that is long enough to stream" }, state, (e) => events.push(e)
      );
      const answer = (res.contentToken ?? "") + adapter.flushState(state);
      assert.strictEqual(answer, "Immediate answer that is long enough to stream");
      assert.ok((res.contentToken ?? "").length > 0); // streamed, not all held to flush
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
