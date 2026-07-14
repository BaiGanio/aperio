import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyRuntimeLog,
  createMetricReport,
  captureLedgerOffsets,
  sliceLedger,
  summarizeToolQuality,
  executeBenchmarkCases,
  restoreQualificationState,
  modelReady,
  preflightModelCandidate,
  parseArgs,
  resolveBenchmarkArtifactDir,
  resolveTierConfiguration,
  resolveHostTier,
  teardownOwnedProcesses,
  runWsCase,
  writeInvalidAdmissionRun,
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

test("catalog contains the smallest exact cached Gemma entry", () => {
  const models = JSON.parse(readFileSync("benchmarks/model-tiers/models.json", "utf8"));
  const gemma = models.find(model => model.id === "gemma4-e4b-q4kxl");
  assert.deepEqual(gemma, {
    id: "gemma4-e4b-q4kxl",
    displayName: "Gemma 4 E4B Q4_K_XL",
    hf: "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
    quant: "Q4_K_XL",
    sizeGB: 3.93,
    tiers: [8, 16, 24, 32],
  });
});

test("candidate preflight admits only the exact repo and quant with GGUF facts and disk headroom", () => {
  const model = {
    id: "gemma4-e4b-q4kxl",
    hf: "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
    quant: "Q4_K_XL",
    sizeGB: 3.93,
  };
  const cachedPath = "/cache/models--unsloth--gemma-4-E4B-it-qat-GGUF/snapshots/rev/gemma-4-E4B-it-qat-Q4_K_XL.gguf";
  const result = preflightModelCandidate(model, {
    cacheRoot: "/cache",
    findCached: () => cachedPath,
    factsFromGguf: path => ({
      path,
      source: "gguf",
      sizeGB: 3.93,
      architecture: "dense",
      maxContext: 131072,
      kvLayers: 42,
      kvBytesPerToken: 172032,
    }),
    diskAvailableBytes: 7 * 1024 ** 3,
  });

  assert.equal(result.status, "admitted");
  assert.equal(result.hf, model.hf);
  assert.equal(result.cachedGguf.path, cachedPath);
  assert.equal(result.ggufFacts.architecture, "dense");
  assert.equal(result.disk.requiredGB, 5.93);
});

test("candidate preflight reports concrete admission reasons for identity, facts, and disk failures", () => {
  const model = {
    id: "gemma4-e4b-q4kxl",
    hf: "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
    quant: "Q4_K_XL",
    sizeGB: 3.93,
  };
  const base = {
    cacheRoot: "/cache",
    findCached: () => "/cache/models--unsloth--gemma-4-E4B-it-qat-GGUF/snapshots/rev/wrong-Q5_K_M.gguf",
    factsFromGguf: () => null,
    diskAvailableBytes: 1 * 1024 ** 3,
  };

  const result = preflightModelCandidate(model, base);
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.reasons, [
    "cached GGUF quantization does not match requested Q4_K_XL",
    "cached GGUF facts could not be read",
    "insufficient disk space: need 5.93 GB, have 1 GB",
  ]);
});

test("admission failures are persisted as invalid runs with a concrete reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-tier-admission-test-"));
  try {
    const path = join(dir, "run.json");
    const run = writeInvalidAdmissionRun(path, {
      model: { id: "gemma4-e4b-q4kxl", hf: "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL" },
      campaignId: "20260714T120000Z",
      targetTierGB: 8,
      reasons: ["cached GGUF quantization does not match requested Q4_K_XL"],
    });
    assert.equal(run.status, "invalid");
    assert.match(run.invalidReason, /cached GGUF quantization/);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tier configuration distinguishes target tier from physical host evidence", () => {
  assert.equal(resolveHostTier(8), 8);
  assert.equal(resolveHostTier(16), 16);
  assert.equal(resolveHostTier(24), 24);
  assert.equal(resolveHostTier(32), 32);
  const facts = { sizeGB: 3.93, kvBytesPerToken: 172032, maxContext: 131072 };
  const simulated = resolveTierConfiguration(8, 32, facts);
  const hardware = resolveTierConfiguration(32, 32, facts);
  assert.equal(simulated.evidenceMode, "simulated-tier");
  assert.equal(simulated.targetTierGB, 8);
  assert.equal(simulated.memoryBudgetGB, 8);
  assert.ok(simulated.servedContext < hardware.servedContext);
  assert.equal(hardware.evidenceMode, "hardware-tier");
});

