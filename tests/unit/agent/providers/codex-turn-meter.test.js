import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  CODEX_TURN_DEFAULTS,
  createCodexTurnMeter,
  resolveCodexTurnBudgets,
} from "../../../../lib/agent/providers/codex-turn-meter.js";

describe("Codex turn meter", () => {
  test("counts distinct tool and work items once with a monotonic clock", () => {
    let time = 100;
    const meter = createCodexTurnMeter({
      budgets: { maxToolCalls: 4, maxSteps: 5, timeoutMs: 1000, maxProcessedTokens: 300000 },
      now: () => time,
    });

    assert.equal(meter.observeItem("item.started", { id: "r1", type: "reasoning" }), null);
    assert.equal(meter.observeItem("item.started", { id: "t1", type: "command_execution" }), null);
    assert.equal(meter.observeItem("item.completed", { id: "t1", type: "command_execution" }), null);
    assert.equal(meter.observeItem("item.started", { id: "t2", type: "mcp_tool_call" }), null);
    assert.deepEqual(meter.snapshot(), {
      tool_calls: 2, internal_steps: 3, elapsed_ms: 0, guardrail: null,
    });

    time = 145;
    assert.equal(meter.snapshot().elapsed_ms, 45);
  });

  test("counts completed-only reasoning and reports the first live guardrail", () => {
    const meter = createCodexTurnMeter({
      budgets: { maxToolCalls: 0, maxSteps: 1, timeoutMs: 0, maxProcessedTokens: 0 },
      now: () => 0,
    });
    assert.equal(meter.observeItem("item.completed", { id: "r1", type: "reasoning" }), null);
    assert.deepEqual(meter.observeItem("item.started", { id: "t1", type: "command_execution" }), {
      kind: "internal_steps", limit: 1, value: 2, enforcement: "live", setting: "CODEX_TURN_MAX_STEPS",
    });
    assert.equal(meter.observeItem("item.started", { id: "t2", type: "command_execution" }).value, 2);
  });

  test("processed-token exhaustion is observed and does not become a live abort", () => {
    const meter = createCodexTurnMeter({
      budgets: { maxToolCalls: 0, maxSteps: 0, timeoutMs: 0, maxProcessedTokens: 100 },
      now: () => 0,
    });
    assert.deepEqual(meter.observeProcessedTokens(101), {
      kind: "processed_tokens", limit: 100, value: 101,
      enforcement: "observed", setting: "CODEX_TURN_MAX_PROCESSED_TOKENS",
    });
    assert.equal(meter.guardrail.enforcement, "observed");
  });

  test("invalid and fractional configuration values use safe registry defaults; zero disables", () => {
    const invalid = [];
    const budgets = resolveCodexTurnBudgets({
      CODEX_TURN_MAX_TOOL_CALLS: "0",
      CODEX_TURN_MAX_STEPS: "nope",
      CODEX_TURN_TIMEOUT_MS: "1.5",
      CODEX_TURN_MAX_PROCESSED_TOKENS: "-1",
    }, { onInvalid: key => invalid.push(key) });
    assert.equal(budgets.maxToolCalls, 0);
    assert.equal(budgets.maxSteps, CODEX_TURN_DEFAULTS.maxSteps);
    assert.equal(budgets.timeoutMs, CODEX_TURN_DEFAULTS.timeoutMs);
    assert.equal(budgets.maxProcessedTokens, CODEX_TURN_DEFAULTS.maxProcessedTokens);
    assert.deepEqual(invalid, ["CODEX_TURN_MAX_STEPS", "CODEX_TURN_TIMEOUT_MS", "CODEX_TURN_MAX_PROCESSED_TOKENS"]);
  });
});
