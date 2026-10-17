import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  capToolResults,
  trimByTokens,
  dropOrphanedToolResults,
  estimateMsgTokens,
} from "../../../lib/context/trim.js";

// Regression coverage for the "agent ran the tool but reported nothing" bug:
// a single oversized tool result (e.g. a 150KB `npm test` dump ~37k tokens) on
// a 32k window was trimmed down to its paired tool_use, then orphan-dropped,
// leaving the model to answer with no tool output at all.

describe("capToolResults", () => {
  const CTX = 32768;

  test("truncates a tool result larger than 25% of the window to head + tail", () => {
    const body = "PASS first line\n" + "noise\n".repeat(40000) + "FAIL summary at the very end\n";
    const messages = [
      { role: "user", content: "run the tests" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "run_shell", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: body }] },
    ];
    assert.ok(estimateMsgTokens(messages[2]) > CTX * 0.25, "fixture must exceed the budget");

    const capped = capToolResults(messages, CTX);
    const tokens = estimateMsgTokens(capped[2]);
    assert.ok(tokens <= CTX * 0.25 + 64, `capped to budget, got ${tokens}`);

    const text = capped[2].content[0].content;
    assert.match(text, /PASS first line/, "keeps the head");
    assert.match(text, /FAIL summary at the very end/, "keeps the tail verdict");
    assert.match(text, /truncated to fit context/, "marks the omission");
  });

  test("leaves small results untouched and returns the same array reference", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok, done" }] },
    ];
    const capped = capToolResults(messages, CTX);
    assert.equal(capped, messages, "no change → identity");
  });

  test("a capped result survives trimming on a 32k window (the original bug)", () => {
    const body = "PASS\n".repeat(40000) + "VERDICT: 2 failed\n";
    const messages = [
      { role: "user", content: "run npm run test:ci" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "run_shell", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: body }] },
    ];

    // Uncapped path: feed the raw oversized result straight into trim. The
    // freshest-result pin now keeps it from being dropped, but uncapped it dwarfs
    // the window — so capToolResults is still required to make it actually fit.
    const rawHwm = messages.reduce((s, m) => s + estimateMsgTokens(m), 0);
    const old = dropOrphanedToolResults(trimByTokens(messages, rawHwm, CTX).messages);
    const oldTool = old.find(m => m.role === "tool");
    assert.ok(oldTool && estimateMsgTokens(oldTool) > CTX, "uncapped result survives (pinned) but overflows the window");

    // New path: cap first, then trim → result kept, verdict visible.
    const capped = capToolResults(messages, CTX);
    const hwm = capped.reduce((s, m) => s + estimateMsgTokens(m), 0);
    const fixed = dropOrphanedToolResults(trimByTokens(capped, hwm, CTX).messages);
    const toolMsg = fixed.find(m => m.role === "tool");
    assert.ok(toolMsg, "new behavior keeps the tool result");
    assert.match(toolMsg.content[0].content, /VERDICT: 2 failed/, "verdict reaches the model");
  });
});

describe("trimByTokens pair safety", () => {
  test("drops tool_use + tool_result together, never orphaning a result", () => {
    const CTX = 8000;
    const big = "x".repeat(20000); // ~5k tokens
    const messages = [
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "run_shell", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "a", content: big }] },
      { role: "assistant", content: [{ type: "tool_use", id: "b", name: "run_shell", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "b", content: big }] },
      { role: "user", content: "final question" },
    ];
    const { messages: trimmed } = trimByTokens(messages, 12000, CTX);
    const out = dropOrphanedToolResults(trimmed);
    // The message right after msgs[0] must not be an orphaned tool result.
    const head = out[1];
    const headIsOrphan = head && (head.role === "tool" ||
      (Array.isArray(head.content) && head.content[0]?.type === "tool_result"));
    assert.ok(!headIsOrphan, "no orphaned tool_result at the head of the trimmed region");
  });
});

describe("trimByTokens pins the freshest tool result", () => {
  // Reproduces the gemma4:12b trim-thrash: on a tiny window the freshest
  // tool_result must survive so the model can answer instead of re-fetching.
  test("keeps the most recent tool_use/tool_result pair even under emergency pressure", () => {
    const CTX = 6000;
    const big = "x".repeat(16000); // ~4k tokens each — several can't coexist
    const messages = [
      { role: "user", content: "check issue 49" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "fetch_github_issue", input: { url: "u/49" } }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "a", content: big }] },
      { role: "assistant", content: [{ type: "tool_use", id: "b", name: "fetch_github_issue", input: { url: "u/49" } }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "b", content: "FRESH ISSUE BODY 49" }] },
    ];
    // hwm well above the emergency threshold (0.90 * 6000) to force minTail=1.
    const { messages: trimmed } = trimByTokens(messages, 15000, CTX);
    const survivedFresh = trimmed.some(m =>
      Array.isArray(m.content) && m.content.some(b => b?.type === "tool_result" && b.content === "FRESH ISSUE BODY 49"));
    assert.ok(survivedFresh, "freshest tool_result must not be trimmed away");
    // And its paired tool_use must survive too, so the result is never orphaned.
    const survivedUse = trimmed.some(m =>
      Array.isArray(m.content) && m.content.some(b => b?.type === "tool_use" && b.id === "b"));
    assert.ok(survivedUse, "paired tool_use must survive with the pinned result");
  });
});