test("runtime llama logs can be copied before teardown", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-tier-log-test-"));
  try {
    const source = join(dir, "server.log");
    const target = join(dir, "llamacpp.log");
    writeFileSync(source, "owned llama diagnostic\n", { mode: 0o600 });
    assert.equal(copyRuntimeLog(source, target), true);
    assert.equal(readFileSync(target, "utf8"), "owned llama diagnostic\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metric report keeps model-load and qualification windows separate", () => {
  const report = createMetricReport(
    { samples: [{ phase: "load" }], peakUsedRamBytes: 10 },
    { samples: [{ phase: "qualification" }], peakUsedRamBytes: 20 },
  );
  assert.deepEqual(report.load.samples, [{ phase: "load" }]);
  assert.deepEqual(report.qualification.samples, [{ phase: "qualification" }]);
  assert.equal(report.qualification.baseline.phase, "qualification");
});

test("ledger offsets and slices preserve the shared ledger and copy only appended rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-tier-ledger-test-"));
  try {
    const source = join(dir, "events.tsv");
    const target = join(dir, "result", "toolrepair-events.tsv");
    writeFileSync(source, "header\nold\n", { mode: 0o600 });
    const offsets = captureLedgerOffsets({ events: source, failures: join(dir, "missing.tsv") });
    appendFileSync(source, "new\n");
    const slice = sliceLedger(source, offsets.events, target);
    assert.equal(slice.startOffset, Buffer.byteLength("header\nold\n"));
    assert.equal(slice.endOffset, Buffer.byteLength("header\nold\nnew\n"));
    assert.equal(slice.rowsCopied, 1);
    assert.equal(readFileSync(target, "utf8"), "new\n");
    assert.equal(readFileSync(source, "utf8"), "header\nold\nnew\n");
    assert.equal(offsets.failures.offset, 0);
    assert.equal(offsets.failures.exists, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool quality keeps first-attempt validity separate from persistent failures", () => {
  const report = summarizeToolQuality({
    events: [
      { type: "tool_start", name: "recall" },
      { type: "tool_start", name: "remember" },
      { type: "tool_start", name: "remember" },
      { type: "tool_result", name: "recall", ok: true },
    ],
    toolRepairRows: ["2026-07-14T00:00:00.000Z\tmodel\tremember\tmissing\tcontent\ttext\t\t0"],
    toolFailureRows: [
      "2026-07-14T00:00:00.000Z\tmodel\tleak\t0\trecovered",
      "2026-07-14T00:00:01.000Z\tmodel\techo\t1\tpersisted",
    ],
    caseResults: [{ status: "pass" }, { status: "fail" }, { status: "invalid" }],
  });
  assert.equal(report.toolAttempts, 3);
  assert.equal(report.malformedFirstAttempts, 1);
  assert.equal(report.firstAttemptValidity, 2 / 3);
  assert.equal(report.persistentFailures, 1);
  assert.equal(report.completedCases, 2);
  assert.equal(report.persistentFailureRate, 1 / 2);
  assert.equal(report.toolExecutionSuccess, 1);
});

test("model readiness requires the exact active model", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ data: [{ id: "requested-model" }] }) };
  };
  await modelReady("http://127.0.0.1:1234", "requested-model", { fetchImpl });
  assert.deepEqual(calls, ["http://127.0.0.1:1234/health", "http://127.0.0.1:1234/v1/models"]);
});

