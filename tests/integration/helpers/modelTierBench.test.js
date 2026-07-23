import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  describeBenchmarkCase,
  evaluateBenchmarkCase,
  selectBenchmarkCases,
  validateBenchmarkCases,
  validateBenchmarkModels,
  rescoreBenchmarkRun,
} from "../../../lib/helpers/modelTierBench.js";
import {
  QUALIFICATION_CASE_COUNT,
  QUALIFICATION_SUITE_VERSION,
  validateQualificationFixture,
  validateQualificationStateContract,
} from "../../../lib/helpers/modelTierQualification.js";
import { readFileSync } from "node:fs";

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
    assert.equal(item.timeoutMs, 300_000);
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

  test("normalizes argument assertions for filtered recall cases", () => {
    const [item] = validateBenchmarkCases([{
      ...recall,
      argumentAssertions: [{ tool: "recall", arguments: { type: "decision" } }],
    }]);
    assert.deepEqual(item.argumentAssertions, [{ tool: "recall", arguments: { type: "decision" } }]);
  });
});

test("describeBenchmarkCase returns the complete self-describing artifact contract", () => {
  assert.deepEqual(describeBenchmarkCase(recall), {
    id: "recall",
    title: "Recall Nimbus messaging context",
    objective: "Verify semantic recall grounds the answer in stored architectural context.",
    prompt: "What does Nimbus use?",
    section: "recall",
    kind: "behavior",
    hardGate: true,
    expectedToolSequence: ["recall"],
    requiredAnswerTerms: ["NATS"],
    argumentAssertions: [],
    requireAllToolsSuccessful: true,
    stateAssertion: { kind: "none" },
  });
});

describe("validateBenchmarkModels", () => {
  test("requires stable ids and an explicit repository quant", () => {
    const model = { id: "qwen35-9b-q4km", hf: "org/model-GGUF:Q4_K_M", quant: "Q4_K_M", displayName: "Model", sizeGB: 4, tiers: [16, 24], role: "challenger", verification: { source: "huggingface", repository: "https://huggingface.co/org/model-GGUF", verifiedAt: "2026-07-14" } };
    assert.deepEqual(validateBenchmarkModels([model]), [model]);
    assert.throws(() => validateBenchmarkModels([{ ...model, id: "Qwen 9B" }]), /stable lowercase slug/);
    assert.deepEqual(validateBenchmarkModels([{ ...model, hf: "org/model-GGUF" }])[0].quant, "Q4_K_M");
  });
});

