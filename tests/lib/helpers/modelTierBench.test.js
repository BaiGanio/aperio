import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  describeBenchmarkCase,
  evaluateBenchmarkCase,
  selectBenchmarkCases,
  validateBenchmarkCases,
  validateBenchmarkModels,
} from "../../../lib/helpers/modelTierBench.js";

const recall = {
  id: "recall",
  title: "Recall Nimbus messaging context",
  objective: "Verify semantic recall grounds the answer in stored architectural context.",
  section: "recall",
  kind: "behavior",
  prompt: "What does Nimbus use?",
  expectedToolSequence: ["recall"],
  requiredAnswerTerms: ["NATS"],
  hardGate: true,
};

describe("validateBenchmarkCases", () => {
  test("normalizes defaults and rejects duplicate ids", () => {
    const [item] = validateBenchmarkCases([recall]);
    assert.equal(item.timeoutMs, 120_000);
    assert.deepEqual(item.stateAssertion, { kind: "none" });
    assert.throws(() => validateBenchmarkCases([recall, recall]), /duplicate case id/);
  });

  test("requires guardrails to name forbidden successful tools", () => {
    assert.throws(() => validateBenchmarkCases([{
      id: "unsafe", section: "guardrails", kind: "guardrail", prompt: "Do unsafe thing",
    }]), /forbiddenSuccessfulTools/);
  });

  test("requires the descriptive metadata persisted with every result", () => {
    assert.throws(() => validateBenchmarkCases([{ ...recall, title: "" }]), /title/);
    assert.throws(() => validateBenchmarkCases([{ ...recall, objective: undefined }]), /objective/);
  });
});

test("describeBenchmarkCase returns the complete self-describing artifact contract", () => {
  assert.deepEqual(describeBenchmarkCase(recall), {
    id: "recall",
    title: "Recall Nimbus messaging context",
    objective: "Verify semantic recall grounds the answer in stored architectural context.",
    section: "recall",
    kind: "behavior",
    hardGate: true,
    expectedToolSequence: ["recall"],
    requiredAnswerTerms: ["NATS"],
    requireAllToolsSuccessful: true,
    stateAssertion: { kind: "none" },
  });
});

describe("validateBenchmarkModels", () => {
  test("requires stable ids and exact repo:quant identifiers", () => {
    const model = { id: "qwen35-9b-q4km", hf: "org/model-GGUF:Q4_K_M", tiers: [16, 24] };
    assert.deepEqual(validateBenchmarkModels([model]), [model]);
    assert.throws(() => validateBenchmarkModels([{ ...model, id: "Qwen 9B" }]), /stable lowercase slug/);
    assert.throws(() => validateBenchmarkModels([{ ...model, hf: "org/model-GGUF" }]), /repo:quant/);
  });
});

describe("evaluateBenchmarkCase", () => {
  test("does not pass from answer text without the required tool event", () => {
    const result = evaluateBenchmarkCase(recall, [
      { type: "stream_end", text: "Nimbus uses NATS" },
      { type: "turn_complete", status: "completed" },
    ]);
    assert.equal(result.status, "fail");
    assert.equal(result.answerTermsPassed, true);
    assert.equal(result.toolSequencePassed, false);
    assert.equal(result.title, recall.title);
    assert.equal(result.objective, recall.objective);
    assert.deepEqual(result.stateAssertion, { kind: "none" });
  });

  test("passes an ordered multi-tool chain with successful state verification", () => {
    const chain = { ...recall, expectedToolSequence: ["recall", "wiki_write", "wiki_get"], requiredAnswerTerms: [] };
    const result = evaluateBenchmarkCase(chain, [
      { type: "tool_start", name: "recall" }, { type: "tool_result", name: "recall", ok: true },
      { type: "tool_start", name: "wiki_write" }, { type: "tool_result", name: "wiki_write", ok: true },
      { type: "tool_start", name: "wiki_get" }, { type: "tool_result", name: "wiki_get", ok: true },
      { type: "turn_complete", status: "completed" },
    ], { statePassed: true });
    assert.equal(result.status, "pass");
  });

  test("distinguishes model refusal from an exercised application guardrail", () => {
    const guardrail = {
      kind: "guardrail", expectedToolSequence: [], requiredAnswerTerms: [],
      forbiddenSuccessfulTools: ["read_file"], requireAllToolsSuccessful: false,
    };
    const refusal = evaluateBenchmarkCase(guardrail, [{ type: "turn_complete", status: "completed" }]);
    const exercised = evaluateBenchmarkCase(guardrail, [
      { type: "tool_start", name: "read_file" },
      { type: "tool_result", name: "read_file", ok: false },
      { type: "turn_complete", status: "completed" },
    ]);
    assert.equal(refusal.status, "pass");
    assert.equal(refusal.guardrailMode, "model_refusal");
    assert.equal(exercised.status, "pass");
    assert.equal(exercised.guardrailMode, "application_guardrail");
  });

  test("fails a guardrail if the forbidden operation succeeds", () => {
    const result = evaluateBenchmarkCase({
      kind: "guardrail", expectedToolSequence: [], requiredAnswerTerms: [],
      forbiddenSuccessfulTools: ["read_file"], requireAllToolsSuccessful: false,
    }, [
      { type: "tool_start", name: "read_file" },
      { type: "tool_result", name: "read_file", ok: true },
      { type: "turn_complete", status: "completed" },
    ]);
    assert.equal(result.status, "fail");
  });
});

test("selectBenchmarkCases preserves suite order and rejects unknown ids", () => {
  const cases = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(selectBenchmarkCases(cases, ["c", "a"]), [{ id: "a" }, { id: "c" }]);
  assert.throws(() => selectBenchmarkCases(cases, ["missing"]), /unknown case/);
});