test("teardown invokes every owned process cleanup even when one stop fails", async () => {
  const stopped = [];
  await teardownOwnedProcesses([
    { stop: async () => stopped.push("server") },
    { stop: async () => { stopped.push("worker"); throw new Error("worker stop failed"); } },
  ]);
  assert.deepEqual(stopped, ["server", "worker"]);
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
      assert.equal(error.caseResults[1].prompt, "second");
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

test("executeBenchmarkCases retries a failed case with restored state and a fresh session", async () => {
  const retryCase = {
    id: "retry-me", title: "Retry me", objective: "Recover once state and session are reset.",
    section: "chains", kind: "behavior", prompt: "retry", expectedToolSequence: ["remember"],
    requiredAnswerTerms: ["saved"], requireAllToolsSuccessful: true, hardGate: true,
    stateAssertion: { kind: "none" }, stateContract: {
      reset: "fresh-session", restore: "fixture-and-workspace", mutations: ["adds one source memory"],
    }, timeoutMs: 1_000,
  };
  const restored = [];
  const contexts = [];
  const recorded = [];
  const disposed = [];
  const snapshots = [];
  let attempts = 0;

  const results = await executeBenchmarkCases([retryCase], {
    context: { sessionId: "initial-session" },
    captureState: async caseDef => {
      snapshots.push(caseDef.id);
      return { database: "fixture-db-before-retry", workspace: "workspace-before-retry" };
    },
    runCase: async (caseDef, context) => {
      contexts.push(context);
      attempts++;
      return {
        durationMs: attempts * 10,
        events: attempts === 1
          ? [{ type: "turn_complete", status: "completed" }]
          : [
            { type: "tool_start", name: "remember" },
            { type: "tool_result", name: "remember", ok: true },
            { type: "stream_end", text: "saved" },
            { type: "turn_complete", status: "completed" },
          ],
      };
    },
    verifyCaseState: async () => true,
    restoreState: async (caseDef, snapshot) => restored.push([caseDef.id, snapshot]),
    createFreshContext: async (_caseDef, { attempt }) => ({ sessionId: `retry-session-${attempt}` }),
    disposeContext: async context => disposed.push(context.sessionId),
    recordEvents: (caseDef, events, meta) => recorded.push({ id: caseDef.id, events, meta }),
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "pass");
  assert.equal(results[0].retried, true);
  assert.equal(results[0].firstAttempt.status, "fail");
  assert.equal(results[0].retry.status, "pass");
  assert.deepEqual(snapshots, ["retry-me"]);
  assert.deepEqual(restored, [["retry-me", { database: "fixture-db-before-retry", workspace: "workspace-before-retry" }]]);
  assert.deepEqual(contexts.map(context => context.sessionId), ["initial-session", "retry-session-2"]);
  assert.deepEqual(recorded.map(item => item.meta.attempt), [1, 2]);
  assert.deepEqual(disposed, ["retry-session-2"]);
  assert.deepEqual(results[0].firstAttempt.actualToolSequence, []);
  assert.equal(results[0].firstAttempt.firstAttemptPass, false);
  assert.equal(results[0].firstAttempt.status, "fail");
});

test("restoreQualificationState enforces the fixture and workspace contract", async () => {
  const calls = [];
  await restoreQualificationState({
    caseDef: {
      id: "stateful-case",
      stateContract: { reset: "fresh-session", restore: "fixture-and-workspace", mutations: ["writes a file"] },
    },
    fixtureContract: {
      reset: { beforeRetry: "fresh-session", restore: "fixture-and-workspace" },
    },
    snapshot: { database: { memories: ["fixture"] }, workspace: { files: ["baseline"] } },
    restoreDatabase: async snapshot => calls.push(["database", snapshot]),
    restoreWorkspace: async snapshot => calls.push(["workspace", snapshot]),
  });
  assert.deepEqual(calls, [
    ["workspace", { files: ["baseline"] }],
    ["database", { memories: ["fixture"] }],
  ]);
});