describe("evaluateBenchmarkCase", () => {
  test("requires and records asserted tool argument values", () => {
    const filtered = {
      ...recall,
      argumentAssertions: [{ tool: "recall", arguments: { tags: ["redis"] } }],
      requiredAnswerTerms: ["Redis"],
    };
    const passed = evaluateBenchmarkCase(filtered, [
      { type: "tool_start", name: "recall", arguments: { tags: ["redis"] } },
      { type: "tool_result", name: "recall", ok: true },
      { type: "stream_end", text: "Redis" },
      { type: "turn_complete", status: "completed" },
    ]);
    assert.equal(passed.status, "pass");
    assert.deepEqual(passed.argumentAssertions, [{
      tool: "recall", expected: { tags: ["redis"] }, observed: { tags: ["redis"] }, passed: true,
    }]);

    const missing = evaluateBenchmarkCase(filtered, [
      { type: "tool_start", name: "recall", arguments: { limit: 10 } },
      { type: "tool_result", name: "recall", ok: true },
      { type: "stream_end", text: "Redis" },
      { type: "turn_complete", status: "completed" },
    ]);
    assert.equal(missing.status, "fail");
    assert.equal(missing.argumentAssertions[0].passed, false);
    assert.deepEqual(missing.argumentAssertions[0].observed, { limit: 10 });
  });

  test("accepts extra tool arguments when all asserted values match", () => {
    const filtered = {
      ...recall,
      argumentAssertions: [{ tool: "recall", arguments: { type: "decision" } }],
    };
    const result = evaluateBenchmarkCase(filtered, [
      { type: "tool_start", name: "recall", arguments: { type: "decision", query: "deployment", limit: 5 } },
      { type: "tool_result", name: "recall", ok: true },
      { type: "stream_end", text: "NATS deployment decision" },
      { type: "turn_complete", status: "completed" },
    ]);
    assert.equal(result.argumentAssertionsPassed, true);
    assert.equal(result.status, "pass");
  });

  test("rejects a wrong value for an asserted tool argument even with extra fields", () => {
    const filtered = {
      ...recall,
      argumentAssertions: [{ tool: "recall", arguments: { type: "decision" } }],
    };
    const result = evaluateBenchmarkCase(filtered, [
      { type: "tool_start", name: "recall", arguments: { type: "fact", query: "deployment", limit: 5 } },
      { type: "tool_result", name: "recall", ok: true },
      { type: "stream_end", text: "Deployment fact" },
      { type: "turn_complete", status: "completed" },
    ]);
    assert.equal(result.argumentAssertionsPassed, false);
    assert.equal(result.argumentAssertions[0].passed, false);
    assert.equal(result.status, "fail");
  });

  test("a missing required argument assertion does not turn a timeout into a model failure", () => {
    const filtered = { ...recall, argumentAssertions: [{ tool: "recall", arguments: { type: "decision" } }] };
    const result = evaluateBenchmarkCase(filtered, [
      { type: "tool_start", name: "recall", arguments: {} },
    ]);
    assert.equal(result.completed, false);
    assert.equal(result.status, "fail");
    assert.equal(result.argumentAssertions[0].passed, false);
  });
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

describe("rescoreBenchmarkRun", () => {
  const persistedCase = {
    id: "recall-filter-type", status: "fail", completed: true,
    toolSequencePassed: true, answerTermsPassed: true, toolsSuccessful: true, statePassed: true,
    argumentAssertionsPassed: false,
    argumentAssertions: [{ tool: "recall", expected: { type: "decision" }, observed: { query: "Nimbus", type: "decision" }, passed: false }],
  };

  test("rescored complete artifacts convert only subset-matcher false negatives without mutating input", () => {
    const run = { status: "complete", caseResults: [persistedCase] };
    const result = rescoreBenchmarkRun(run);
    assert.deepEqual(result.changedCases, ["recall-filter-type"]);
    assert.equal(result.run.caseResults[0].status, "pass");
    assert.equal(result.run.caseResults[0].rescore.matcher, "argument-subset");
    assert.equal(persistedCase.status, "fail");
    assert.equal(persistedCase.argumentAssertions[0].passed, false);
  });

  test("preserves genuine failures, invalid cases, and non-complete runs", () => {
    const genuine = { ...persistedCase, answerTermsPassed: false };
    const invalid = { ...persistedCase, status: "invalid", invalidReason: "timeout" };
    for (const run of [
      { status: "complete", caseResults: [genuine, invalid] },
      { status: "invalid", caseResults: [persistedCase] },
    ]) {
      const result = rescoreBenchmarkRun(run);
      assert.deepEqual(result.changedCases, []);
      assert.deepEqual(result.run, run);
    }
  });
});

test("selectBenchmarkCases preserves suite order and rejects unknown ids", () => {
  const cases = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(selectBenchmarkCases(cases, ["c", "a"]), [{ id: "a" }, { id: "c" }]);
  assert.throws(() => selectBenchmarkCases(cases, ["missing"]), /unknown case/);
});

test("the checked-in qualification suite is the canonical 14-case funnel", () => {
  const suite = JSON.parse(readFileSync("docs/benchmarks/tools/cases.json", "utf8"));
  const validated = validateBenchmarkCases(suite);
  assert.equal(QUALIFICATION_SUITE_VERSION, 1);
  assert.equal(validated.length, QUALIFICATION_CASE_COUNT);
  assert.deepEqual(validated.map(item => item.id), [
    "recall-semantic-nats",
    "recall-filter-type",
    "recall-filter-tag",
    "recall-update-by-id",
    "chain-recall-wiki",
    "file-read-selection",
    "file-write-sandboxed",
    "chain-write-run-node",
    "chain-recall-document-existence",
    "chain-code-syntax-run",
    "chain-web-source-memory",
    "chain-recall-wiki-provenance",
    "guardrail-out-of-scope-read",
    "guardrail-unsafe-shell-pipeline",
  ]);
  assert.deepEqual(validated.filter(item => item.hardGate).map(item => item.id), [
    "recall-semantic-nats",
    "recall-filter-type",
    "recall-filter-tag",
    "recall-update-by-id",
    "chain-recall-document-existence",
    "chain-code-syntax-run",
    "chain-web-source-memory",
    "chain-recall-wiki-provenance",
    "guardrail-out-of-scope-read",
    "guardrail-unsafe-shell-pipeline",
  ]);
  for (const item of validated) validateQualificationStateContract(item);
  assert.equal(validated[0].stateContract.reset, "fresh-session");
  assert.equal(describeBenchmarkCase(validated[0]).stateContract.restore, "fixture-and-workspace");
});

test("the qualification memory fixture is exactly 28 tagged memories", () => {
  const fixture = JSON.parse(readFileSync(".github/capability-exam/exam.memories.json", "utf8"));
  const contract = JSON.parse(readFileSync("docs/benchmarks/tools/fixture-contract.json", "utf8"));
  assert.deepEqual(validateQualificationFixture(fixture, contract), {
    memoryCount: 28,
    tag: "aperio-exam",
  });
});
