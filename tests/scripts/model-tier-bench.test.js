import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeBenchmarkCases,
  parseArgs,
  resolveBenchmarkArtifactDir,
  runWsCase,
  validateTargetTier,
} from "../../scripts/model-tier-bench.js";

const cases = [
  {
    id: "first", title: "First case", objective: "Complete before the invalid case.",
    section: "recall", kind: "behavior", prompt: "first", expectedToolSequence: ["recall"],
    requiredAnswerTerms: [], requireAllToolsSuccessful: true, hardGate: true,
    stateAssertion: { kind: "none" }, timeoutMs: 1_000,
  },
  {
    id: "second", title: "Second case", objective: "Retain partial evidence when interrupted.",
    section: "chains", kind: "behavior", prompt: "second", expectedToolSequence: ["fetch_url", "remember"],
    requiredAnswerTerms: ["saved"], requireAllToolsSuccessful: true, hardGate: true,
    stateAssertion: { kind: "memory", type: "source", contentIncludes: ["example.com"] }, timeoutMs: 1_000,
  },
];

test("parseArgs collects repeatable case ids and the environment note", () => {
  assert.deepEqual(parseArgs([
    "--model", "qwen35-9b-q4km", "--case", "recall", "--case", "guardrail",
    "--note", "contaminated", "--allow-download",
  ]), {
    modelId: "qwen35-9b-q4km",
    caseIds: ["recall", "guardrail"],
    environmentNote: "contaminated",
    allowDownload: true,
    validate: false,
  });
});

test("parseArgs records an explicit target tier", () => {
  assert.equal(parseArgs(["--model", "qwen35-9b-q4km", "--tier", "16"]).tier, 16);
});

test("resolveBenchmarkArtifactDir uses the tier-first private layout", () => {
  assert.equal(
    resolveBenchmarkArtifactDir("/repo", 16, "qwen35-9b-q4km", "20260714T120000Z"),
    "/repo/var/benchmarks/model-tiers/16gb/qwen35-9b-q4km/20260714T120000Z",
  );
  assert.throws(() => resolveBenchmarkArtifactDir("/repo", 12, "model", "campaign"), /tier must be/);
});

test("validateTargetTier requires model eligibility", () => {
  const model = { id: "qwen35-9b-q4km", tiers: [16, 24, 32] };
  assert.equal(validateTargetTier(model, 16), 16);
  assert.throws(() => validateTargetTier(model, 8), /not eligible/);
  assert.throws(() => validateTargetTier(model, 12), /tier must be/);
});

test("runWsCase waits for the correlated turn_complete, not stream_end", async () => {
  class FakeSocket extends EventEmitter {
    send(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({ type: "stream_end", text: "intermediate" })));
        this.emit("message", Buffer.from(JSON.stringify({ type: "tool_start", name: "recall" })));
        this.emit("message", Buffer.from(JSON.stringify({ type: "turn_complete", turnId: "other", status: "completed" })));
        this.emit("message", Buffer.from(JSON.stringify({ type: "turn_complete", turnId: request.turnId, status: "completed" })));
      });
    }
  }
  const result = await runWsCase(new FakeSocket(), { id: "recall", prompt: "Recall it", timeoutMs: 1_000 });
  assert.deepEqual(result.events.map(event => event.type), ["stream_end", "tool_start", "turn_complete", "turn_complete"]);
  assert.equal(result.events.at(-1).turnId, "recall");
});

test("executeBenchmarkCases preserves completed and interrupted case artifacts on an invalid run", async () => {
  const partialEvents = [{ type: "tool_start", name: "fetch_url" }];
  const timeout = Object.assign(new Error("case second timed out"), {
    caseEvents: partialEvents,
    durationMs: 1234,
  });
  const seenEvents = [];

  await assert.rejects(
    () => executeBenchmarkCases(cases, {
      runCase: async caseDef => {
        if (caseDef.id === "second") throw timeout;
        return {
          durationMs: 50,
          events: [
            { type: "tool_start", name: "recall" },
            { type: "tool_result", name: "recall", ok: true },
            { type: "turn_complete", status: "completed" },
          ],
        };
      },
      verifyCaseState: async () => true,
      recordEvents: (caseDef, events) => seenEvents.push([caseDef.id, events]),
    }),
    error => {
      assert.equal(error, timeout);
      assert.equal(error.caseResults.length, 2);
      assert.equal(error.caseResults[0].status, "pass");
      assert.equal(error.caseResults[0].title, "First case");
      assert.equal(error.caseResults[1].status, "invalid");
      assert.equal(error.caseResults[1].invalidReason, "case second timed out");
      assert.equal(error.caseResults[1].durationMs, 1234);
      assert.equal(error.caseResults[1].title, "Second case");
      assert.equal(error.caseResults[1].objective, "Retain partial evidence when interrupted.");
      assert.deepEqual(error.caseResults[1].actualToolSequence, ["fetch_url"]);
      assert.deepEqual(error.caseResults[1].expectedToolSequence, ["fetch_url", "remember"]);
      assert.deepEqual(error.caseResults[1].requiredAnswerTerms, ["saved"]);
      assert.deepEqual(error.caseResults[1].stateAssertion, {
        kind: "memory", type: "source", contentIncludes: ["example.com"],
      });
      return true;
    },
  );
  assert.equal(seenEvents.length, 2);
  assert.equal(seenEvents[0][0], "first");
  assert.deepEqual(seenEvents[1], ["second", partialEvents]);
});
